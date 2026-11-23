#include "../HostController.h"
#include "../NeuSurface.h"
#include <QAccessible>
#include <QDir>
#include <QEnterEvent>
#include <QFile>
#include <QMouseEvent>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickItem>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QSettings>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QtTest>

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
  { kind: "dsh", label: "DeepSeek Harness", enabled: true },
  { kind: "dshDesktop", label: "DeepSeek 桌面版", enabled: true },
  { kind: "kimiCode", label: "Kimi Code", enabled: true },
  { kind: "opencode", label: "OpenCode", enabled: true },
  { kind: "hermes", label: "Hermes Agent", enabled: true },
  { kind: "openclaw", label: "OpenClaw", enabled: true }
];
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") {
    out({
      id,
      result: {
        hostId: "fixture-host",
        hostName: "Fixture",
        devices: [{ deviceId: "phone-1", label: "iPhone", path: "relay", createdAt: 1 }],
        agentEnablement: { revision: 1, agents },
        openClaw: { source: "file", url: "", hasToken: false },
        hermesRemote: { source: "file", host: "", port: 22, profile: "" }
      }
    });
    out({ event: "state", state: "connected" });
    out({ event: "claudeStatus", installed: true, compatible: true, version: "2.1.300", minimumVersion: "2.1.287" });
    out({ event: "codexDesktop", status: { state: "attached", reason: "" } });
    out({
      event: "status",
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
              { kind: "hermes", ready: true, launchable: true, runtimeCount: 0 }
            ]
          }
        }]
      }
    });
    return;
  }
  if (method === "detect") {
    out({
      id,
      result: [
        { kind: "pi", installed: true },
        { kind: "codex", installed: true, desktopInstalled: true },
        { kind: "dsh", installed: true, desktopInstalled: true }
      ]
    });
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

        const QPoint hoverPoint(qRound(cardBounds.left() + 140), qRound(initialMarkBounds.center().y()));
        QEnterEvent enter(hoverPoint, hoverPoint, window->mapToGlobal(hoverPoint));
        QCoreApplication::sendEvent(window, &enter);
        QMouseEvent move(QEvent::MouseMove, hoverPoint, window->mapToGlobal(hoverPoint), Qt::NoButton, Qt::NoButton, Qt::NoModifier);
        QCoreApplication::sendEvent(window, &move);
        QTest::qWait(100);

        auto *theme = engine.singletonInstance<QObject *>("Orbis.Host", "Theme");
        QVERIFY(theme);
        const QColor surfaceLift = theme->property("surfaceLift").value<QColor>();
        auto *highlight = findHoverHighlight(card, surfaceLift);
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
        QVERIFY(rail && detail && integrationSection && codexPrestart && twinChip && openProvidersBtn);
        QTRY_VERIFY(integrationSection->isVisible() && codexPrestart->isVisible() && twinChip->isVisible() && openProvidersBtn->isVisible());
        QVERIFY(QMetaObject::invokeMethod(twinChip, "clicked"));
        QCOMPARE(window->property("selectedAgent").toString(), QString("codexDesktop"));
        QCOMPARE(window->property("detailProviderGroup").toString(), QString("codex"));
        QVERIFY(openProvidersBtn->isVisible());
        QVERIFY(QMetaObject::invokeMethod(twinChip, "clicked"));
        QCOMPARE(window->property("selectedAgent").toString(), QString("codex"));

        // DeepSeek Desktop shares the same provider group and inline controls as DeepSeek CLI.
        QVERIFY(QMetaObject::invokeMethod(window, "chooseAgent", Q_ARG(QVariant, QString("dshDesktop")), Q_ARG(QVariant, 0)));
        QCOMPARE(window->property("selectedAgent").toString(), QString("dshDesktop"));
        QCOMPARE(window->property("detailProviderGroup").toString(), QString("dsh"));
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
        QTest::qWait(80);
        QVERIFY2(qAbs(rail->width() - railWidthBefore) <= 0.5 && qAbs(detail->width() - detailWidthBefore) <= 0.5,
                 qPrintable(QString("Opening provider cards shifted rail/detail width: rail %1 -> %2, detail %3 -> %4")
                                .arg(railWidthBefore).arg(rail->width())
                                .arg(detailWidthBefore).arg(detail->width())));

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

        QVERIFY(QMetaObject::invokeMethod(window, "selectPage", Q_ARG(QVariant, 4)));
        QTRY_VERIFY(aligned(findVisualItem(content, "codexDesktopAttachStatus"), "codexDesktopAttachLabel"));
        QTRY_VERIFY(aligned(findVisualItem(content, "dshDesktopAttachStatus"), "statusText"));
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
