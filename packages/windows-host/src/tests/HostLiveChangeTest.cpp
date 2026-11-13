#include "../HostController.h"
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonObject>
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
        QTest::newRow("installed") << false;
        QTest::newRow("failed") << true;
    }
    void agentUpdatePausesAndResumes() {
        QFETCH(bool, fails);
        auto &host = *m_host;
        connectHost(host, root());
        if (fails) { QFile marker(root() + "/packages/host/dist/fail-updateAgent"); QVERIFY(marker.open(QIODevice::WriteOnly)); }
        host.updateAgent("pi");
        QVERIFY(host.resumePending()); QVERIFY(!host.desiredRunning());
        settle(host);
        QCOMPARE(methods(root()), QStringList({"stop", "updateAgent", "start"}));
        QTRY_COMPARE(host.state(), QString("connected"));
        QVERIFY(host.desiredRunning());
        QCOMPARE(host.agentInstallStage(), QString(fails ? "error" : "done"));
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
};
QTEST_MAIN(HostLiveChangeTest)
#include "HostLiveChangeTest.moc"
