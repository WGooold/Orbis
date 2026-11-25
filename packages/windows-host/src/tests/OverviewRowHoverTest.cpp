#include "../HostController.h"
#include "../NeuSurface.h"
#include <QAccessible>
#include <QApplication>
#include <QDir>
#include <QElapsedTimer>
#include <QSignalSpy>
#include <QEnterEvent>
#include <QFile>
#include <QFileDialog>
#include <QMouseEvent>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickItem>
#include <QQmlProperty>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QSettings>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QTimer>
#include <QtTest>
#include <algorithm>

namespace {
QQuickItem *findVisualItem(QQuickItem *root, const QString &name) {
    if (!root) return nullptr;
    if (root->objectName() == name) return root;
    for (auto *child : root->childItems()) {
        if (auto *match = findVisualItem(child, name)) return match;
    }
    return nullptr;
}

QQuickItem *findTextLabel(QQuickItem *root, const QString &text) {
    if (!root) return nullptr;
    if (root->metaObject()->className() && QByteArray(root->metaObject()->className()).contains("Label") &&
        root->property("text").toString() == text)
        return root;
    for (auto *child : root->childItems()) {
        if (auto *match = findTextLabel(child, text)) return match;
    }
    return nullptr;
}

QQuickItem *findHoverHighlight(QQuickItem *card, const QColor &expectedColor) {
    if (!card) return nullptr;
    QList<QQuickItem *> queue{card};
    while (!queue.isEmpty()) {
        auto *item = queue.takeFirst();
        if (item->metaObject()->className() &&
            QByteArray(item->metaObject()->className()) == "QQuickRectangle" &&
            item->isVisible() && item->height() >= 48 &&
            item->property("color").value<QColor>() == expectedColor) {
            return item;
        }
        queue.append(item->childItems());
    }
    return nullptr;
}

bool clickWithWorkspacePicker(QQuickItem *action, const QString &workspace, QString &pickerTitle) {
    const bool usedQtPicker = QCoreApplication::testAttribute(Qt::AA_DontUseNativeDialogs);
    QCoreApplication::setAttribute(Qt::AA_DontUseNativeDialogs);
    QTimer pickerProbe;
    pickerProbe.setSingleShot(true);
    QObject::connect(&pickerProbe, &QTimer::timeout, [&] {
        auto *picker = qobject_cast<QFileDialog *>(QApplication::activeModalWidget());
        if (!picker) return;
        pickerTitle = picker->windowTitle();
        if (!workspace.isEmpty()) {
            picker->setDirectory(workspace);
            QMetaObject::invokeMethod(picker, "accept");
        }
        if (picker->isVisible()) picker->reject();
    });
    // The timer runs inside the directory picker's nested event loop, if it opens.
    pickerProbe.start(0);
    const bool clicked = QMetaObject::invokeMethod(action, "clicked");
    QCoreApplication::setAttribute(Qt::AA_DontUseNativeDialogs, usedQtPicker);
    return clicked;
}

void writeFixtureBridge(const QString &root) {
    QDir().mkpath(root + "/packages/host/dist");
    QFile file(root + "/packages/host/dist/desktop-bridge.js");
    QVERIFY(file.open(QIODevice::WriteOnly));
    file.write(R"JS(
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
const agents = [
  { kind: "pi", label: "Pi", enabled: true },
  { kind: "codex", label: "Codex", enabled: true },
  { kind: "codexDesktop", label: "Codex 桌面版", enabled: true },
  { kind: "claude", label: "Claude Code", enabled: true },
  { kind: "dsh", label: "DeepSeek CLI", enabled: true },
  { kind: "dshDesktop", label: "DeepSeek 桌面版", enabled: true },
  { kind: "kimiCode", label: "Kimi Code", enabled: true },
  { kind: "kimiCodeDesktop", label: "Kimi Code 桌面版", enabled: false },
  { kind: "opencode", label: "OpenCode", enabled: true },
  { kind: "agy", label: "Antigravity CLI", enabled: true },
  { kind: "hermes", label: "Hermes Agent", enabled: true },
  { kind: "openclaw", label: "OpenClaw", enabled: true }
];
let currentAgents = agents;
const launchStatus = (kind, state, ready) => ({ event: "status", ...(kind === "kimiCode" ? { kimiCodeState: state } : {}), model: { domains: [{ domain: "backends", value: {
  backends: [{ kind, ready, launchable: true, runtimeCount: 0, reason: state }]
} }] } });
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") {
    out({
      id,
      result: {
        hostId: "fixture-host",
        hostName: "Fixture",
        devices: [{ deviceId: "phone-1", label: "iPhone", path: "relay", createdAt: 1 }],
        agentEnablement: { revision: 1, agents: currentAgents },
        agentVersionRequirements: {
          codex: { kind: "reference", version: "0.167.0" },
          codexDesktop: { kind: "unknown" },
          claude: { kind: "minimum", version: "2.1.287" },
          dsh: { kind: "baseline", version: "0.2.2-rc.2" },
          dshDesktop: { kind: "baseline", version: "0.2.2-rc.2" },
          pi: { kind: "reference", version: "0.84.4" },
          kimiCode: { kind: "exact", version: "2.6.3" },
          kimiCodeDesktop: { kind: "embeddedService", version: "2.6.2" },
          opencode: { kind: "exact", version: "2.3.2" },
          hermes: { kind: "reference", version: "0.22.5" },
          openclaw: { kind: "localLaunch", version: "2026.11.5" }
        },
        kimiCodeSupported: true,
        kimiDesktopSupported: true,
        openCodeTuiTabsEnabled: false,
        openClaw: { source: "file", url: "", hasToken: false },
        hermesRemote: { source: "file", host: "", port: 22, profile: "" }
      }
    });
    out({ event: "state", state: "connected" });
    out({ event: "claudeStatus", installed: true, compatible: true, version: "2.1.300", minimumVersion: "2.1.287" });
    out({ event: "codexDesktop", status: { state: "attached", reason: "" } });
    out({ event: "dshDesktop", status: { state: "attached", reason: "已接入 DeepSeek 桌面版 0.2.2-rc.2", version: "0.2.2-rc.2" } });
    out({ event: "hermesCli", installed: true, version: "0.1.4" });
    out({
      event: "status",
      kimiCodeState: "not_running",
      runtimeCount: 4,
      devices: [{ deviceId: "phone-1", label: "iPhone", path: "relay", createdAt: 1 }],
      activeAgentSessions: { codexDesktop: { total: 4, sessions: [
        "整理 Sync 状态", "同步和布局回归：" + "核对中英混排、窄窗口、连接途径与状态标签。".repeat(7) + " This is a deliberately long session title"
      ] } },
      model: {
        domains: [{
          domain: "backends",
          value: {
            backends: [
              { kind: "pi", ready: true, launchable: true, runtimeCount: 0 },
              { kind: "codex", ready: true, launchable: true, runtimeCount: 0 },
              { kind: "codexDesktop", ready: true, launchable: true, runtimeCount: 4 },
              { kind: "claude", ready: true, launchable: true, runtimeCount: 0 },
              { kind: "dsh", ready: true, launchable: true, runtimeCount: 0 },
              { kind: "dshDesktop", ready: true, launchable: true, runtimeCount: 0 },
              { kind: "hermes", ready: true, launchable: true, runtimeCount: 0 },
              { kind: "kimiCode", ready: false, launchable: true, runtimeCount: 0 }
            ]
          }
        }]
      }
    });
    return;
  }
  if (method === "detect") {
    globalThis.__detectCalls = (globalThis.__detectCalls || 0) + 1;
    const withUpdates = !!(params && params.checkLatest) && globalThis.__detectCalls > 1;
    out({
      id,
      result: [
        { kind: "pi", installed: true, version: "0.70.0", latestVersion: "0.70.0", recommendedVersion: "0.70.0", updateAvailable: false },
        { kind: "codex", installed: true, desktopInstalled: true, version: "0.130.0", ...(withUpdates ? { latestVersion: "0.132.0", recommendedVersion: "0.132.0", updateAvailable: true } : {}) },
        { kind: "dsh", installed: true, desktopInstalled: true, version: "0.2.0", ...(withUpdates ? { latestVersion: "0.2.2", recommendedVersion: "0.2.2", updateAvailable: true, compatibilityNote: "Orbis 手机接入需要 0.2.2 或兼容版本，推荐安装 0.2.2" } : {}) }
      ]
    });
    if (withUpdates) {
      out({ event: "claudeStatus", installed: true, compatible: true, version: "2.1.300", minimumVersion: "2.1.287", latestVersion: "2.1.325", updateAvailable: true });
    }
    return;
  }
  if (method === "agent.enablement.write") {
    currentAgents = currentAgents.map(agent => agent.kind === params.kind ? { ...agent, enabled: params.enabled } : agent);
    const snapshot = { revision: params.expectedRevision + 1, agents: currentAgents };
    setTimeout(() => out({ id, result: { status: "applied", snapshot } }), 320);
    return;
  }
  if (method === "openCodeTuiTabs") {
    setTimeout(() => out({ id, result: { enabled: params.enabled } }), 100);
    return;
  }
  if (method === "openAgent" && params.kind === "opencode" && params.mode === "tui") {
    out({ id, result: {} });
    return;
  }
  if (method === "openAgent" && ["kimiCode", "opencode", "hermes", "openclaw", "agy"].includes(params.kind)) {
    out(launchStatus(params.kind, "starting", false));
    setTimeout(() => { out(launchStatus(params.kind, "connected", true)); out({ id, result: {} }); }, 360);
    return;
  }
  if (method === "provider.list") {
    out({
      id,
      result: [
        {
          id: "openai",
          name: "OpenAI Official",
          kind: "codex",
          category: "official",
          enabled: true,
          subscriptionSupported: true,
          websiteUrl: "https:\/\/platform.openai.com",
          notes: "官方 ChatGPT 托管登录与原生 CLI 配置"
        },
        {
          id: "openrouter",
          name: "OpenRouter Aggregator Gateway",
          kind: "codex",
          category: "aggregator",
          enabled: false,
          subscriptionSupported: false,
          websiteUrl: "https:\/\/openrouter.ai/api/v1/responses",
          notes: "备用中转节点，支持多模型路由与连通性检测"
        }
      ]
    });
    return;
  }
  if (method === "provider.presets") {
    out({ id, result: [] });
    return;
  }
  if (method === "openclaw.save") {
    out({ id, result: { source: "file", url: params.url, hasToken: !!params.token } });
    return;
  }
  if (method === "hermes.remote.save") {
    out({ id, result: { source: "file", host: params.host, port: params.port, profile: params.profile } });
    return;
  }
  if (method === "shutdown") {
    out({ id, result: {} });
    process.exit(0);
  }
  out({ id, result: {} });
});
)JS");
}
}

class OverviewRowHoverTest : public QObject {
    Q_OBJECT
private slots:
    void initTestCase() {
        qputenv("ORBIS_NO_KEYCHAIN", "1");
        QQuickStyle::setStyle("Basic");
        QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
        qmlRegisterType<NeuSurface>("Orbis.Host", 1, 0, "NeuSurface");
    }

    // HOST-AGENT-VERSION-01: the explanation follows the selected Agent, including powered-off
    // and unmanaged rows, and stays separate from the installed/update version.
    void showsVersionRequirementsOnDemand() {
        QVERIFY(!QStandardPaths::findExecutable("node").isEmpty());
        QTemporaryDir root;
        QVERIFY(root.isValid());
        writeFixtureBridge(root.path());
        const QString dataDir = root.filePath("desktop");
        HostController controller(root.path(), dataDir, root.filePath("state"), dataDir, false);
        controller.m_settings.setValue("relayUrl", "ws://127.0.0.1:1");
        controller.m_tick.stop();

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty("host", &controller);
        engine.rootContext()->setContextProperty("orbisAppearanceSettings", QUrl::fromLocalFile(dataDir + "/appearance.ini"));
        engine.rootContext()->setContextProperty("orbisMotionEnabled", false);
        engine.rootContext()->setContextProperty("trayAvailable", false);
        engine.loadFromModule("Orbis.Host", "Main");
        QVERIFY(!engine.rootObjects().isEmpty());
        auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
        QVERIFY(window);
        QTRY_VERIFY_WITH_TIMEOUT(controller.bridgeReady() && !controller.busy(), 10000);

        const QList<QPair<QString, QString>> requirements = {
            {"codex", "最低版本未确认 · 接入参考 v0.167.0"}, {"codexDesktop", "最低版本未确认"},
            {"claude", "最低支持 v2.1.287"}, {"dsh", "兼容基线 v0.2.2-rc.2"},
            {"dshDesktop", "兼容基线 v0.2.2-rc.2"}, {"pi", "最低版本未确认 · 接入参考 v0.84.4"},
            {"kimiCode", "仅支持 v2.6.3"}, {"kimiCodeDesktop", "仅支持内嵌服务 v2.6.2"},
            {"opencode", "仅支持 v2.3.2"}, {"hermes", "最低版本未确认 · 接入参考 v0.22.5"},
            {"openclaw", "本机启动需要 v2026.11.5；已有网关最低版本未确认"}
        };
        for (const auto &[kind, expected] : requirements) {
            QVERIFY(QMetaObject::invokeMethod(window, "goAgent", Q_ARG(QVariant, kind)));
            auto *info = findVisualItem(window->contentItem(), "agentVersionInfo");
            auto *hint = findVisualItem(window->contentItem(), "agentVersionRequirement");
            QTRY_VERIFY(info && info->isVisible() && info->isEnabled() && hint && !hint->isVisible());
            QVERIFY(QMetaObject::invokeMethod(info, "clicked"));
            QTRY_VERIFY(hint->isVisible());
            QCOMPARE(hint->property("text").toString(), expected);
        }
        // An older bridge that omits the optional metadata cannot imply compatibility.
        controller.m_agentVersionRequirements.clear();
        emit controller.changed();
        auto *hint = findVisualItem(window->contentItem(), "agentVersionRequirement");
        QCOMPARE(hint->property("text").toString(), QString("最低版本未确认"));
    }

    void startsLocalAgentFromHost_data() {
        QTest::addColumn<QString>("kind");
        for (const auto *kind : {"kimiCode", "opencode", "hermes", "openclaw", "agy"}) QTest::newRow(kind) << QString(kind);
    }

    // KIMI-12 / HOST-AGENT-START-01 / AGY-13: shared start UI reflects process status; configured remote gateways cannot be started here.
    // OPENCODE-TUI-01: only a ready OpenCode switches both existing actions from headless start to the workspace picker.
    void startsLocalAgentFromHost() {
        QFETCH(QString, kind);
        QVERIFY(!QStandardPaths::findExecutable("node").isEmpty());
        QTemporaryDir root;
        QVERIFY(root.isValid());
        writeFixtureBridge(root.path());
        const QString dataDir = root.filePath("desktop");
        HostController controller(root.path(), dataDir, root.filePath("state"), dataDir, false);
        controller.m_settings.setValue("relayUrl", "ws://127.0.0.1:1");
        controller.m_tick.stop();
        controller.m_credential = "orbis_host_fixture";
        controller.m_desiredRunning = true;

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty("host", &controller);
        engine.rootContext()->setContextProperty("orbisAppearanceSettings", QUrl::fromLocalFile(dataDir + "/appearance.ini"));
        engine.rootContext()->setContextProperty("orbisMotionEnabled", false);
        engine.rootContext()->setContextProperty("trayAvailable", false);
        engine.loadFromModule("Orbis.Host", "Main");
        QVERIFY(!engine.rootObjects().isEmpty());
        auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
        QVERIFY(window);
        QTRY_VERIFY_WITH_TIMEOUT(controller.bridgeReady() && !controller.busy() && controller.kimiCodeState() == "not_running", 10000);
        if (kind != "kimiCode") {
            if (kind == "openclaw") controller.m_openClaw.insert("url", "ws://127.0.0.1:18789");
            controller.receiveLine({{"event", "status"}, {"model", QJsonObject{{"domains", QJsonArray{
                QJsonObject{{"domain", "backends"}, {"value", QJsonObject{{"backends", QJsonArray{
                    QJsonObject{{"kind", kind}, {"ready", false}, {"launchable", true}, {"runtimeCount", 0}}
                }}}}}
            }}}}});
        }
        const auto overviewAction = [&] { return findVisualItem(window->contentItem(), "overviewAgent-" + kind); };
        auto *overview = overviewAction();
        QVERIFY(overview && overview->isVisible() && overview->isEnabled());
        QCOMPARE(overview->property("text").toString(), QString("启动"));
        QVERIFY(QMetaObject::invokeMethod(window, "goAgent", Q_ARG(QVariant, kind)));
        auto *detail = findVisualItem(window->contentItem(), "agentDetailOpen");
        auto *status = findVisualItem(window->contentItem(), kind == "kimiCode" ? "kimiCodeStatus" : "agentDetailState");
        QTRY_VERIFY(detail && status && detail->isVisible() && detail->isEnabled() && status->isVisible());
        QCOMPARE(status->property("text").toString(), QString("可启动"));
        if (kind == "hermes" || kind == "openclaw") {
            if (kind == "hermes") controller.m_hermesRemote.insert("host", "fixture.example");
            else controller.m_openClaw.insert("url", "wss://fixture.example");
            emit controller.changed();
            QTRY_VERIFY(!detail->isVisible());
            if (kind == "hermes") controller.m_hermesRemote.remove("host");
            else controller.m_openClaw.insert("url", "ws://127.0.0.1:18789");
            emit controller.changed();
            QTRY_VERIFY(detail->isVisible() && detail->isEnabled());
        }
        if (kind == "opencode") {
            auto *syncTabs = findVisualItem(window->contentItem(), "openCodeTuiTabsAction");
            QTRY_VERIFY(syncTabs && syncTabs->isVisible() && syncTabs->isEnabled());
            for (const bool enable : {true, false}) {
                QCOMPARE(syncTabs->property("text").toString(), QString(enable ? "启用会话栏同步" : "停用会话栏同步"));
                const int tabsRequestId = controller.m_nextId;
                QVERIFY(QMetaObject::invokeMethod(syncTabs, "clicked"));
                QCOMPARE(controller.m_methods.value(tabsRequestId), QString("openCodeTuiTabs"));
                QCOMPARE(controller.m_requestParams.value(tabsRequestId), (QJsonObject{{"enabled", enable}}));
                QVERIFY(!syncTabs->isEnabled());
                QTRY_COMPARE(controller.openCodeTuiTabsEnabled(), enable);
                QTRY_VERIFY(syncTabs->isEnabled());
            }
            QCOMPARE(detail->property("text").toString(), QString("启动"));
            const int requestId = controller.m_nextId;
            QString pickerTitle;
            QVERIFY(clickWithWorkspacePicker(detail, {}, pickerTitle));
            QVERIFY(pickerTitle.isEmpty());
            QCOMPARE(controller.m_methods.value(requestId), QString("openAgent"));
            QCOMPARE(controller.m_requestParams.value(requestId), (QJsonObject{{"kind", "opencode"}}));
        } else {
            QVERIFY(QMetaObject::invokeMethod(detail, "clicked"));
        }
        QTRY_COMPARE(status->property("text").toString(), QString("正在启动"));
        QVERIFY(!detail->isEnabled());
        QTRY_COMPARE(status->property("text").toString(), QString(kind == "kimiCode" ? "已接入" : "可用"));
        if (kind == "opencode") {
            QTRY_VERIFY(detail->isVisible() && detail->isEnabled());
            QCOMPARE(detail->property("text").toString(), QString("打开终端"));
            QVERIFY(!detail->property("loading").toBool());
            const auto workspace = root.filePath("workspace");
            QVERIFY(QDir().mkpath(workspace));
            for (const int page : {2, 0}) {
                QVERIFY(QMetaObject::invokeMethod(window, "selectPage", Q_ARG(QVariant, page)));
                auto *action = page == 2 ? detail : overviewAction();
                QVERIFY(action && action->isVisible() && action->isEnabled());
                QCOMPARE(action->property("text").toString(), QString("打开终端"));

                const int requestId = controller.m_nextId;
                QString pickerTitle;
                QVERIFY(clickWithWorkspacePicker(action, {}, pickerTitle));
                QCOMPARE(pickerTitle, QString("选择 OpenCode 工作区"));
                QCOMPARE(controller.m_nextId, requestId); // Cancel must not dispatch a bridge command.
                pickerTitle.clear();
                QVERIFY(clickWithWorkspacePicker(action, workspace, pickerTitle));
                QCOMPARE(pickerTitle, QString("选择 OpenCode 工作区"));
                QCOMPARE(controller.m_methods.value(requestId), QString("openAgent"));
                QCOMPARE(controller.m_requestParams.value(requestId),
                         (QJsonObject{{"kind", "opencode"}, {"mode", "tui"}, {"cwd", workspace}}));
                QVERIFY(!action->isEnabled());
                QTRY_VERIFY(!controller.busy());
                QTRY_COMPARE(controller.message(), QString("已打开 OpenCode 终端界面。请在新窗口中继续操作。"));
            }

            auto disabledAgents = QJsonArray::fromVariantList(controller.agentEnablement().value("agents").toList());
            for (qsizetype i = 0; i < disabledAgents.size(); ++i) {
                auto agent = disabledAgents.at(i).toObject();
                if (agent.value("kind") != "opencode") continue;
                agent.insert("enabled", false);
                disabledAgents.replace(i, agent);
            }
            controller.receiveLine({{"event", "agentEnablement"}, {"snapshot", QJsonObject{{"revision", 2}, {"agents", disabledAgents}}}});
            QTRY_VERIFY(overviewAction() == nullptr);
            QVERIFY(QMetaObject::invokeMethod(window, "selectPage", Q_ARG(QVariant, 2)));
            QVERIFY(!detail->isVisible());
        } else {
            QVERIFY(!detail->isVisible());
        }
        controller.shutdown();
    }

    void hoveringEnabledAgentRowPreservesRowAndCardGeometry_data() {
        QTest::addColumn<int>("windowWidth");
        QTest::newRow("compact") << 1020;
        QTest::newRow("default") << 1180;
    }

    // Hovering an overview agent row must keep its mark, label, action button, and
    // hover highlight inside the overviewAgents card without pushing siblings right.
    void hoveringEnabledAgentRowPreservesRowAndCardGeometry() {
        QFETCH(int, windowWidth);
        QVERIFY(!QStandardPaths::findExecutable("node").isEmpty());
        QTemporaryDir root;
        QVERIFY(root.isValid());
        writeFixtureBridge(root.path());

        const QString dataDir = root.path() + "/desktop";
        QDir().mkpath(dataDir);
        {
            QSettings appearance(dataDir + "/appearance.ini", QSettings::IniFormat);
            appearance.beginGroup("Appearance");
            appearance.setValue("material", "mist");
            appearance.setValue("mode", "light");
            appearance.endGroup();
        }

        HostController controller(root.path(), dataDir, root.path() + "/state", dataDir, false);
        controller.m_settings.setValue("relayUrl", "ws://127.0.0.1:1");
        controller.m_tick.stop();
        controller.m_credential = "orbis_host_fixture";

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty("host", &controller);
        engine.rootContext()->setContextProperty("orbisAppearanceSettings", QUrl::fromLocalFile(dataDir + "/appearance.ini"));
        engine.rootContext()->setContextProperty("orbisMotionEnabled", false);
        engine.rootContext()->setContextProperty("trayAvailable", false);
        engine.loadFromModule("Orbis.Host", "Main");
        QVERIFY(!engine.rootObjects().isEmpty());

        auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
        QVERIFY(window);
        window->resize(windowWidth, 820);
        QVERIFY(QTest::qWaitForWindowExposed(window));

        QTRY_VERIFY_WITH_TIMEOUT(controller.bridgeReady() && !controller.busy() &&
                                 !controller.agents().isEmpty() &&
                                 !controller.activityKinds().contains("agents"), 10000);
        auto *card = findVisualItem(window->contentItem(), "overviewAgents");
        QVERIFY(card);
        auto *codexRow = findVisualItem(card, "overviewAgentRow-codex");
        auto *codexMark = findVisualItem(card, "overviewAgentMark-codex");
        auto *desktopMark = findVisualItem(card, "overviewAgentMark-codexDesktop");
        auto *codexAction = findVisualItem(card, "overviewAgent-codex");
        auto *desktopAction = findVisualItem(card, "overviewAgent-codexDesktop");
        auto *codexLabel = findTextLabel(card, "Codex");
        QVERIFY(codexRow && codexMark && desktopMark && codexAction && desktopAction && codexLabel);
        QTRY_VERIFY(codexRow->isVisible() && codexMark->isVisible() && codexAction->isVisible());

        // Scroll overviewAgents into the viewport before sending scene pointer events.
        auto *scroll = window->findChild<QObject *>("pageScroll");
        auto *viewport = scroll ? qobject_cast<QQuickItem *>(scroll->property("contentItem").value<QObject *>()) : nullptr;
        QVERIFY(viewport);
        const qreal targetY = viewport->property("contentY").toReal() + card->mapToItem(viewport, QPointF()).y() - 24;
        viewport->setProperty("contentY", qBound(0.0, targetY, qMax(0.0, viewport->property("contentHeight").toReal() - viewport->height())));
        QTest::qWait(80);

        const auto cardBounds = card->mapRectToScene(card->boundingRect());
        const auto initialMarkBounds = codexMark->mapRectToScene(codexMark->boundingRect());
        const auto initialDesktopMarkBounds = desktopMark->mapRectToScene(desktopMark->boundingRect());
        const auto initialActionBounds = codexAction->mapRectToScene(codexAction->boundingRect());
        const auto initialLabelBounds = codexLabel->mapRectToScene(codexLabel->boundingRect());
        QVERIFY(qAbs(initialMarkBounds.left() - initialDesktopMarkBounds.left()) <= 1.0);
        QVERIFY(initialLabelBounds.width() > 30);
        QVERIFY(initialActionBounds.right() <= cardBounds.right() + 0.5);

        const QPoint hoverPoint = codexRow->mapRectToScene(codexRow->boundingRect()).center().toPoint();
        QEnterEvent enter(hoverPoint, hoverPoint, window->mapToGlobal(hoverPoint));
        QCoreApplication::sendEvent(window, &enter);
        QMouseEvent move(QEvent::MouseMove, hoverPoint, window->mapToGlobal(hoverPoint), Qt::NoButton, Qt::NoButton, Qt::NoModifier);
        QCoreApplication::sendEvent(window, &move);
        QTest::qWait(100);

        auto *theme = engine.singletonInstance<QObject *>("Orbis.Host", "Theme");
        QVERIFY(theme);
        const QColor surfaceLift = theme->property("surfaceLift").value<QColor>();
        QQuickItem *highlight = nullptr;
        QTRY_VERIFY((highlight = findHoverHighlight(card, surfaceLift)) != nullptr);
        const auto screenshotBase = qEnvironmentVariable("ORBIS_OVERVIEW_HOVER_SCREENSHOT");
        if (!screenshotBase.isEmpty()) {
            window->grabWindow().save(QString("%1-%2.png").arg(screenshotBase).arg(windowWidth));
        }

        const auto hoveredRowBounds = codexRow->mapRectToScene(codexRow->boundingRect());
        const auto hoveredMarkBounds = codexMark->mapRectToScene(codexMark->boundingRect());
        const auto hoveredDesktopMarkBounds = desktopMark->mapRectToScene(desktopMark->boundingRect());
        const auto hoveredActionBounds = codexAction->mapRectToScene(codexAction->boundingRect());
        const auto hoveredDesktopActionBounds = desktopAction->mapRectToScene(desktopAction->boundingRect());
        const auto hoveredLabelBounds = codexLabel->mapRectToScene(codexLabel->boundingRect());
        const auto hoveredCardBounds = card->mapRectToScene(card->boundingRect());

        QVERIFY2(hoveredRowBounds.left() >= hoveredCardBounds.left() - 0.5 && hoveredRowBounds.right() <= hoveredCardBounds.right() + 0.5,
                 qPrintable(QString("Row overflowed card: row=[%1,%2] card=[%3,%4]")
                                .arg(hoveredRowBounds.left()).arg(hoveredRowBounds.right())
                                .arg(hoveredCardBounds.left()).arg(hoveredCardBounds.right())));

        QVERIFY2(highlight != nullptr, "Hover highlight rectangle did not appear");
        const auto highlightBounds = highlight->mapRectToScene(highlight->boundingRect());
        QVERIFY2(highlightBounds.left() >= hoveredCardBounds.left() - 0.5 && highlightBounds.right() <= hoveredCardBounds.right() + 0.5,
                 qPrintable(QString("Hover highlight overflowed card: highlight=[%1,%2] card=[%3,%4]")
                                .arg(highlightBounds.left()).arg(highlightBounds.right())
                                .arg(hoveredCardBounds.left()).arg(hoveredCardBounds.right())));
        QVERIFY2(qAbs(hoveredMarkBounds.left() - hoveredDesktopMarkBounds.left()) <= 1.0,
                 qPrintable(QString("Agent mark shifted on hover: codex=%1 desktop=%2")
                                .arg(hoveredMarkBounds.left()).arg(hoveredDesktopMarkBounds.left())));
        QVERIFY2(hoveredLabelBounds.width() > 30 && hoveredLabelBounds.left() > hoveredMarkBounds.right(),
                 qPrintable(QString("Agent label collapsed/shifted: label=[%1, w=%2] markRight=%3")
                                .arg(hoveredLabelBounds.left()).arg(hoveredLabelBounds.width()).arg(hoveredMarkBounds.right())));
        QVERIFY2(hoveredActionBounds.right() <= hoveredCardBounds.right() + 0.5 &&
                     qAbs(hoveredActionBounds.left() - hoveredDesktopActionBounds.left()) <= 1.0,
                 qPrintable(QString("Action button overflowed/shifted: action=[%1,%2] desktop=%3 cardRight=%4")
                                .arg(hoveredActionBounds.left()).arg(hoveredActionBounds.right())
                                .arg(hoveredDesktopActionBounds.left()).arg(hoveredCardBounds.right())));

        // Clicking the row area (not the status dot or action button) opens that Agent's detail page.
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, hoverPoint);
        QTRY_COMPARE(window->property("page").toInt(), 2);
        QCOMPARE(window->property("selectedAgent").toString(), QString("codex"));

        // AGENT-DIAL-02: Agent-specific settings and twin-agent navigation live inside the Agent detail pane.
        auto *rail = findVisualItem(window->contentItem(), "agentRail");
        auto *detail = findVisualItem(window->contentItem(), "agentDetail");
        auto *integrationSection = findVisualItem(detail, "agentIntegrationSection");
        auto *codexPrestart = findVisualItem(detail, "codexPrestartSwitch");
        auto *twinChip = findVisualItem(detail, "twinAgentChip");
        auto *openProvidersBtn = findVisualItem(detail, "openAgentProviders");
        auto *detailLatch = findVisualItem(detail, "detailAgentLatch");
        auto *detailTitle = findVisualItem(detail, "agentDetailTitle");
        auto *detailVersion = findVisualItem(detail, "agentDetailVersion");
        auto *detailVersionState = findVisualItem(detail, "agentDetailVersionState");
        auto *detailInstall = findVisualItem(detail, "agentDetailInstall");
        auto *detailNotice = findVisualItem(detail, "agentDetailNotice");
        auto *codexRailDot = findVisualItem(rail, "agentRailUpdateDot-codex");
        auto *piRailDot = findVisualItem(rail, "agentRailUpdateDot-pi");
        QVERIFY(rail && detail && integrationSection && codexPrestart && twinChip && openProvidersBtn && detailLatch && detailTitle &&
                detailVersion && detailVersionState && detailInstall && detailNotice && codexRailDot && piRailDot);
        QTRY_VERIFY(integrationSection->isVisible() && codexPrestart->isVisible() && twinChip->isVisible() && openProvidersBtn->isVisible());
        auto *socket = findVisualItem(detailLatch, "agentLatchSocket");
        auto *knobFace = findVisualItem(detailLatch, "agentLatchKnobFace");
        QVERIFY(socket && knobFace);
        QCOMPARE(socket->width(), 26.0);
        QCOMPARE(knobFace->width(), 28.0);
        QVERIFY(knobFace->width() > socket->width());
        auto *latchTheme = engine.singletonInstance<QObject *>("Orbis.Host", "Theme");
        QVERIFY(latchTheme);
        const auto socketTint = QQmlProperty(socket, "border.color").read().value<QColor>();
        QCOMPARE(socketTint, latchTheme->property("agentCodex").value<QColor>());
        const auto knobOutline = QQmlProperty(knobFace, "border.color").read().value<QColor>();
        QCOMPARE(knobOutline, latchTheme->property("hairline").value<QColor>());
        controller.detectAgents(true);
        QTRY_VERIFY(!controller.busy() && !controller.activityKinds().contains("agents") && controller.claudeUpdateAvailable());

        // Version appears directly below the Agent title, while the target update version appears only once on the primary update button.
        QTRY_VERIFY(detailVersion->isVisible() && detailInstall->isVisible() && detailInstall->isEnabled() && detailInstall->property("primary").toBool());
        QCOMPARE(detailVersion->property("text").toString(), QString("· v0.130.0"));
        QCOMPARE(detailInstall->property("text").toString(), QString("更新到 v0.132.0"));
        QVERIFY(codexRailDot->isVisible());
        QVERIFY(!piRailDot->isVisible());
        QVERIFY(findTextLabel(integrationSection, "当前版本") == nullptr);

        // Up-to-date managed CLI (Pi) hides the update button and marks the header version as latest.
        QVERIFY(QMetaObject::invokeMethod(window, "chooseAgent", Q_ARG(QVariant, QString("pi")), Q_ARG(QVariant, 0)));
        QCOMPARE(detailVersion->property("text").toString(), QString("· v0.70.0"));
        QVERIFY(detailVersionState->isVisible());
        QCOMPARE(detailVersionState->property("text").toString(), QString("· 已是最新"));
        QVERIFY(!detailInstall->isVisible());

        // Claude Code uses the exact same header version and single update button presentation as npm CLIs.
        QVERIFY(QMetaObject::invokeMethod(window, "chooseAgent", Q_ARG(QVariant, QString("claude")), Q_ARG(QVariant, 0)));
        QCOMPARE(detailVersion->property("text").toString(), QString("· v2.1.300"));
        QVERIFY(detailInstall->isVisible() && detailInstall->property("primary").toBool());
        QCOMPARE(detailInstall->property("text").toString(), QString("更新到 v2.1.325"));
        QVERIFY(findVisualItem(detail, "claudeVersions") == nullptr);
        QVERIFY(findVisualItem(detail, "updateClaude") == nullptr);

        // DeepSeek Web does not duplicate its recommended update version in a separate compatibility notice line.
        QVERIFY(QMetaObject::invokeMethod(window, "chooseAgent", Q_ARG(QVariant, QString("dsh")), Q_ARG(QVariant, 0)));
        QCOMPARE(detailTitle->property("text").toString(), QString("DeepSeek Web"));
        QCOMPARE(detailVersion->property("text").toString(), QString("· v0.2.0"));
        QVERIFY(detailInstall->isVisible());
        QCOMPARE(detailInstall->property("text").toString(), QString("更新到 v0.2.2"));
        QVERIFY(!detailNotice->isVisible());

        // Hermes and OpenClaw render their connection settings inside the unified agentIntegrationSection.
        QVERIFY(QMetaObject::invokeMethod(window, "chooseAgent", Q_ARG(QVariant, QString("hermes")), Q_ARG(QVariant, 0)));
        QVERIFY(detailVersion->isVisible());
        QCOMPARE(detailVersion->property("text").toString(), QString("· v0.1.4"));
        QVERIFY(integrationSection->isVisible());
        auto *hermesCard = findVisualItem(integrationSection, "hermesRemoteCard");
        QVERIFY(hermesCard && hermesCard->isVisible());

        QVERIFY(QMetaObject::invokeMethod(window, "chooseAgent", Q_ARG(QVariant, QString("openclaw")), Q_ARG(QVariant, 0)));
        QVERIFY(!detailVersion->isVisible());
        QVERIFY(integrationSection->isVisible());
        auto *openClawCard = findVisualItem(integrationSection, "openClawCard");
        QVERIFY(openClawCard && openClawCard->isVisible());

        QVERIFY(QMetaObject::invokeMethod(window, "chooseAgent", Q_ARG(QVariant, QString("codex")), Q_ARG(QVariant, 0)));
        QVERIFY(QMetaObject::invokeMethod(twinChip, "clicked"));
        QCOMPARE(window->property("selectedAgent").toString(), QString("codexDesktop"));
        QCOMPARE(window->property("detailProviderGroup").toString(), QString("codex"));
        QVERIFY(openProvidersBtn->isVisible());
        QVERIFY(QMetaObject::invokeMethod(twinChip, "clicked"));
        QCOMPARE(window->property("selectedAgent").toString(), QString("codex"));

        // DeepSeek Desktop shares the same provider group and inline controls as DeepSeek Web, and shows its version under the title.
        QVERIFY(QMetaObject::invokeMethod(window, "chooseAgent", Q_ARG(QVariant, QString("dshDesktop")), Q_ARG(QVariant, 0)));
        QCOMPARE(window->property("selectedAgent").toString(), QString("dshDesktop"));
        QCOMPARE(window->property("detailProviderGroup").toString(), QString("dsh"));
        QVERIFY(detailVersion->isVisible());
        QCOMPARE(detailVersion->property("text").toString(), QString("· v0.2.2-rc.2"));
        QTRY_VERIFY(openProvidersBtn->isVisible());
        QTRY_COMPARE(controller.providerKind(), QString("dsh"));
        QVERIFY(QMetaObject::invokeMethod(window, "chooseAgent", Q_ARG(QVariant, QString("codex")), Q_ARG(QVariant, 0)));

        // Opening provider configuration inside the two-column Agent page must keep the rail and detail
        // widths stable instead of feeding providerCard's childrenRect width back into RowLayout.
        const qreal railWidthBefore = rail->width();
        const qreal detailWidthBefore = detail->width();
        QVERIFY(QMetaObject::invokeMethod(openProvidersBtn, "clicked"));
        QTRY_COMPARE(window->property("providersOpen").toBool(), true);
        QTRY_COMPARE(controller.providers().size(), 2);
        QQuickItem *officialCard = nullptr;
        QQuickItem *customCard = nullptr;
        QTRY_VERIFY((officialCard = findVisualItem(detail, "providerCard-openai")) && officialCard->isVisible() &&
                    (customCard = findVisualItem(detail, "providerCard-openrouter")) && customCard->isVisible());
        auto *quotaRefresh = findVisualItem(officialCard, "providerManagerQuotaRefresh-openai");
        QVERIFY(quotaRefresh && quotaRefresh->isVisible());
        QCOMPARE(quotaRefresh->property("symbol").toString(), QString("refresh"));
        QCOMPARE(quotaRefresh->property("text").toString(), QString());
        auto *quotaAccessible = QAccessible::queryAccessibleInterface(quotaRefresh);
        QVERIFY(quotaAccessible);
        QCOMPARE(quotaAccessible->text(QAccessible::Name), QString("刷新配额"));
        QTest::qWait(80);
        QVERIFY2(qAbs(rail->width() - railWidthBefore) <= 0.5 && qAbs(detail->width() - detailWidthBefore) <= 0.5,
                 qPrintable(QString("Opening provider cards shifted rail/detail width: rail %1 -> %2, detail %3 -> %4")
                                .arg(railWidthBefore).arg(rail->width())
                                .arg(detailWidthBefore).arg(detail->width())));

        QJsonArray disabledAgents;
        for (const auto &agent : controller.agentEnablement().value("agents").toList()) {
            auto row = agent.toMap();
            if (row.value("kind").toString() == "dsh") row.insert("enabled", false);
            disabledAgents.append(QJsonObject::fromVariantMap(row));
        }
        controller.receiveLine({{"event", "agentEnablement"}, {"snapshot", QJsonObject{{"revision", 2}, {"agents", disabledAgents}}}});
        QVERIFY(QMetaObject::invokeMethod(window, "chooseAgent", Q_ARG(QVariant, QString("dsh")), Q_ARG(QVariant, 0)));
        QCOMPARE(detailTitle->property("text").toString(), QString("DeepSeek Web"));
        auto *inactiveState = findVisualItem(detail, "agentDetailInactiveState");
        auto *enableAction = findVisualItem(detail, "agentDetailEnable");
        QVERIFY(inactiveState && enableAction && inactiveState->isVisible() && enableAction->isVisible());
        QCOMPARE(enableAction->property("text").toString(), QString("启用 DeepSeek Web"));
        QCOMPARE(inactiveState->property("horizontalAlignment").toInt(), int(Qt::AlignHCenter));
        const auto inactiveCenter = inactiveState->mapToItem(inactiveState->parentItem(), inactiveState->boundingRect().center());
        const auto enableCenter = enableAction->mapToItem(enableAction->parentItem(), enableAction->boundingRect().center());
        QVERIFY(qAbs(inactiveCenter.x() - inactiveState->parentItem()->width() / 2) <= 0.5);
        QVERIFY(qAbs(enableCenter.x() - enableAction->parentItem()->width() / 2) <= 0.5);
        QVERIFY(QAccessible::queryAccessibleInterface(enableAction));
        const auto inactiveScreenshot = qEnvironmentVariable("ORBIS_AGENT_INACTIVE_SCREENSHOT");
        if (!inactiveScreenshot.isEmpty()) QVERIFY(window->grabWindow().save(inactiveScreenshot));

        // The switch animation must progress over rendered frames while its asynchronous Host write is pending.
        auto *movingKnob = findVisualItem(detailLatch, "agentLatchMovingKnob");
        QVERIFY(movingKnob);
        engine.rootContext()->setContextProperty("orbisMotionEnabled", true);
        QSignalSpy rendered(window, &QQuickWindow::afterRendering);
        const qreal initialX = movingKnob->x();
        QElapsedTimer pendingFrameWindow;
        pendingFrameWindow.start();
        QVERIFY(QMetaObject::invokeMethod(window, "flipAgent", Q_ARG(QVariant, QString("dsh"))));
        QTest::qWait(80);
        QVERIFY(movingKnob->x() > initialX + 1);
        QVERIFY(movingKnob->x() < 43);
        QVERIFY(rendered.count() > 2);
        qInfo() << "Agent-page switch during pending write:" << rendered.count()
                << "afterRendering frames in" << pendingFrameWindow.elapsed() << "ms; knob moved from"
                << initialX << "to" << movingKnob->x();
        QTRY_VERIFY_WITH_TIMEOUT(movingKnob->x() > 42, 2000);
        auto dshEnabled = [&controller] {
            const auto finalAgents = controller.agentEnablement().value("agents").toList();
            return std::any_of(finalAgents.cbegin(), finalAgents.cend(), [](const QVariant &agent) {
                const auto row = agent.toMap();
                return row.value("kind").toString() == "dsh" && row.value("enabled").toBool();
            });
        };
        QTRY_VERIFY_WITH_TIMEOUT(dshEnabled(), 2000);

        controller.shutdown();
    }
    void runningSessionTitleElidesWithoutMovingDot_data() {
        QTest::addColumn<int>("windowWidth");
        QTest::newRow("compact") << 1020;
        QTest::newRow("default") << 1180;
    }

    // HOST-STATUS-ALIGN-01: a long running-session title must elide, not push its dot between lines.
    void runningSessionTitleElidesWithoutMovingDot() {
        QFETCH(int, windowWidth);
        QVERIFY(!QStandardPaths::findExecutable("node").isEmpty());
        QTemporaryDir root;
        QVERIFY(root.isValid());
        writeFixtureBridge(root.path());
        const QString dataDir = root.filePath("desktop");
        QDir().mkpath(dataDir);
        {
            QSettings appearance(dataDir + "/appearance.ini", QSettings::IniFormat);
            appearance.beginGroup("Appearance");
            appearance.setValue("material", "mist");
            appearance.setValue("mode", "light");
        }
        HostController controller(root.path(), dataDir, root.filePath("state"), dataDir, false);
        controller.m_settings.setValue("relayUrl", "ws://127.0.0.1:1");
        controller.m_tick.stop();
        controller.m_credential = "orbis_host_fixture";

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty("host", &controller);
        engine.rootContext()->setContextProperty("orbisAppearanceSettings", QUrl::fromLocalFile(dataDir + "/appearance.ini"));
        engine.rootContext()->setContextProperty("orbisMotionEnabled", false);
        engine.rootContext()->setContextProperty("trayAvailable", false);
        engine.loadFromModule("Orbis.Host", "Main");
        QVERIFY(!engine.rootObjects().isEmpty());
        auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
        QVERIFY(window);
        window->resize(windowWidth, 900);
        QVERIFY(QTest::qWaitForWindowExposed(window));
        QTRY_VERIFY(controller.bridgeReady() && !controller.agents().isEmpty() &&
                    controller.activeAgentSessions().contains("codexDesktop"));
        auto *content = window->contentItem();
        const auto aligned = [](QQuickItem *row, const QString &textName) {
            auto *dot = findVisualItem(row, "statusDotInk");
            auto *text = findVisualItem(row, textName);
            return row && row->isVisible() && dot && text && text->height() > 0 &&
                   text->property("lineCount").toInt() == 1 &&
                   qAbs(dot->mapToScene(dot->boundingRect().center()).y() -
                        text->mapToScene(text->boundingRect().center()).y()) <= 0.5;
        };
        QTRY_VERIFY(aligned(findVisualItem(content, "hostConnectionStatus"), "statusText"));
        QTRY_VERIFY(aligned(findVisualItem(content, "overviewDeviceStatus"), "statusText"));

        QVERIFY(QMetaObject::invokeMethod(window, "goAgent", Q_ARG(QVariant, QString("codexDesktop"))));
        QTRY_COMPARE(window->property("page").toInt(), 2);
        QQuickItem *shortRow = nullptr;
        QQuickItem *longRow = nullptr;
        QTRY_VERIFY((shortRow = findVisualItem(content, "agentRunningSession-0")) && shortRow->isVisible() &&
                    (longRow = findVisualItem(content, "agentRunningSession-1")) && longRow->isVisible());
        QTRY_VERIFY(aligned(shortRow, "statusText") && aligned(longRow, "statusText"));
        QCOMPARE(shortRow->height(), longRow->height());
        QVERIFY(!shortRow->property("statusTruncated").toBool());
        auto *longText = findVisualItem(longRow, "statusText");
        QVERIFY(longText);
        QTRY_VERIFY2(longRow->property("statusTruncated").toBool(),
                     qPrintable(QString("long row %1, label %2, implicit %3, content %4")
                                    .arg(longRow->width()).arg(longText->width()).arg(longText->implicitWidth())
                                    .arg(longText->property("contentWidth").toReal())));
        QVERIFY(longRow->property("text").toString().endsWith("deliberately long session title"));

        const auto screenshotBase = qEnvironmentVariable("ORBIS_HOST_STATUS_ALIGNMENT_SCREENSHOT");
        if (!screenshotBase.isEmpty()) {
            QVERIFY(window->grabWindow().save(QString("%1-%2.png").arg(screenshotBase).arg(windowWidth)));
        }

        // HOST-RUNNING-01: every agent uses the same state, count and session pane, even
        // for a native-only running session with no mobile runtime. Idle and paused hide it.
        QJsonObject running;
        const QStringList kinds{"pi", "codex", "codexDesktop", "claude", "dsh", "dshDesktop", "kimiCode", "opencode", "hermes", "openclaw"};
        controller.m_openClaw.insert("url", "ws://127.0.0.1:18789");
        for (const auto &kind : kinds)
            running.insert(kind, QJsonObject{{"total", 1}, {"sessions", QJsonArray{kind + " test turn"}}});
        controller.receiveLine({{"event", "status"}, {"activeAgentSessions", running}});
        auto *pane = findVisualItem(content, "agentRunningSessions");
        auto *detailState = findVisualItem(content, "agentDetailState");
        QVERIFY(pane && detailState);
        for (const auto &kind : kinds) {
            QVERIFY(QMetaObject::invokeMethod(window, "goAgent", Q_ARG(QVariant, kind)));
            auto *rail = findVisualItem(content, "agent-rail-" + kind);
            QVERIFY(rail);
            QTRY_VERIFY(pane->isVisible());
            QCOMPARE(detailState->property("text").toString(), QString("已连接，1 个运行中"));
            QCOMPARE(rail->property("subText").toString(), detailState->property("text").toString());
            auto *session = findVisualItem(pane, "agentRunningSession-0");
            QVERIFY(session);
            QCOMPARE(session->property("text").toString(), kind + " test turn");
        }
        controller.receiveLine({{"event", "status"}, {"activeAgentSessions", QJsonObject{}}});
        QVERIFY(!pane->isVisible());
        controller.receiveLine({{"event", "status"}, {"activeAgentSessions", running}});
        QVERIFY(pane->isVisible());
        controller.receiveLine({{"event", "state"}, {"state", "reconnecting"}});
        QVERIFY(!pane->isVisible());
        controller.receiveLine({{"event", "state"}, {"state", "connected"}});
        QVERIFY(!pane->isVisible()); // A state event alone cannot revive stale running facts.
        controller.receiveLine({{"event", "status"}, {"activeAgentSessions", running}});
        QVERIFY(pane->isVisible());

        // HOST-DESKTOP-STATUS-01: overview routes Codex details to Agent; both desktop integrations are described there, not in diagnostics.
        QVERIFY(QMetaObject::invokeMethod(window, "goAgent", Q_ARG(QVariant, QString("codexDesktop"))));
        auto *codexIntegrationStatus = findVisualItem(content, "codexDesktopIntegrationStatus");
        QTRY_VERIFY(codexIntegrationStatus && codexIntegrationStatus->isVisible());
        QCOMPARE(codexIntegrationStatus->property("text").toString(), QString("已接入"));
        auto *codexIntegrationReason = findVisualItem(content, "codexDesktopIntegrationReason");
        QVERIFY(codexIntegrationReason);
        QVERIFY(!codexIntegrationReason->isVisible());

        QVERIFY(QMetaObject::invokeMethod(window, "goAgent", Q_ARG(QVariant, QString("dshDesktop"))));
        auto *dshIntegrationStatus = findVisualItem(content, "dshDesktopIntegrationStatus");
        auto *dshIntegrationReason = findVisualItem(content, "dshDesktopIntegrationReason");
        QTRY_VERIFY(dshIntegrationStatus && dshIntegrationStatus->isVisible());
        QCOMPARE(dshIntegrationStatus->property("text").toString(), QString("已接入"));
        QTRY_VERIFY(dshIntegrationReason && dshIntegrationReason->isVisible());
        QCOMPARE(dshIntegrationReason->property("text").toString(), QString("已接入 DeepSeek 桌面版 0.2.2-rc.2"));

        QVERIFY(QMetaObject::invokeMethod(window, "selectPage", Q_ARG(QVariant, 4)));
        QVERIFY(!findVisualItem(content, "codexDesktopAttach"));
        QVERIFY(!findVisualItem(content, "dshDesktopAttach"));
        controller.shutdown();
    }

    void gatewayConnectionModeIsExclusiveAndAppliesExplicitly_data() {
        QTest::addColumn<bool>("hermes");
        QTest::newRow("Hermes") << true;
        QTest::newRow("OpenClaw") << false;
    }

    // HOST-GATEWAY-MODE-01: click and keyboard selection edit one draft, not two connections.
    void gatewayConnectionModeIsExclusiveAndAppliesExplicitly() {
        QFETCH(bool, hermes);
        QVERIFY(!QStandardPaths::findExecutable("node").isEmpty());
        QTemporaryDir root;
        QVERIFY(root.isValid());
        writeFixtureBridge(root.path());
        const QString dataDir = root.filePath("desktop");
        QDir().mkpath(dataDir);
        HostController controller(root.path(), dataDir, root.filePath("state"), dataDir, false);
        controller.m_settings.setValue("relayUrl", "ws://127.0.0.1:1");
        controller.m_tick.stop();
        controller.m_credential = "orbis_host_fixture";

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty("host", &controller);
        engine.rootContext()->setContextProperty("orbisAppearanceSettings", QUrl::fromLocalFile(dataDir + "/appearance.ini"));
        engine.rootContext()->setContextProperty("orbisMotionEnabled", false);
        engine.rootContext()->setContextProperty("trayAvailable", false);
        engine.loadFromModule("Orbis.Host", "Main");
        QVERIFY(!engine.rootObjects().isEmpty());
        auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
        QVERIFY(window);
        QVERIFY(QTest::qWaitForWindowExposed(window));
        QTRY_VERIFY(controller.bridgeReady() && !controller.busy() && !controller.agents().isEmpty());
        const QString localUrl = "ws://127.0.0.1:18789";
        const QString remoteTarget = hermes ? "ssh.example.test" : "wss://gateway.example.test";
        if (!hermes) {
            controller.m_openClaw.insert("url", localUrl);
            emit controller.openClawChanged();
        }
        QVERIFY(QMetaObject::invokeMethod(window, "goAgent", Q_ARG(QVariant, hermes ? QString("hermes") : QString("openclaw"))));

        const QString pickerName = hermes ? "hermesMode" : "openClawMode";
        auto *picker = findVisualItem(window->contentItem(), pickerName);
        auto *local = findVisualItem(picker, pickerName + "-0");
        auto *remote = findVisualItem(picker, pickerName + "-1");
        auto *remoteField = findVisualItem(window->contentItem(), hermes ? "hermesSshHost" : "openClawUrl");
        auto *apply = findVisualItem(window->contentItem(), hermes ? "applyHermesRemote" : "applyOpenClaw");
        QVERIFY(picker && local && remote && remoteField && apply);
        QTRY_VERIFY(local->isVisible() && local->isEnabled() && local->property("checked").toBool());
        auto *remoteAccess = QAccessible::queryAccessibleInterface(remote);
        QVERIFY(remoteAccess);
        QCOMPARE(remoteAccess->role(), QAccessible::RadioButton);
        QVERIFY(!remote->property("checked").toBool() && !remoteField->isVisible() && !apply->isEnabled());
        auto click = [window](QQuickItem *item) {
            QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, item->mapToScene(item->boundingRect().center()).toPoint());
        };
        auto savedTarget = [&controller, hermes] {
            return hermes ? controller.hermesRemote().value("host").toString()
                          : controller.openClaw().value("url").toString();
        };

        click(remote);
        QTRY_VERIFY(remote->property("checked").toBool() && remoteField->isVisible());
        QVERIFY(!local->property("checked").toBool());
        click(remote); // Clicking the selected radio cannot deselect both modes.
        QVERIFY(remote->property("checked").toBool() && !local->property("checked").toBool());
        QVERIFY(!apply->isEnabled()); // No remote target yet.
        QVERIFY(remoteField->setProperty("text", remoteTarget));
        QTRY_VERIFY(apply->isEnabled());
        QCOMPARE(savedTarget(), hermes ? QString() : localUrl);
        if (hermes) {
            auto *state = findVisualItem(window->contentItem(), "hermesConnectionState");
            QVERIFY(state);
            QCOMPARE(state->property("text").toString(), QString("当前：本机"));
        }
        const auto screenshotBase = qEnvironmentVariable("ORBIS_GATEWAY_MODE_SCREENSHOT");
        if (!screenshotBase.isEmpty()) {
            QVERIFY(window->grabWindow().save(screenshotBase + (hermes ? "-hermes.png" : "-openclaw.png")));
        }

        click(apply);
        QTRY_COMPARE(savedTarget(), remoteTarget);
        QTRY_VERIFY(!controller.busy() && local->isEnabled() && !apply->isEnabled());
        QVERIFY(remote->property("checked").toBool() && !local->property("checked").toBool());
        local->forceActiveFocus(Qt::TabFocusReason);
        QTest::keyClick(window, Qt::Key_Space);
        QTRY_VERIFY(local->property("checked").toBool() && !remoteField->isVisible());
        QVERIFY(!remote->property("checked").toBool() && apply->isEnabled());
        QCOMPARE(savedTarget(), remoteTarget);
        click(apply);
        QTRY_COMPARE(savedTarget(), hermes ? QString() : localUrl);
        QTRY_VERIFY(!controller.busy() && local->isEnabled() && !apply->isEnabled());
        QVERIFY(local->property("checked").toBool() && !remote->property("checked").toBool());
        if (hermes) {
            controller.m_hermesRemote.insert("source", "environment");
            controller.m_hermesRemote.insert("host", remoteTarget);
            emit controller.hermesRemoteChanged();
        } else {
            controller.m_openClaw.insert("source", "environment");
            controller.m_openClaw.insert("url", remoteTarget);
            emit controller.openClawChanged();
        }
        QTRY_VERIFY(remote->property("checked").toBool() && !local->property("checked").toBool());
        QVERIFY(!remote->isEnabled() && !local->isEnabled() && !apply->isVisible());
        controller.shutdown();
    }
};
QTEST_MAIN(OverviewRowHoverTest)
#include "OverviewRowHoverTest.moc"
