#include "../HostController.h"
#include "../CredentialStore.h"
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QScopeGuard>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QtTest>

class HostActivationTest : public QObject {
    Q_OBJECT
    QTcpServer m_policy;
    bool m_mailConfigured = true;
    int m_policyRequests = 0;
    QString relayUrl() const { return "ws://127.0.0.1:" + QString::number(m_policy.serverPort()); }
    QJsonObject activation(const QString &email) const {
        return {{"hostId", "computer-one"}, {"email", email}, {"relayUrl", relayUrl()}, {"credential", "orbis_host_rejected"}};
    }
    static QByteArray contents(const QString &path) {
        QFile file(path);
        if (!file.open(QIODevice::ReadOnly)) return {};
        return file.readAll();
    }
private slots:
    void initTestCase() {
        QVERIFY(m_policy.listen(QHostAddress::LocalHost));
        connect(&m_policy, &QTcpServer::newConnection, this, [this] {
            while (auto *socket = m_policy.nextPendingConnection()) {
                connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
                connect(socket, &QTcpSocket::readyRead, socket, [this, socket] {
                    socket->readAll();
                    ++m_policyRequests;
                    const auto body = QJsonDocument(QJsonObject{{"enabled", true}, {"qqEmailVerificationRequired", false},
                        {"mailConfigured", m_mailConfigured}}).toJson(QJsonDocument::Compact);
                    socket->write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " +
                        QByteArray::number(body.size()) + "\r\n\r\n" + body);
                    socket->disconnectFromHost();
                });
            }
        });
    }
    void init() { m_mailConfigured = true; }

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
        const auto cleanup = qScopeGuard([&] { CredentialStore::clear(path); });
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
        const auto cleanup = qScopeGuard([&] { CredentialStore::clear(path); });
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
        const auto cleanup = qScopeGuard([&] { CredentialStore::clear(path); });
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
};
QTEST_GUILESS_MAIN(HostActivationTest)
#include "HostActivationTest.moc"
