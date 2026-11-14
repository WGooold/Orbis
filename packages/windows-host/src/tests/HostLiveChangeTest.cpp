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
  const { id, method } = JSON.parse(line);
  fs.appendFileSync(path.join(__dirname, "methods.log"), method + "\n");
  const failing = path.join(__dirname, "fail-" + method);
  if (method === "initialize") return out({ id, error: "fixture bridge stays uninitialized" });
  if (fs.existsSync(failing)) return out({ id, error: method + " failed in fixture" });
  if (method === "start") { out({ event: "state", state: "connecting" }); out({ event: "state", state: "connected" }); }
  if (method === "stop") out({ event: "state", state: "stopped" });
  if (method === "detect") return out({ id, result: [] });
  if (method === "updateAgent") return out({ id, result: { entry: "/fixture/pi", version: "9.9.9" } });
  out({ id, result: {} });
});
)JS");
    }
    static QStringList methods(const QString &root) {
        QFile file(root + "/packages/host/dist/methods.log");
        if (!file.open(QIODevice::ReadOnly)) return {};
        QStringList result;
        for (const auto &line : QString::fromUtf8(file.readAll()).split('\n', Qt::SkipEmptyParts)) if (line != "detect") result.append(line);
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
        // HOST-CLAUDE-UPDATE-01: native Claude keeps its own launcher/channel;
        // a successful check must not claim the public latest release.
        if (kind == "claude") {
            QVERIFY(!host.m_settings.contains("claudeEntry"));
            if (!fails) { QVERIFY(host.message().contains("当前版本 9.9.9")); QVERIFY(!host.message().contains("最新版本")); }
        }
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
