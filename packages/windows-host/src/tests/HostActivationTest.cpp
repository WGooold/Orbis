#include "../HostController.h"
#include "../CredentialStore.h"
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QJsonDocument>
#include <QJsonArray>
#include <QScopeGuard>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QtTest>
#ifdef Q_OS_MACOS
#include <Security/Security.h>
#endif

class HostActivationTest : public QObject {
    Q_OBJECT
    QTcpServer m_policy;
    bool m_mailConfigured = true;
    int m_policyRequests = 0;
    bool m_deferNextPolicy = false;
    QPointer<QTcpSocket> m_deferredPolicy;
    QString relayUrl() const { return "ws://127.0.0.1:" + QString::number(m_policy.serverPort()); }
    QJsonObject activation(const QString &email) const {
        return {{"hostId", "computer-one"}, {"email", email}, {"relayUrl", relayUrl()}, {"credential", "orbis_host_rejected"}};
    }
    static QByteArray contents(const QString &path) {
        QFile file(path);
        if (!file.open(QIODevice::ReadOnly)) return {};
        return file.readAll();
    }
    static void clearCredentials(const QString &directory) {
        QDirIterator files(directory, {"*.dat"}, QDir::Files, QDirIterator::Subdirectories);
        while (files.hasNext()) CredentialStore::clear(files.next());
    }
    static void switchRelay(HostController &controller, const QString &relay) {
        controller.saveSettings(relay, controller.autoStart(), controller.codexEnabled(), controller.hostName(),
            controller.dshEnabled(), controller.dshWebUrl(), controller.piIntegrationEnabled(), controller.claudeIntegrationEnabled());
    }
    static void authenticationBridge(const QString &root) {
        QDir().mkpath(root + "/packages/host/dist");
        QFile file(root + "/packages/host/dist/desktop-bridge.js");
        QVERIFY(file.open(QIODevice::WriteOnly));
        file.write(R"JS(
const fs = require("node:fs"), path = require("node:path");
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") return out({ id, error: "fixture initializes explicitly" });
  if (method === "start") {
    fs.appendFileSync(path.join(__dirname, "starts.jsonl"), JSON.stringify(params) + "\n");
    out({ event: "state", state: "connected" });
  }
  if (method === "stop") {
    if (fs.existsSync(path.join(__dirname, "delay-stops"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    // An old connection's refusal arrives immediately before the stop acknowledgement.
    if (fs.existsSync(path.join(__dirname, "reject-on-stop"))) {
      fs.unlinkSync(path.join(__dirname, "reject-on-stop"));
      out({ event: "state", state: "error", activationRequired: true });
    }
    out({ event: "state", state: "stopped" });
  }
  out({ id, result: method === "detect" ? [] : {} });
});
)JS");
    }
private slots:
    void initTestCase() {
#ifdef Q_OS_MACOS
        // Synthetic regression credentials must never request the developer's password.
        QVERIFY(SecKeychainSetUserInteractionAllowed(false) == errSecSuccess);
#endif
        QVERIFY(m_policy.listen(QHostAddress::LocalHost));
        connect(&m_policy, &QTcpServer::newConnection, this, [this] {
            while (auto *socket = m_policy.nextPendingConnection()) {
                connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
                connect(socket, &QTcpSocket::readyRead, socket, [this, socket] {
                    socket->readAll();
                    ++m_policyRequests;
                    if (m_deferNextPolicy) { m_deferNextPolicy = false; m_deferredPolicy = socket; return; }
                    const auto body = QJsonDocument(QJsonObject{{"enabled", true}, {"qqEmailVerificationRequired", false},
                        {"mailConfigured", m_mailConfigured}}).toJson(QJsonDocument::Compact);
                    socket->write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " +
                        QByteArray::number(body.size()) + "\r\n\r\n" + body);
                    socket->disconnectFromHost();
                });
            }
        });
    }
    void init() { m_mailConfigured = true; m_deferNextPolicy = false; m_deferredPolicy.clear(); }

    void claudeVersionStatusRecoversAfterUpgrade() {
        // CLAUDE-MODS-MIN-01: stale version failures must clear on refresh; the
        // native bridge still accepts the older installed-only status event.
        QTemporaryDir temp;
        HostController controller(temp.path() + "/missing-runtime", temp.path(), temp.path() + "/state", temp.path(), false);
        QCoreApplication::processEvents(); controller.m_tick.stop();
        controller.receiveLine({{"event", "claudeStatus"}, {"installed", true}, {"compatible", false},
            {"version", "2.1.286"}, {"minimumVersion", "2.1.287"}, {"error", "请升级 Claude Code"}});
        QVERIFY(controller.claudeInstalled()); QVERIFY(!controller.claudeCompatible());
        QCOMPARE(controller.claudeVersion(), QString("2.1.286"));
        QCOMPARE(controller.claudeMinimumVersion(), QString("2.1.287"));
        QVERIFY(!controller.claudeVersionError().isEmpty());
        controller.receiveLine({{"event", "claudeStatus"}, {"installed", true}, {"compatible", true},
            {"version", "2.1.287"}, {"minimumVersion", "2.1.287"}});
        QVERIFY(controller.claudeCompatible()); QVERIFY(controller.claudeVersionError().isEmpty());
        QCOMPARE(controller.claudeVersion(), QString("2.1.287"));
        controller.receiveLine({{"event", "claudeStatus"}, {"installed", true}});
        QVERIFY(controller.claudeInstalled()); QVERIFY(controller.claudeCompatible());
        QVERIFY(controller.claudeVersion().isEmpty()); QVERIFY(controller.claudeMinimumVersion().isEmpty());
        controller.receiveLine({{"event", "claudeStatus"}, {"installed", false}, {"compatible", false}, {"minimumVersion", "2.1.287"}});
        QVERIFY(!controller.claudeInstalled()); QVERIFY(!controller.claudeCompatible());
    }

    void rejectedActivationReturnsToRegistration_data() {
        QTest::addColumn<QString>("email");
        QTest::addColumn<QString>("format");
        for (const auto &email : {QString(), QString("owner@qq.com")}) {
            for (const auto &format : {QString("structured-state"), QString("legacy-state"), QString("legacy-start-error")}) {
                QTest::newRow(qPrintable((email.isEmpty() ? "direct-" : "verified-") + format)) << email << format;
            }
        }
    }
    void rejectedActivationReturnsToRegistration() {
        // HOST-ACT-01/03: the actual native reducer must reopen registration and persist
        // rejection across relaunch, preserving Host keys, pairing data and mailbox recovery.
        QFETCH(QString, email);
        QFETCH(QString, format);
        QTemporaryDir temp;
        const auto desktop = temp.path() + "/desktop";
        const auto state = temp.path() + "/state";
        QVERIFY(QDir().mkpath(desktop)); QVERIFY(QDir().mkpath(state));
        const auto path = desktop + "/activation.dat";
        const auto cleanup = qScopeGuard([&] { clearCredentials(temp.path()); });
        QString error;
        QVERIFY2(CredentialStore::save(path, activation(email), &error), qPrintable(error));
        for (const auto &name : {"host.json", "devices.json"}) {
            QFile file(state + "/" + name);
            QVERIFY(file.open(QIODevice::WriteOnly)); QVERIFY(file.write(name) > 0);
        }
        {
            // No bridge fixture is installed: these tests exercise only the native reducer.
            HostController controller(temp.path() + "/missing-runtime", desktop, state, desktop, false);
            QCoreApplication::processEvents();
            controller.m_tick.stop();
            QVERIFY(controller.activated());
            controller.m_desiredRunning = true;
            controller.m_qr = "old-pairing-window";
            const QString message = "Relay 认证失败：unauthorized Invalid runtime credential";
            if (format == "legacy-start-error") {
                controller.m_pending.insert(42, {}); controller.m_methods.insert(42, "start");
                controller.receiveLine({{"id", 42}, {"error", message}});
            } else {
                QJsonObject event{{"event", "state"}, {"state", "error"}, {"message", message}};
                if (format == "structured-state") { event.insert("message", "激活凭据已失效，请重新激活"); event.insert("activationRequired", true); }
                controller.receiveLine(event);
            }
            QVERIFY(!controller.activated()); QVERIFY(!controller.desiredRunning());
            QVERIFY(controller.qr().isEmpty());
            QTRY_VERIFY(!controller.busy());
            QTRY_VERIFY(controller.registrationAvailable());
            QCOMPARE(controller.verificationRequired(), !email.isEmpty());
            const auto stored = CredentialStore::load(path, &error);
            QVERIFY(!stored.contains("credential"));
            QCOMPARE(stored.value("email").toString(), email);
            QCOMPARE(stored.value("hostId").toString(), QString("computer-one"));
            QCOMPARE(stored.value("relayUrl").toString(), relayUrl());
        }
        QCOMPARE(contents(state + "/host.json"), QByteArray("host.json"));
        QCOMPARE(contents(state + "/devices.json"), QByteArray("devices.json"));
        {
            HostController relaunched(temp.path() + "/missing-runtime", desktop, state, desktop, false);
            QCoreApplication::processEvents(); relaunched.m_tick.stop();
            QVERIFY(!relaunched.activated());
            QCOMPARE(relaunched.email(), email);
            relaunched.refreshRegistrationPolicy();
            QTRY_VERIFY(relaunched.registrationAvailable());
            QCOMPARE(relaunched.verificationRequired(), !email.isEmpty());
            auto replacement = activation(email); replacement.insert("credential", "orbis_host_replacement");
            relaunched.saveActivation(replacement, "已激活");
            QTRY_VERIFY(!relaunched.busy());
            QVERIFY(relaunched.activated());
            QCOMPARE(CredentialStore::load(path).value("credential").toString(), QString("orbis_host_replacement"));
        }
        QVERIFY(CredentialStore::clear(path));
    }

    void unrelatedFailuresKeepActivation_data() {
        QTest::addColumn<QString>("message");
        QTest::newRow("network") << "Relay authentication timed out";
        QTest::newRow("protocol-version") << "Host 与 Relay 的协议版本不兼容，请将 Orbis Host 和 Relay 更新到最新版本后重试。";
        QTest::newRow("administrator-disabled") << "Relay 认证失败：host_disabled This Host has been disabled by an administrator";
        QTest::newRow("forwarding") << "中继回绝了转发：unauthorized Invalid runtime credential";
    }
    void unrelatedFailuresKeepActivation() {
        // HOST-ACT-04: an unavailable service or an administrator's block is not lost activation.
        QFETCH(QString, message);
        QTemporaryDir temp;
        const auto path = temp.path() + "/activation.dat";
        const auto cleanup = qScopeGuard([&] { clearCredentials(temp.path()); });
        const auto original = activation("owner@qq.com");
        QVERIFY(CredentialStore::save(path, original));
        HostController controller(temp.path() + "/missing-runtime", temp.path(), temp.path() + "/state", temp.path(), false);
        QCoreApplication::processEvents(); controller.m_tick.stop();
        controller.receiveLine({{"event", "state"}, {"state", "error"}, {"message", message}});
        QVERIFY(controller.activated());
        QCOMPARE(CredentialStore::load(path), original);
        QVERIFY(CredentialStore::clear(path));
    }

    void verifiedRecoveryRespectsMailAvailability() {
        // A Relay allowing direct registration still needs working mail to rotate a verified Host.
        m_mailConfigured = false;
        QTemporaryDir temp;
        const auto path = temp.path() + "/activation.dat";
        const auto cleanup = qScopeGuard([&] { clearCredentials(temp.path()); });
        QVERIFY(CredentialStore::save(path, activation("owner@qq.com")));
        HostController controller(temp.path() + "/missing-runtime", temp.path(), temp.path() + "/state", temp.path(), false);
        QCoreApplication::processEvents(); controller.m_tick.stop();
        controller.receiveLine({{"event", "state"}, {"state", "error"}, {"activationRequired", true}});
        const auto requests = m_policyRequests;
        QTRY_VERIFY(!controller.busy());
        QTRY_VERIFY(m_policyRequests > requests);
        QTRY_VERIFY(controller.verificationRequired());
        QVERIFY(!controller.registrationAvailable());
        QVERIFY(CredentialStore::clear(path));
    }

    void reinstallKeepsTheSharedUserCredential() {
        // HOST-ACT-05: switching between installed/portable desktop settings must use
        // the same per-user credential and endpoint instead of registering the Host twice.
        QTemporaryDir temp;
        const auto shared = temp.path() + "/shared";
        QVERIFY(QDir().mkpath(shared));
        const auto path = shared + "/activation.dat";
        const auto cleanup = qScopeGuard([&] { CredentialStore::clear(path); });
        QVERIFY(CredentialStore::save(path, activation("owner@qq.com")));
        for (const auto &location : {"installed", "reinstalled", "portable"}) {
            HostController controller(temp.path() + "/missing-runtime", temp.path() + "/" + location,
                temp.path() + "/state", shared, false);
            QCoreApplication::processEvents(); controller.m_tick.stop();
            QVERIFY(controller.activated());
            QCOMPARE(controller.email(), QString("owner@qq.com"));
            QCOMPARE(controller.hostId(), QString("computer-one"));
            QCOMPARE(controller.relayUrl(), relayUrl());
        }
        QVERIFY(CredentialStore::clear(path));
    }

    void existingRegistrationSelectsItsRecoveryPath_data() {
        QTest::addColumn<QString>("recovery");
        QTest::newRow("verified-mailbox") << "email";
        QTest::newRow("direct-without-mailbox") << "administrator";
        QTest::newRow("older-relay") << "";
    }
    void existingRegistrationSelectsItsRecoveryPath() {
        // HOST-ACT-06: a fresh desktop settings directory with an existing server-side
        // Host must offer mailbox recovery or identify the Host for an operator reset.
        QFETCH(QString, recovery);
        QTemporaryDir temp;
        HostController controller(temp.path() + "/missing-runtime", temp.path(), temp.path() + "/state", temp.path(), false);
        QCoreApplication::processEvents(); controller.m_tick.stop();
        controller.m_settings.setValue("relayUrl", relayUrl());
        controller.m_hostId = "computer-one";
        controller.m_verificationRequired = false;
        controller.handleRegistrationError({{"error", "host_already_registered"}, {"recovery", recovery}});
        QVERIFY(!controller.activated());
        if (recovery == "administrator") {
            QVERIFY(!controller.verificationRequired());
            QVERIFY(controller.message().contains("管理员"));
            QVERIFY(controller.message().contains("computer-one"));
        } else {
            const auto requests = m_policyRequests;
            QTRY_VERIFY(m_policyRequests > requests);
            QTRY_VERIFY(controller.registrationAvailable());
            QVERIFY(controller.verificationRequired());
            QVERIFY(controller.message().contains("原 QQ 邮箱"));
        }
    }

    void relaySwitchKeepsIndependentActivation_data() {
        QTest::addColumn<QString>("email");
        QTest::newRow("direct") << "";
        QTest::newRow("verified") << "owner@qq.com";
    }
    void relaySwitchKeepsIndependentActivation() {
        // HOST-ACT-08/09: A -> new B -> A -> B, relaunch, then reject B. Neither
        // switching nor recovery may rotate A, lose its mailbox, or change phone trust.
        QFETCH(QString, email);
        QTemporaryDir temp;
        const auto cleanup = qScopeGuard([&] { clearCredentials(temp.path()); });
        const auto path = temp.path() + "/activation.dat";
        const auto relayA = relayUrl(), relayB = relayUrl() + "/other";
        auto a = activation(email);
        auto b = a; b.insert("relayUrl", relayB); b.insert("credential", "orbis_host_second");
        if (!email.isEmpty()) b.insert("email", "second@qq.com");
        QVERIFY(CredentialStore::save(path, a));
        QFile devices(temp.path() + "/devices.json");
        QVERIFY(devices.open(QIODevice::WriteOnly)); devices.write("phone-trust"); devices.close();
        {
            HostController controller(temp.path() + "/missing-runtime", temp.path(), temp.path(), temp.path(), false);
            QCoreApplication::processEvents(); controller.m_tick.stop();
            controller.m_qr = "old-qr"; controller.m_challenge = "old-code"; controller.m_cooldown = 60;
            switchRelay(controller, relayB);
            QTRY_VERIFY(!controller.busy());
            QCOMPARE(controller.relayUrl(), relayB);
            QVERIFY(!controller.activated()); QVERIFY(controller.email().isEmpty());
            QVERIFY(controller.qr().isEmpty()); QVERIFY(controller.m_challenge.isEmpty()); QCOMPARE(controller.m_cooldown, 0);
            QCOMPARE(controller.hostId(), QString("computer-one"));
            controller.saveActivation(b, "已激活");
            QTRY_VERIFY(!controller.busy());
            QCOMPARE(controller.m_credential, b.value("credential").toString());
            switchRelay(controller, relayA + "/");
            QTRY_VERIFY(!controller.busy());
            QCOMPARE(controller.relayUrl(), relayA);
            QCOMPARE(controller.m_credential, a.value("credential").toString());
            QCOMPARE(controller.email(), email);
            QCOMPARE(CredentialStore::load(path), a);
        }
        {
            HostController relaunched(temp.path() + "/missing-runtime", temp.path(), temp.path(), temp.path(), false);
            QCoreApplication::processEvents(); relaunched.m_tick.stop();
            QCOMPARE(relaunched.m_credential, a.value("credential").toString());
            switchRelay(relaunched, relayB); QTRY_VERIFY(!relaunched.busy());
            QCOMPARE(relaunched.m_credential, b.value("credential").toString());
            relaunched.receiveLine({{"event", "state"}, {"state", "error"}, {"activationRequired", true}});
            QTRY_VERIFY(!relaunched.busy()); QVERIFY(!relaunched.activated());
            switchRelay(relaunched, relayA); QTRY_VERIFY(!relaunched.busy());
            QCOMPARE(relaunched.m_credential, a.value("credential").toString());
            switchRelay(relaunched, relayB); QTRY_VERIFY(!relaunched.busy());
            QVERIFY(!relaunched.activated()); QCOMPARE(relaunched.email(), b.value("email").toString());
            QVERIFY(!CredentialStore::load(path).contains("credential"));
        }
        QCOMPARE(contents(temp.path() + "/devices.json"), QByteArray("phone-trust"));
    }

    void failedRelayArchiveKeepsCurrentActivation() {
        // HOST-ACT-10: a failed archive must leave both the current endpoint and
        // its usable credential intact; never silently lose it while changing settings.
        QTemporaryDir temp;
        const auto cleanup = qScopeGuard([&] { clearCredentials(temp.path()); });
        const auto path = temp.path() + "/activation.dat";
        const auto a = activation("owner@qq.com");
        QVERIFY(CredentialStore::save(path, a));
        QFile blocker(temp.path() + "/relay-activations");
        QVERIFY(blocker.open(QIODevice::WriteOnly)); blocker.close();
        HostController controller(temp.path() + "/missing-runtime", temp.path(), temp.path(), temp.path(), false);
        QCoreApplication::processEvents(); controller.m_tick.stop();
        switchRelay(controller, relayUrl() + "/other"); QTRY_VERIFY(!controller.busy());
        QCOMPARE(controller.relayUrl(), relayUrl()); QVERIFY(controller.activated());
        QCOMPARE(CredentialStore::load(path), a);
        QVERIFY(controller.message().contains("无法保存"));
    }

    void activationSelectionHonorsHostIdentityAndLegacyWrites() {
        // HOST-ACT-11: restoring a different Host ID cannot borrow credentials.
        // A released client may rotate the active slot; its newest value must win
        // over an older archived copy when the current client is used again.
        QTemporaryDir temp;
        const auto cleanup = qScopeGuard([&] { clearCredentials(temp.path()); });
        const auto path = temp.path() + "/activation.dat";
        const auto a = activation("owner@qq.com");
        const auto relayB = relayUrl() + "/other";
        QVERIFY(CredentialStore::save(path, a));
        QString error;
        QVERIFY(!CredentialStore::selectActivation(path, relayB, "computer-one", &error).contains("credential"));
        QVERIFY(error.isEmpty());
        QCOMPARE(CredentialStore::selectActivation(path, relayUrl(), "computer-one", &error), a);
        QVERIFY(!CredentialStore::selectActivation(path, relayUrl(), "computer-two", &error).contains("credential"));
        QVERIFY(error.isEmpty());
        QCOMPARE(CredentialStore::selectActivation(path, relayUrl(), "computer-one", &error), a);
        auto rotated = a; rotated.insert("credential", "orbis_host_rotated_by_legacy_client");
        QVERIFY(CredentialStore::save(path, rotated));
        CredentialStore::selectActivation(path, relayB, "computer-one", &error); QVERIFY(error.isEmpty());
        QCOMPARE(CredentialStore::selectActivation(path, relayUrl(), "computer-one", &error), rotated);
        QCOMPARE(CredentialStore::normalizedRelay(" wss://EXAMPLE.com:443/relay/// "), QString("wss://example.com/relay"));
    }

    void switchingDrainsOldAuthenticationBeforeRestoringTarget() {
        // HOST-ACT-12: real native/bridge queue ordering, including asynchronous
        // credential invalidation. A late refusal for A must never erase B's key.
        QTemporaryDir temp;
        const auto cleanup = qScopeGuard([&] { clearCredentials(temp.path()); });
        authenticationBridge(temp.path());
        const auto path = temp.path() + "/activation.dat";
        const auto relayA = relayUrl(), relayB = relayUrl() + "/other";
        auto a = activation("owner@qq.com"), b = a;
        b.insert("relayUrl", relayB); b.insert("credential", "orbis_host_second");
        QVERIFY(CredentialStore::save(path, b));
        QString error;
        CredentialStore::selectActivation(path, relayA, "computer-one", &error); QVERIFY(error.isEmpty());
        QVERIFY(CredentialStore::save(path, a));
        HostController controller(temp.path(), temp.path(), temp.path(), temp.path(), false);
        QTRY_VERIFY(controller.m_nextId > 1 && !controller.busy()); controller.m_tick.stop();
        controller.m_bridgeReady = true; controller.startHost();
        QTRY_COMPARE(controller.state(), QString("connected")); QTRY_VERIFY(!controller.busy());
        QFile reject(temp.path() + "/packages/host/dist/reject-on-stop");
        QVERIFY(reject.open(QIODevice::WriteOnly)); reject.close();
        switchRelay(controller, relayB);
        QTRY_VERIFY(!controller.busy() && !controller.resumePending());
        QCOMPARE(controller.relayUrl(), relayB); QCOMPARE(controller.state(), QString("connected"));
        QCOMPARE(controller.m_credential, b.value("credential").toString());
        const auto starts = contents(temp.path() + "/packages/host/dist/starts.jsonl").trimmed().split('\n');
        QCOMPARE(starts.size(), 2);
        const auto last = QJsonDocument::fromJson(starts.last()).object();
        QCOMPARE(last.value("relayUrl").toString(), relayB);
        QCOMPARE(last.value("credential").toString(), b.value("credential").toString());
        switchRelay(controller, relayA); QTRY_VERIFY(!controller.busy() && !controller.resumePending());
        QVERIFY(!controller.activated()); QVERIFY(!controller.desiredRunning());
        QCOMPARE(controller.email(), QString("owner@qq.com"));
        QCOMPARE(contents(temp.path() + "/packages/host/dist/starts.jsonl").trimmed().split('\n').size(), 2);
    }

    void previousVisitPolicyCannotOverwriteCurrentRelayState() {
        // HOST-ACT-12: even A -> B -> A must ignore a delayed policy response from
        // the first visit, rather than showing a stale registration requirement.
        QTemporaryDir temp;
        const auto cleanup = qScopeGuard([&] { clearCredentials(temp.path()); });
        QVERIFY(CredentialStore::save(temp.path() + "/activation.dat", activation("")));
        HostController controller(temp.path() + "/missing-runtime", temp.path(), temp.path(), temp.path(), false);
        QCoreApplication::processEvents(); controller.m_tick.stop();
        m_deferNextPolicy = true; controller.refreshRegistrationPolicy();
        QTRY_VERIFY(m_deferredPolicy);
        switchRelay(controller, relayUrl() + "/other"); QTRY_VERIFY(!controller.busy());
        switchRelay(controller, relayUrl()); QTRY_VERIFY(!controller.busy());
        QTRY_VERIFY(controller.registrationAvailable() && !controller.verificationRequired());
        const auto body = QJsonDocument(QJsonObject{{"enabled", true}, {"qqEmailVerificationRequired", true}, {"mailConfigured", true}}).toJson(QJsonDocument::Compact);
        m_deferredPolicy->write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " +
            QByteArray::number(body.size()) + "\r\n\r\n" + body);
        m_deferredPolicy->disconnectFromHost();
        QTRY_VERIFY(!m_deferredPolicy);
        QTest::qWait(30);
        QVERIFY(!controller.verificationRequired()); QVERIFY(controller.activated());
    }

    void pauseDuringRelaySelectionKeepsSettingsAndStaysPaused() {
        // HOST-ACT-12: an explicit pause during storage I/O cancels auto-resume,
        // but must not drop the other settings submitted with the Relay change.
        QTemporaryDir temp;
        const auto cleanup = qScopeGuard([&] { clearCredentials(temp.path()); });
        authenticationBridge(temp.path());
        const auto path = temp.path() + "/activation.dat", relayB = relayUrl() + "/other";
        auto a = activation("owner@qq.com"), b = a; b.insert("relayUrl", relayB);
        QVERIFY(CredentialStore::save(path, b));
        QString error; CredentialStore::selectActivation(path, relayUrl(), "computer-one", &error); QVERIFY(error.isEmpty());
        QVERIFY(CredentialStore::save(path, a));
        HostController controller(temp.path(), temp.path(), temp.path(), temp.path(), false);
        QTRY_VERIFY(controller.m_nextId > 1 && !controller.busy()); controller.m_tick.stop();
        controller.m_bridgeReady = true; controller.startHost();
        QTRY_COMPARE(controller.state(), QString("connected")); QTRY_VERIFY(!controller.busy());
        QFile slow(temp.path() + "/packages/host/dist/delay-stops"); QVERIFY(slow.open(QIODevice::WriteOnly)); slow.close();
        const bool codex = !controller.codexEnabled();
        controller.saveSettings(relayB, controller.autoStart(), codex, controller.hostName(), controller.dshEnabled(),
            controller.dshWebUrl(), controller.piIntegrationEnabled(), controller.claudeIntegrationEnabled());
        controller.stopHost();
        QTRY_VERIFY(!controller.busy() && !controller.resumePending());
        QCOMPARE(controller.relayUrl(), relayB); QCOMPARE(controller.codexEnabled(), codex);
        QVERIFY(controller.activated()); QVERIFY(!controller.desiredRunning()); QCOMPARE(controller.state(), QString("stopped"));
        QCOMPARE(contents(temp.path() + "/packages/host/dist/starts.jsonl").trimmed().split('\n').size(), 1);
    }
};
QTEST_GUILESS_MAIN(HostActivationTest)
#include "HostActivationTest.moc"
