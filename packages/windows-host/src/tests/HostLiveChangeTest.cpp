#include "../HostController.h"
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSemaphore>
#include <QSettings>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QtTest>
#include <atomic>
#include <memory>

// HOST-LIVE-01 / HOST-GUIDE-01: a running Host applies settings, Agent installs and DSH restarts by
// pausing itself and resuming afterwards; paused Hosts report no reachable phones or sessions.
class HostLiveChangeTest : public QObject {
    Q_OBJECT
    // A bridge stand-in that answers in queue order and records each method. It refuses
    // `initialize`, so the controller never reaches the network-facing startup work.
    static void bridge(const QString &root) {
        QDir().mkpath(root + "/packages/host/dist");
        QFile file(root + "/packages/host/dist/desktop-bridge.js");
        QVERIFY(file.open(QIODevice::WriteOnly));
        file.write(R"JS(
const fs = require("node:fs"), path = require("node:path");
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params } = JSON.parse(line);
  fs.appendFileSync(path.join(__dirname, "methods.log"), method + "\n");
  const failing = path.join(__dirname, "fail-" + method);
  if (method === "initialize") return out({ id, error: "fixture bridge stays uninitialized" });
  if (fs.existsSync(failing)) return out({ id, error: method + " failed in fixture" });
  if (method === "start") fs.writeFileSync(path.join(__dirname, "start.json"), JSON.stringify(params));
  if (method === "start") { out({ event: "state", state: "connecting" }); out({ event: "state", state: "connected" }); }
  if (method === "stop") out({ event: "state", state: "stopped" });
  if (method.startsWith("agent.enablement.write")) {
    fs.writeFileSync(path.join(__dirname, method + ".json"), JSON.stringify(params));
    if (fs.existsSync(path.join(__dirname, "hold-agent-write"))) return;
    const kinds = params.kinds ?? [params.kind];
    const snapshot = { revision: params.expectedRevision + 1, agents: kinds.map(kind => ({ kind, label: kind, enabled: params.enabled })) };
    if (method === "agent.enablement.writeBatch" && !params.enabled && !params.reviews) {
      const reviews = kinds.slice(0, 2).map((kind, index) => ({ kind, revision: params.expectedRevision, token: String(index).repeat(64), sessions: [kind + " work"], total: 1 }));
      return out({ id, result: { status: "review", reviews } });
    }
    return out({ id, result: { status: "applied", snapshot } });
  }
  if (method === "agy.setup.verify") return out({ id, result: { verification: !params.key || /^fixture-valid-/.test(params.key) ? "verified" : "rejected" } });
  if (method === "agy.setup.apply") return out({ id, result: { source: params.key ? "saved" : "none", installed: true, requiredVersion: "1.5.17" } });
  if (method === "agy.setup.retry") return out({ id, result: { source: "saved", verification: "rejected" } });
  if (method === "openclaw.save") return out({ id, result: { source: "file", url: params.url, hasToken: !!params.token, access: params.access ?? "auto" } });
  if (method === "openclaw.config.read") return out({ id, result: { ticket: "fixture", fields: [{ key: "workspace", editable: true, value: "/fixture" }] } });
  if (method === "openclaw.config.apply") {
    fs.writeFileSync(path.join(__dirname, method + ".json"), JSON.stringify(params));
    return out({ id, result: { state: "saved", restarting: true } });
  }
  if (method === "hermes.remote.save") return out({ id, result: { source: "file", host: params.host, port: params.port, profile: params.profile } });
  if (method === "selectAgentEntry") return out({ id, result: { entry: params.entry, version: "2.1.322" } });
  if (method === "detect") return out({ id, result: [] });
  if (method === "updateAgent") return out({ id, result: { entry: "/fixture/pi", version: "9.9.9" } });
  out({ id, result: {} });
});
)JS");
    }
    static QStringList methods(const QString &root, bool includeDetect = false) {
        QFile file(root + "/packages/host/dist/methods.log");
        if (!file.open(QIODevice::ReadOnly)) return {};
        QStringList result;
        for (const auto &line : QString::fromUtf8(file.readAll()).split('\n', Qt::SkipEmptyParts)) if (includeDetect || line != "detect") result.append(line);
        return result;
    }
    static void clearMethods(const QString &root) { QFile::remove(root + "/packages/host/dist/methods.log"); }
    // Connected Host with the fixture bridge; detection requests are ignored by `methods`.
    static void connectHost(HostController &host, const QString &root) {
        QTRY_VERIFY_WITH_TIMEOUT(methods(root).contains("initialize"), 10000);
        QTRY_VERIFY(!host.busy());
        host.m_tick.stop();
        host.m_bridgeReady = true; host.m_credential = "orbis_host_fixture"; host.m_hostName = "fixture";
        host.startHost();
        QTRY_COMPARE(host.state(), QString("connected"));
        QTRY_VERIFY(!host.busy());
        clearMethods(root);
    }
    static void settle(HostController &host) {
        QTRY_VERIFY_WITH_TIMEOUT(!host.busy() && !host.resumePending(), 10000);
    }
    std::unique_ptr<QTemporaryDir> m_root;
    std::unique_ptr<HostController> m_host;
    QString root() const { return m_root->path(); }
private slots:
    void init() {
        QVERIFY(!QStandardPaths::findExecutable("node").isEmpty());
        m_root = std::make_unique<QTemporaryDir>();
        QVERIFY(m_root->isValid());
        bridge(root());
        m_host = std::make_unique<HostController>(root(), root() + "/desktop", root() + "/state", root() + "/desktop", false);
        m_host->m_settings.setValue("relayUrl", "ws://127.0.0.1:1");
    }
    void cleanup() { m_host.reset(); m_root.reset(); }

    // AGY-15: the secure-vault boundary must commit the verified candidate before the private
    // bridge receives it. A failed replacement leaves the old connection and key alone.
    void managesLocalAgyCredentialWithoutRestartingHost() {
        auto &host = *m_host;
        connectHost(host, root());
        auto saved = std::make_shared<QString>();
        auto failWrite = std::make_shared<std::atomic_bool>(false);
        host.m_agyVaultPath = root() + "/state/antigravity-api-key.dat";
        host.m_agyVaultForTest = [saved, failWrite](HostController::AgyVaultAction action, const QString &, const QString &key) -> std::optional<QString> {
            if (action == HostController::AgyVaultAction::Save) {
                if (failWrite->load()) return std::nullopt;
                *saved = key;
            } else if (action == HostController::AgyVaultAction::Remove) saved->clear();
            return *saved;
        };
        const auto verification = [&host] { return host.agySetup().value("verification").toString(); };
        const auto source = [&host] { return host.agySetup().value("source").toString(); };
        const QString first = "fixture-valid-first", next = "fixture-valid-rotation";
        host.finishAgySetup({{"source", "none"}, {"installed", true}});
        host.saveAgyCredential("fixture-rejected-key");
        QTRY_COMPARE(verification(), QString("candidateRejected"));
        QCOMPARE(methods(root()), QStringList({"agy.setup.verify"}));
        QCOMPARE(source(), QString("none"));
        host.saveAgyCredential(first);
        QVERIFY(!host.busy());
        for (const auto &request : std::as_const(host.m_requestParams)) QVERIFY(!request.contains("key"));
        QTRY_COMPARE(source(), QString("saved"));
        QCOMPARE(verification(), QString("verified"));
        QCOMPARE(*saved, first);
        QVERIFY(!QJsonDocument(QJsonObject::fromVariantMap(host.agySetup())).toJson().contains(first.toLatin1()));

        failWrite->store(true);
        host.saveAgyCredential(next);
        QTRY_COMPARE(verification(), QString("vaultError"));
        QCOMPARE(*saved, first);
        QCOMPARE(methods(root()).count("agy.setup.apply"), 1);
        failWrite->store(false);
        host.retryAgySetup();
        QTRY_COMPARE(verification(), QString("rejected"));
        host.saveAgyCredential(next);
        QTRY_COMPARE(verification(), QString("verified"));
        QCOMPARE(*saved, next);

        // A fresh bridge's initialization brings back only status; the same vault
        // reload path then restores the saved key without the user entering it again.
        host.finishAgySetup({{"source", "none"}});
        host.loadAgyCredential();
        QTRY_COMPARE(source(), QString("saved"));
        host.removeAgyCredential();
        QTRY_COMPARE(source(), QString("none"));
        QCOMPARE(verification(), QString("removed"));
        QVERIFY(saved->isEmpty());
        QCOMPARE(methods(root()).count("agy.setup.apply"), 4);
        QVERIFY(!methods(root()).contains("stop"));
        QCOMPARE(host.state(), QString("connected"));
    }

    // HOST-CLI-DISCOVERY-01: a rejected path keeps the previous choice; a
    // successful path/reset survives the pause → change → resume boundary.
    void manualEntryIsSavedOnlyOnVerifiedReply() {
        auto &host = *m_host;
        connectHost(host, root());
        QSignalSpy result(&host, &HostController::agentEntryFinished);
        host.selectAgentEntry("codex", "/fixture/custom cli/codex");
        settle(host);
        QCOMPARE(methods(root()), QStringList({"stop", "selectAgentEntry", "start"}));
        QCOMPARE(host.agentEntryOverrides().value("codex").toString(), QString("/fixture/custom cli/codex"));
        QCOMPARE(result.count(), 1);
        QVERIFY(result.first().at(1).toString().isEmpty());
        const auto overrides = host.agentSettings().value("agentEntryOverrides").toObject();
        QCOMPARE(overrides.value("codex").toString(), QString("/fixture/custom cli/codex"));
        QFile marker(root() + "/packages/host/dist/fail-selectAgentEntry");
        QVERIFY(marker.open(QIODevice::WriteOnly)); marker.close();
        host.selectAgentEntry("codex", "/fixture/broken");
        settle(host);
        QCOMPARE(result.count(), 2);
        QCOMPARE(result.last().at(0).toString(), QString("codex"));
        QVERIFY(result.last().at(1).toString().contains("failed"));
        QCOMPARE(host.agentEntryOverrides().value("codex").toString(), QString("/fixture/custom cli/codex"));
        QVERIFY(marker.remove());
        host.selectAgentEntry("codex", "");
        settle(host);
        QVERIFY(host.agentEntryOverrides().value("codex").toString().isEmpty());
        QVERIFY(host.desiredRunning());
    }

    // HOST-AGENT-06: only the Host's snapshot changes the desktop toggle; a local edit
    // does not pause Host and delayed snapshots cannot undo edits from a paired device.
    void agentEnablementUsesHostAuthorityWithoutReconnect() {
        auto &host = *m_host;
        connectHost(host, root());
        const auto deliver = [&host](int revision, bool enabled) {
            host.receiveLine({{"event", "agentEnablement"}, {"snapshot", QJsonObject{
                {"revision", revision}, {"agents", QJsonArray{QJsonObject{{"kind", "openclaw"}, {"enabled", enabled}}}}
            }}});
        };
        const auto enabled = [&host]() { return host.agentEnablement().value("agents").toList().first().toMap().value("enabled").toBool(); };
        deliver(0, false);
        settle(host);
        host.setAgentEnabled("openclaw", true);
        QVERIFY(!enabled());
        QTRY_VERIFY(enabled());
        QTRY_VERIFY(!host.activityKinds().contains("agents"));
        QCOMPARE(methods(root()), QStringList({"agent.enablement.write"}));
        QCOMPARE(methods(root(), true), QStringList({"detect", "agent.enablement.write", "detect"}));
        QCOMPARE(host.state(), QString("connected"));
        deliver(2, false);
        deliver(1, true);
        settle(host);
        QVERIFY(!enabled());
        QCOMPARE(host.agentEnablement().value("revision").toInt(), 2);
    }

    // AGENT-DIAL-01: one review can cover active and idle rows; confirm resends exactly the reviewed batch.
    void batchAgentReviewKeepsOneSelectionAndRevision() {
        auto &host = *m_host;
        connectHost(host, root());
        const QStringList kinds{"pi", "codex", "claude"};
        QJsonArray rows;
        for (const auto &kind : kinds) rows.append(QJsonObject{{"kind", kind}, {"label", kind}, {"enabled", true}});
        host.applyAgentEnablement({{"revision", 1}, {"agents", rows}});
        QSignalSpy review(&host, &HostController::agentReviewsRequested);
        host.setAgentsEnabled(kinds, false);
        QTRY_COMPARE(review.size(), 1);
        QCOMPARE(review.first().at(0).toStringList(), kinds);
        QCOMPARE(review.first().at(1).toList().size(), 2);
        QCOMPARE(host.agentEnablement().value("revision").toInt(), 1);
        QVERIFY(host.agentChanges().isEmpty());
        host.confirmAgentReviews();
        QTRY_COMPARE(host.agentEnablement().value("revision").toInt(), 2);
        for (const auto &row : host.agentEnablement().value("agents").toList()) QVERIFY(!row.toMap().value("enabled").toBool());
        QCOMPARE(methods(root()), QStringList({"agent.enablement.writeBatch", "agent.enablement.writeBatch"}));
        QFile last(root() + "/packages/host/dist/agent.enablement.writeBatch.json");
        QVERIFY(last.open(QIODevice::ReadOnly));
        const auto request = QJsonDocument::fromJson(last.readAll()).object();
        QCOMPARE(request.value("expectedRevision").toInt(), 1);
        QCOMPARE(request.value("kinds").toArray(), QJsonArray::fromStringList(kinds));
        QCOMPARE(request.value("reviews").toObject().size(), 2);
        QVERIFY(!request.contains("confirmDisable"));
    }

    // AGENT-DIAL-01: the local receipt, not the broadcast, moves our latch; intervening edits void stale approval.
    void agentBroadcastAndStaleReviewDoNotReplay() {
        auto &host = *m_host;
        connectHost(host, root());
        const auto snapshot = [](int revision, bool pi, bool codex) {
            return QJsonObject{{"revision", revision}, {"agents", QJsonArray{QJsonObject{{"kind", "pi"}, {"enabled", pi}}, QJsonObject{{"kind", "codex"}, {"enabled", codex}}}}};
        };
        host.applyAgentEnablement(snapshot(1, true, true));
        QFile held(root() + "/packages/host/dist/hold-agent-write");
        QVERIFY(held.open(QIODevice::WriteOnly)); held.close();
        host.setAgentEnabled("pi", false);
        QTRY_VERIFY(methods(root()).contains("agent.enablement.write"));
        const auto id = host.m_agentWriteId;
        host.receiveLine({{"event", "agentEnablement"}, {"snapshot", snapshot(2, false, true)}});
        QCOMPARE(host.agentEnablement().value("revision").toInt(), 2);
        QCOMPARE(host.agentChanges().value("pi").toMap().value("previous").toBool(), true);
        host.receiveLine({{"id", id}, {"result", QJsonObject{{"status", "applied"}, {"snapshot", snapshot(2, false, true)}}}});
        QVERIFY(host.agentChanges().isEmpty());
        QSignalSpy review(&host, &HostController::agentReviewsRequested);
        host.setAgentEnabled("codex", false);
        QTRY_VERIFY(methods(root()).count("agent.enablement.write") == 2);
        host.receiveLine({{"id", host.m_agentWriteId}, {"result", QJsonObject{{"status", "review"}, {"review", QJsonObject{
            {"kind", "codex"}, {"revision", 2}, {"token", QString(64, 'a')}, {"sessions", QJsonArray{"Task"}}, {"total", 1}}}}}});
        QCOMPARE(review.size(), 1);
        QSignalSpy feedback(&host, &HostController::agentWriteFeedback);
        host.applyAgentEnablement(snapshot(3, true, true), true);
        feedback.clear();
        host.confirmAgentReviews();
        QCOMPARE(feedback.size(), 1);
        QCOMPARE(feedback.first().at(1).toString(), QString("conflict"));
        QCOMPARE(host.m_agentWriteId, -1);
        QCOMPARE(methods(root()).count("agent.enablement.write"), 2);
    }

    // OPENCLAW-04: only a successful save reconnects a running Host; a paused Host stays paused.
    void openClawSettingsReconnectOnlyAfterSuccessfulSave() {
        auto &host = *m_host;
        connectHost(host, root());
        host.m_openClaw = {{"source", "file"}};
        const auto url = QString("ws://127.0.0.1:18789");
        host.saveOpenClaw(url, "fixture-token", "sessions");
        settle(host);
        QCOMPARE(methods(root()), QStringList({"openclaw.save", "stop", "start"}));
        QCOMPARE(host.openClaw().value("url").toString(), url);
        QCOMPARE(host.openClaw().value("access").toString(), QString("sessions"));
        QVERIFY(!host.openClaw().contains("token"));
        QFile marker(root() + "/packages/host/dist/fail-openclaw.save");
        QVERIFY(marker.open(QIODevice::WriteOnly)); marker.close();
        clearMethods(root());
        host.saveOpenClaw("ws://invalid", "");
        settle(host);
        QCOMPARE(methods(root()), QStringList({"openclaw.save"}));
        QCOMPARE(host.openClaw().value("url").toString(), url);
        QVERIFY(host.desiredRunning());
        QVERIFY(marker.remove());
        host.stopHost(); settle(host);
        clearMethods(root());
        host.saveOpenClaw("", "");
        settle(host);
        QCOMPARE(methods(root()), QStringList({"openclaw.save"}));
        QVERIFY(!host.desiredRunning());
        QVERIFY(host.openClaw().value("url").toString().isEmpty());
        host.m_openClaw = {{"source", "environment"}, {"url", url}};
        clearMethods(root());
        host.saveOpenClaw("", "");
        QVERIFY(!host.busy());
        QVERIFY(methods(root()).isEmpty());
    }

    // OPENCLAW-HOST-SETTINGS-01: native writes require reported Gateway authority and a loaded form.
    void openClawNativeSettingsRequireGrantAndRead() {
        auto &host = *m_host;
        connectHost(host, root());
        const QVariantMap changes{{"workspace", "/new-workspace"}, {"resetHour", QVariant::fromValue(nullptr)}};
        host.receiveLine({{"event", "status"}, {"openClawConnection", QJsonObject{{"phase", "connected"}, {"granted", "sessions"}, {"canEdit", false}}}});
        host.readOpenClawNative(); host.applyOpenClawNative(changes);
        QVERIFY(methods(root()).isEmpty());
        host.receiveLine({{"event", "status"}, {"openClawConnection", QJsonObject{{"phase", "connected"}, {"granted", "admin"}, {"canEdit", true}}}});
        host.applyOpenClawNative(changes);
        QVERIFY(methods(root()).isEmpty());
        host.readOpenClawNative();
        QTRY_COMPARE(host.openClawNative().value("ticket").toString(), QString("fixture"));
        host.applyOpenClawNative(changes);
        settle(host);
        QCOMPARE(methods(root()), QStringList({"openclaw.config.read", "openclaw.config.apply"}));
        QVERIFY(host.openClawNative().isEmpty());
        QVERIFY(host.openClawNativeFeedback().contains("等待 Gateway 重启"));
        QFile written(root() + "/packages/host/dist/openclaw.config.apply.json");
        QVERIFY(written.open(QIODevice::ReadOnly));
        const auto args = QJsonDocument::fromJson(written.readAll()).object();
        QCOMPARE(args.value("ticket").toString(), QString("fixture"));
        QCOMPARE(args.value("changes").toObject().value("workspace").toString(), QString("/new-workspace"));
        QVERIFY(args.value("changes").toObject().value("resetHour").isNull());
    }

    // HERMES-REMOTE-01: apply an SSH target by reconnecting the Host; never retain auth material in Qt.
    void hermesRemoteSettingsReconnectOnlyAfterSuccessfulSave() {
        auto &host = *m_host;
        connectHost(host, root());
        host.m_hermesRemote = {{"source", "file"}, {"port", 22}};
        host.saveHermesRemote("hermes-box", 2222, "work");
        settle(host);
        QCOMPARE(methods(root()), QStringList({"hermes.remote.save", "stop", "start"}));
        QCOMPARE(host.hermesRemote().value("host").toString(), QString("hermes-box"));
        QCOMPARE(host.hermesRemote().value("port").toInt(), 2222);
        QCOMPARE(host.hermesRemote().value("profile").toString(), QString("work"));

        QFile marker(root() + "/packages/host/dist/fail-hermes.remote.save");
        QVERIFY(marker.open(QIODevice::WriteOnly)); marker.close();
        clearMethods(root());
        host.saveHermesRemote("invalid host", 22, "");
        settle(host);
        QCOMPARE(methods(root()), QStringList({"hermes.remote.save"}));
        QCOMPARE(host.hermesRemote().value("host").toString(), QString("hermes-box"));
        QVERIFY(host.desiredRunning());
        QVERIFY(marker.remove());

        host.stopHost(); settle(host);
        clearMethods(root());
        host.saveHermesRemote("", 22, "");
        settle(host);
        QCOMPARE(methods(root()), QStringList({"hermes.remote.save"}));
        QVERIFY(!host.desiredRunning());
        QVERIFY(host.hermesRemote().value("host").toString().isEmpty());

        host.m_hermesRemote = {{"source", "environment"}, {"host", "managed"}};
        clearMethods(root());
        host.saveHermesRemote("", 22, "");
        QVERIFY(!host.busy());
        QVERIFY(methods(root()).isEmpty());
    }

    void agentUpdatePausesAndResumes_data() {
        QTest::addColumn<bool>("fails");
        QTest::addColumn<QString>("kind");
        QTest::newRow("installed") << false << QString("pi");
        QTest::newRow("failed") << true << QString("pi");
        QTest::newRow("claude-updated") << false << QString("claude");
        QTest::newRow("claude-failed") << true << QString("claude");
    }
    void agentUpdatePausesAndResumes() {
        QFETCH(bool, fails);
        QFETCH(QString, kind);
        auto &host = *m_host;
        connectHost(host, root());
        if (fails) { QFile marker(root() + "/packages/host/dist/fail-updateAgent"); QVERIFY(marker.open(QIODevice::WriteOnly)); }
        host.updateAgent(kind);
        QVERIFY(host.resumePending()); QVERIFY(!host.desiredRunning());
        settle(host);
        QCOMPARE(methods(root()), QStringList({"stop", "updateAgent", "start"}));
        QTRY_COMPARE(host.state(), QString("connected"));
        QVERIFY(host.desiredRunning());
        QCOMPARE(host.agentInstallStage(), QString(fails ? "error" : "done"));
        // HOST-CLAUDE-UPDATE-02: the core now verifies that the original launcher
        // reached official latest before it returns a successful update.
        if (kind == "claude") {
            QVERIFY(!host.m_settings.contains("claudeEntry"));
            if (!fails) QVERIFY(host.message().contains("已更新到最新版本 9.9.9"));
        }
    }
    // Latest query errors remain independent of a working installation. A core
    // without the new optional fields must clear them instead of leaving stale UI.
    void claudeLatestFactsFollowStatus() {
        auto &host = *m_host;
        host.receiveLine({{"event", "claudeStatus"}, {"installed", true}, {"compatible", true}, {"version", "2.1.322"},
            {"latestVersion", "2.1.325"}, {"updateAvailable", true}});
        QCOMPARE(host.claudeLatestVersion(), QString("2.1.325"));
        QVERIFY(host.claudeUpdateAvailable());
        host.receiveLine({{"event", "claudeStatus"}, {"installed", true}, {"compatible", true}, {"version", "2.1.322"},
            {"latestChecking", true}});
        QVERIFY(host.claudeLatestChecking());
        host.receiveLine({{"event", "claudeStatus"}, {"installed", true}, {"compatible", true}, {"version", "2.1.322"},
            {"latestError", "查询失败"}});
        QVERIFY(host.claudeInstalled()); QVERIFY(host.claudeCompatible());
        QVERIFY(!host.claudeLatestChecking()); QVERIFY(!host.claudeUpdateAvailable());
        QVERIFY(host.claudeLatestVersion().isEmpty());
        QCOMPARE(host.claudeLatestError(), QString("查询失败"));
        host.receiveLine({{"event", "claudeStatus"}, {"installed", true}, {"compatible", true}, {"version", "2.1.325"}});
        QVERIFY(host.claudeLatestError().isEmpty()); QVERIFY(host.claudeLatestVersion().isEmpty());
    }
    void batchUpdateAndDshRestartResume() {
        auto &host = *m_host;
        connectHost(host, root());
        host.installAllAgents("update");
        settle(host);
        host.restartDshServer();
        settle(host);
        QCOMPARE(methods(root()), QStringList({"stop", "installAll", "start", "stop", "restartDshServer", "start"}));
        QTRY_COMPARE(host.state(), QString("connected"));
    }
    void pausedHostStaysPaused() {
        auto &host = *m_host;
        connectHost(host, root());
        host.stopHost();
        QTRY_COMPARE(host.state(), QString("stopped"));
        settle(host);
        clearMethods(root());
        host.updateAgent("pi");
        settle(host);
        host.saveSettings(host.relayUrl(), host.autoStart(), !host.codexEnabled(), "renamed", host.dshEnabled(), host.dshWebUrl(), true, true);
        settle(host);
        QCOMPARE(methods(root()), QStringList({"updateAgent", "rename"}));
        QCOMPARE(host.state(), QString("stopped")); QVERIFY(!host.desiredRunning());
    }
    // A legacy Kimi setting is not a second writer; toggling uses the common bridge.
    void kimiEnablementIsAuthoritative() {
        auto &host = *m_host;
        connectHost(host, root());
        host.m_kimiCodeSupported = true;
        host.m_settings.setValue("kimiCodeEnabled", false);
        host.applyAgentEnablement({{"revision", 1}, {"agents", QJsonArray{QJsonObject{{"kind", "kimiCode"}, {"enabled", true}}}}});
        settle(host);
        QVERIFY(host.kimiCodeAvailable()); QVERIFY(host.kimiCodeEnabled());
        host.receiveLine({{"event", "status"}, {"kimiCodeState", "connected"}});
        QCOMPARE(host.kimiCodeState(), QString("connected"));
        host.setAgentEnabled("kimiCode", false, 1);
        QTRY_VERIFY(!host.kimiCodeEnabled());
        QCOMPARE(methods(root()), QStringList({"agent.enablement.write"}));
        QVERIFY(!host.kimiCodeEnabled()); QVERIFY(host.kimiCodeState().isEmpty());
        QCOMPARE(host.state(), QString("connected"));
    }
    // KIMI-11: source changes apply through the same stop/start path and do not replace the inherited default.
    void kimiSourceSwitchRestartsEnabledHost() {
        auto &host = *m_host;
        connectHost(host, root());
        host.m_kimiCodeSupported = true;
        host.m_kimiDesktopSupported = true;
        host.applyAgentEnablement({{"revision", 1}, {"agents", QJsonArray{QJsonObject{{"kind", "kimiCode"}, {"enabled", true}}}}});
        settle(host);
        QCOMPARE(host.kimiCodeSource(), QString("web"));
        host.saveSettings(host.relayUrl(), host.autoStart(), host.codexEnabled(), host.hostName(), host.dshEnabled(), host.dshWebUrl(), true, true, "desktop");
        settle(host);
        QCOMPARE(host.kimiCodeSource(), QString("desktop"));
        QCOMPARE(methods(root()), QStringList({"stop", "start"}));
        QFile start(root() + "/packages/host/dist/start.json");
        QVERIFY(start.open(QIODevice::ReadOnly));
        QCOMPARE(QJsonDocument::fromJson(start.readAll()).object().value("kimiCodeSource"), QJsonValue("desktop"));
    }
    void settingsReconnectOnlyForConnectionFields() {
        auto &host = *m_host;
        connectHost(host, root());
        // Terminal integration applies live.
        host.saveSettings(host.relayUrl(), host.autoStart(), host.codexEnabled(), "fixture", host.dshEnabled(), host.dshWebUrl(), true, false);
        settle(host);
        QCOMPARE(methods(root()), QStringList({"claudeIntegration"}));
        clearMethods(root());
        // The Host name and prestart switches are start parameters of the running service.
        host.saveSettings(host.relayUrl(), host.autoStart(), !host.codexEnabled(), "renamed", host.dshEnabled(), host.dshWebUrl(), true, false);
        QVERIFY(host.resumePending());
        settle(host);
        QCOMPARE(methods(root()), QStringList({"stop", "rename", "start"}));
        QTRY_COMPARE(host.state(), QString("connected"));
        QCOMPARE(host.hostName(), QString("renamed"));
        clearMethods(root());
        // A different relay invalidates this activation: pause, and wait for the user to activate again.
        host.saveSettings("ws://127.0.0.1:2", host.autoStart(), host.codexEnabled(), "renamed", host.dshEnabled(), host.dshWebUrl(), true, false);
        settle(host);
        QCOMPARE(methods(root()), QStringList({"stop"}));
        QVERIFY(!host.activated()); QVERIFY(!host.desiredRunning());
        QTRY_COMPARE(host.state(), QString("stopped"));
    }
    // A grayed-out button has to say why: every guard in startHost() now has a readable reason,
    // and a pending command names itself so "nothing happened" is distinguishable from "working".
    void activityNamesTheBlockedAction() {
        auto &host = *m_host;
        // 内核未就绪：以前界面写“已暂停”，按钮也是灰的，没有任何原因。
        QVERIFY(!host.bridgeReady());
        QCOMPARE(host.connectionBlockReason(), QString("Host 核心正在启动"));
        // ADR-0081 review: a core that exited for good used to read as "starting" forever.
        host.m_state = "error";
        QCOMPARE(host.connectionBlockReason(), QString("Host 核心未运行"));
        host.m_state = "stopped";
        // HOST-ACTIVITY-05: the saved activation is read off the UI thread; the guards below assume it settled.
        QTRY_VERIFY(!host.credentialsLoading());
        host.m_bridgeReady = true;
        QCOMPARE(host.connectionBlockReason(), QString("请先激活这台电脑"));
        host.m_credential = "orbis_host_fixture";
        host.m_activationIO = 1;
        QCOMPARE(host.connectionBlockReason(), QString("正在读取激活信息"));
        host.m_activationIO = 0;
        host.m_relaySelectionPending = true;
        QCOMPARE(host.connectionBlockReason(), QString("正在切换中继服务器"));
        host.m_relaySelectionPending = false;
        host.m_agentInstallStage = "downloading";
        QCOMPARE(host.connectionBlockReason(), QString("正在安装 Agent，完成后会自动连接"));
        host.m_agentInstallStage.clear();
        QCOMPARE(host.connectionBlockReason(), QString());

        // 在途命令会说出自己在做什么，结束后立刻清空。
        QTRY_VERIFY_WITH_TIMEOUT(methods(root()).contains("initialize"), 10000);
        QTRY_VERIFY_WITH_TIMEOUT(!host.busy(), 10000);
        host.detectAgents(true);
        QCOMPARE(host.activity().value("kind").toString(), QString("agents"));
        QCOMPARE(host.activity().value("text").toString(), QString("正在检查 Agent 更新"));
        // HOST-LANE-01: detection runs beside connection commands and no longer greys out the window.
        QVERIFY(!host.busy());
        QTRY_VERIFY_WITH_TIMEOUT(host.activity().isEmpty(), 10000);
    }
    // HOST-ACTIVITY-05 (ADR-0081 §5-5): a Keychain read that waits for the user used to block the UI
    // thread inside the constructor. It now runs on the credential worker; the window says what it waits for.
    void storedActivationLoadsOffTheUiThread() {
        m_host.reset();
        QSemaphore release;
        HostController::s_credentialLoader = [&release](const QString &, QString *) {
            release.acquire();
            return QJsonObject{{"relayUrl", "ws://127.0.0.1:1"}, {"credential", "orbis_host_loaded"}, {"email", "a@qq.com"}, {"hostId", "computer"}};
        };
        QSettings(root() + "/desktop/settings.ini", QSettings::IniFormat).setValue("relayUrl", "ws://127.0.0.1:1");
        HostController host(root() + "/missing-runtime", root() + "/desktop", root() + "/state", root() + "/desktop", false);
        HostController::s_credentialLoader = {};
        host.m_tick.stop();
        // The constructor returned while the read is still blocked: the UI thread is free.
        QVERIFY(host.credentialsLoading());
        QVERIFY(!host.activated());
        host.m_bridgeReady = true;
        QCOMPARE(host.connectionBlockReason(), QString("正在读取激活信息"));
        // Work that needs the saved Relay and Host ID waits for the read instead of using defaults.
        bool continued = false;
        host.afterStoredActivation([&continued] { continued = true; });
        QVERIFY(!continued);
#ifdef Q_OS_MACOS
        QTRY_VERIFY_WITH_TIMEOUT(host.awaitingSystemAuthorization(), 3000);
        QCOMPARE(host.connectionBlockReason(), QString("正在等待系统授权"));
#endif
        release.release();
        QTRY_VERIFY(!host.credentialsLoading());
        QVERIFY(continued);
        QVERIFY(!host.awaitingSystemAuthorization());
        QCOMPARE(host.m_credential, QString("orbis_host_loaded"));
        QCOMPARE(host.hostId(), QString("computer"));
        QCOMPARE(host.connectionBlockReason(), QString());
    }
    // HOST-LANE-01: the bridge now answers connection and background commands out of submission order.
    // A continuation must wait for every earlier request, not only the last one sent.
    void queuedContinuationsWaitForEveryEarlierRequest() {
        auto &host = *m_host;
        QTRY_VERIFY_WITH_TIMEOUT(methods(root()).contains("initialize"), 10000);
        QTRY_VERIFY(!host.busy());
        host.m_tick.stop();
        host.m_pending.insert(900, {}); host.m_methods.insert(900, "start");
        host.m_pending.insert(901, {}); host.m_methods.insert(901, "rename");
        host.m_nextId = 902;
        bool resumed = false;
        host.afterQueuedCommands([&resumed] { resumed = true; });
        // The later request answers first, as a background or pause request now may.
        host.receiveLine({{"id", 901}, {"result", QJsonObject{}}});
        QVERIFY(!resumed);
        host.receiveLine({{"id", 900}, {"result", QJsonObject{}}});
        QVERIFY(resumed);
    }
    // HOST-LIVE-02: a change finishing during exit cannot claim a restart whose
    // bridge command is rejected. If cleanup fails, the paused Host stays restartable.
    void lateChangeCompletionDuringExitKeepsHostRestartable() {
        auto &host = *m_host;
        connectHost(host, root());
        QVERIFY(host.pauseForChange());
        QTRY_COMPARE(host.state(), QString("stopped"));
        QTRY_VERIFY(!host.busy());
        host.m_pending.insert(930, {}); host.m_methods.insert(930, "rename");
        host.m_nextId = 931; ++host.m_busy;
        host.afterQueuedCommands([&host] { host.resumeAfterChange(); });

        // beginExit owns these flags before its asynchronous cleanup worker replies.
        host.m_exiting = true; host.m_shutdown = true;
        host.receiveLine({{"id", 930}, {"result", QJsonObject{}}});
        host.failExit("fixture cleanup failed");
        QVERIFY(!host.desiredRunning());
        QCOMPARE(host.state(), QString("stopped"));
        QVERIFY(!host.resumePending());
        host.startHost();
        QTRY_COMPARE(host.state(), QString("connected"));
        QTRY_VERIFY(!host.busy());
    }
    // HOST-LANE-01 / HOST-PREP-04/05: a background detection no longer greys out unrelated controls, each
    // control reads its own in-flight kind, and background preparation is reported per Agent.
    void backgroundWorkStaysOutOfTheWay() {
        auto &host = *m_host;
        connectHost(host, root());
        host.m_pending.insert(910, {}); host.m_methods.insert(910, "detect");
        host.m_activity.insert(910, {"agents", "正在检查 Agent 更新"}); host.m_activityOrder.append(910);
        host.m_pending.insert(911, {}); host.m_methods.insert(911, "start"); ++host.m_busy;
        host.m_activity.insert(911, {"connect", "正在连接中继"}); host.m_activityOrder.append(911);
        // The connection card names the connection even though detection was submitted first.
        QCOMPARE(host.activity().value("kind").toString(), QString("connect"));
        QCOMPARE(host.activityKinds(), QStringList({"agents", "connect"}));
        host.receiveLine({{"id", 911}, {"result", QJsonObject{}}});
        QVERIFY(!host.busy());
        host.receiveLine({{"id", 910}, {"result", QJsonArray{}}});
        QVERIFY(host.activityKinds().isEmpty());

        host.receiveLine({{"event", "preparation"}, {"kind", "claude"}, {"state", "preparing"}});
        host.receiveLine({{"event", "preparation"}, {"kind", "dsh"}, {"state", "preparing"}});
        host.receiveLine({{"event", "preparation"}, {"kind", "codex"}, {"state", "preparing"},
            {"download", QJsonObject{{"receivedBytes", 10}, {"totalBytes", 100}}}});
        QCOMPARE(host.codexTerminal().value("receivedBytes").toDouble(), 10.0);
        QCOMPARE(host.preparations().keys(), QStringList({"claude", "codex", "dsh"}));
        host.receiveLine({{"event", "preparation"}, {"kind", "dsh"}, {"state", "ready"}});
        QVERIFY(!host.preparations().contains("dsh"));
        // Pausing ends this run's backend preparation; plugin registration belongs to the Host core.
        host.stopHost();
        QTRY_COMPARE(host.state(), QString("stopped"));
        QCOMPARE(host.preparations().keys(), QStringList({"claude"}));
    }
    // HOST-DOWNLOAD-01: an opaque updater is visible without fabricated bytes, and batch items do not share totals.
    void agentDownloadProgressWithoutTelemetry() {
        auto &host = *m_host;
        host.receiveLine({{"event", "agentInstall"}, {"kind", "codex"}, {"stage", "downloading"},
            {"download", QJsonObject{{"receivedBytes", 10}, {"totalBytes", 100}}}});
        QCOMPARE(host.downloadTotal(), 100);
        host.receiveLine({{"event", "agentInstall"}, {"kind", "claude"}, {"stage", "downloading"}});
        QCOMPARE(host.downloadLabel(), QString("Claude Code"));
        QCOMPARE(host.downloadReceived(), 0);
        QCOMPARE(host.downloadTotal(), 0);
        host.receiveLine({{"event", "agentInstall"}, {"kind", "claude"}, {"stage", "verifying"}});
        QCOMPARE(host.downloadReceived(), -1);
    }
    // HOST-ACTIVITY-04: a DSH Server restart says which stage it is waiting on.
    void dshRestartNamesItsStage() {
        auto &host = *m_host;
        QTRY_VERIFY_WITH_TIMEOUT(methods(root()).contains("initialize"), 10000);
        QTRY_VERIFY(!host.busy());
        host.m_pending.insert(920, {}); host.m_methods.insert(920, "restartDshServer");
        host.m_activity.insert(920, {"dsh", "正在重启 DSH Server"}); host.m_activityOrder.append(920);
        host.receiveLine({{"event", "dshServer"}, {"stage", "waiting"}});
        QCOMPARE(host.activity().value("text").toString(), QString("正在等待另一个 DSH Server 启动完成"));
        host.receiveLine({{"event", "dshServer"}, {"stage", "starting"}});
        QCOMPARE(host.activity().value("text").toString(), QString("正在启动 DSH Server"));
        host.receiveLine({{"id", 920}, {"result", QJsonObject{}}});
        QVERIFY(host.activity().isEmpty());
    }
    void pausedHostDropsRunningFacts() {
        auto &host = *m_host;
        connectHost(host, root());
        const QJsonObject backends{{"domain", "backends"}, {"value", QJsonObject{{"backends", QJsonArray{
            QJsonObject{{"kind", "pi"}, {"ready", true}, {"launchable", true}, {"runtimeCount", 2}},
            QJsonObject{{"kind", "codex"}, {"ready", false}, {"launchable", true}, {"runtimeCount", 0}}}}}}};
        host.receiveLine({{"event", "status"}, {"runtimeCount", 2},
            {"devices", QJsonArray{QJsonObject{{"deviceId", "phone"}, {"path", "relay"}, {"createdAt", 1}}}},
            {"model", QJsonObject{{"domains", QJsonArray{QJsonObject{{"domain", "connections"}, {"value", QJsonObject{}}}, backends}}}}});
        QCOMPARE(host.backends().size(), 2);
        QCOMPARE(host.backends().first().toMap().value("runtimeCount").toInt(), 2);
        QCOMPARE(host.devices().first().toMap().value("path").toString(), QString("relay"));
        host.stopHost();
        QTRY_COMPARE(host.state(), QString("stopped"));
        QVERIFY(host.backends().isEmpty()); QCOMPARE(host.runtimeCount(), 0);
        QCOMPARE(host.devices().size(), 1);
        QCOMPARE(host.devices().first().toMap().value("path").toString(), QString("offline"));
    }
    // HOST-DESKTOP-CANCEL-01: disposed lifecycles cannot publish their closing
    // status. The native diagnostics must drop both Desktop facts on the owning
    // connection's terminal event and accept the next run's new publication.
    void desktopFactsFollowConnectionLifetime_data() {
        QTest::addColumn<bool>("activationLost");
        QTest::newRow("paused") << false;
        QTest::newRow("activation-lost") << true;
    }
    void desktopFactsFollowConnectionLifetime() {
        QFETCH(bool, activationLost);
        auto &host = *m_host;
        connectHost(host, root());
        const QJsonObject attached{{"state", "attached"}, {"reason", "fixture previous run"}};
        host.receiveLine({{"event", "codexDesktop"}, {"status", attached}});
        host.receiveLine({{"event", "dshDesktop"}, {"status", attached}});
        QCOMPARE(host.codexDesktop().value("state").toString(), QString("attached"));
        QCOMPARE(host.dshDesktop().value("state").toString(), QString("attached"));
        if (activationLost) {
            // Credential persistence has its own tests; keep this UI-state
            // regression independent of the developer's native key store.
            host.m_credential.clear();
            host.receiveLine({{"event", "state"}, {"state", "error"}, {"activationRequired", true}});
            QCOMPARE(host.state(), QString("error"));
        } else {
            host.stopHost();
            QTRY_COMPARE(host.state(), QString("stopped"));
            settle(host);
        }
        QVERIFY(host.codexDesktop().isEmpty());
        QVERIFY(host.dshDesktop().isEmpty());
        const auto diagnostic = QJsonDocument::fromJson(host.diagnostics().toUtf8()).object();
        QVERIFY(diagnostic.value("codexDesktop").toObject().isEmpty());
        QVERIFY(diagnostic.value("dshDesktop").toObject().isEmpty());
        host.m_credential = "orbis_host_fixture";
        host.startHost();
        QTRY_COMPARE(host.state(), QString("connected"));
        QTRY_VERIFY(!host.busy());
        QVERIFY(host.codexDesktop().isEmpty());
        host.receiveLine({{"event", "codexDesktop"},
            {"status", QJsonObject{{"state", "attached"}, {"reason", "fixture current run"}}}});
        QCOMPARE(host.codexDesktop().value("state").toString(), QString("attached"));
        QCOMPARE(host.codexDesktop().value("reason").toString(), QString("fixture current run"));
    }
};
QTEST_MAIN(HostLiveChangeTest)
#include "HostLiveChangeTest.moc"
