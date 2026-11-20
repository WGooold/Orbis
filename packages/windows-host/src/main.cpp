#include "HostController.h"
#include "QaActivation.h"
#include "ExitGuard.h"
#include <QApplication>
#include <QCommandLineParser>
#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonArray>
#include <QLocalServer>
#include <QLocalSocket>
#include <QLockFile>
#include <QPointer>
#include <QMenu>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include <QQmlProperty>
#include "MotionPreferences.h"
#include <QQuickWindow>
#include <QTcpServer>
#include <QTcpSocket>
#ifdef ORBIS_SMOKE_INTERACTION
#include <QQuickItem>
#include <QQuickItemGrabResult>
#include <QMouseEvent>
#include <QEnterEvent>
#include <QTest>
static QQuickItem *findVisualItem(QQuickItem *root, const QString &name) {
    if (root->objectName() == name) return root;
    for (auto *child : root->childItems()) if (auto *match = findVisualItem(child, name)) return match;
    return nullptr;
}
static bool clickSmokeItem(QQuickWindow *window, const QString &name, bool reveal = false) {
    auto *item = findVisualItem(window->contentItem(), name);
    if (!item) return false;
    if (reveal) {
        auto *scroll = window->findChild<QObject *>("providerFormScroll");
        auto *viewport = scroll ? qobject_cast<QQuickItem *>(scroll->property("contentItem").value<QObject *>()) : nullptr;
        if (!viewport) return false;
        const auto y = viewport->property("contentY").toReal() + item->mapToItem(viewport, QPointF()).y() - viewport->height() / 3;
        viewport->setProperty("contentY", qBound(0.0, y, qMax(0.0, viewport->property("contentHeight").toReal() - viewport->height())));
        QTest::qWait(80);
    }
    QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, item->mapToScene(QPointF(item->width() / 2, item->height() / 2)).toPoint());
    return true;
}
#endif
#include <QStandardPaths>
#include <QSystemTrayIcon>
#include <cstdio>

int main(int argc, char *argv[]) {
    qInstallMessageHandler([](QtMsgType, const QMessageLogContext &, const QString &message) {
        std::fprintf(stderr, "%s\n", message.toUtf8().constData()); std::fflush(stderr);
    });
    QApplication app(argc, argv);
    app.setOrganizationName("Orbis");
#ifdef ORBIS_QA_BUILD
    app.setApplicationName("Orbis Host QA");
#else
    app.setApplicationName("Orbis Host");
#endif
    app.setApplicationVersion(ORBIS_VERSION);
#ifdef Q_OS_MACOS
    app.setWindowIcon(QIcon(":/src/assets/orbis-macos.png"));
#else
    app.setWindowIcon(QIcon(":/src/assets/orbis.png"));
#endif
    QQuickStyle::setStyle("Basic");
    // Reliable scaling and soft surfaces on integrated graphics and Windows Remote Desktop.
    QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
    QCommandLineParser parser; parser.addHelpOption(); parser.addVersionOption();
    parser.addOption({"runtime-root", "Host runtime directory (development only)", "path"});
    parser.addOption({"data-dir", "Isolated desktop settings directory", "path"});
    parser.addOption({"host-state-dir", "Isolated Host identity directory", "path"});
    parser.addOption({"tray", "Start in the system tray"});
    parser.addOption({"prepare-update", "Confirm stopping managed backgrounds before an installer proceeds"});
    parser.addOption({"prepare-update-confirmed", "Stop managed backgrounds after confirmation in the installer"});
    parser.addOption({"smoke-test", "Render the window and exit after checking the Host bridge"});
    parser.addOption({"smoke-motion", "Check intermediate sidebar and metric motion in the isolated smoke window"});
    parser.addOption({"smoke-appearance", "Check all four appearance palettes in isolated settings"});
    parser.addOption({"smoke-compact", "Run the smoke test at the minimum window size"});
    parser.addOption({"screenshot", "Save the smoke-test window image", "path"});
    parser.addOption({"smoke-providers", "Also render provider list and editor using isolated smoke-test data"});
    parser.addOption({"smoke-agent-entry", "Check overview CLI recovery status, hover hint, and path dialog with isolated data"});
    parser.addOption({"smoke-agents", "Also render Agent installation dialogs without starting downloads"});
    parser.addOption({"smoke-exit", "Verify exit and update confirmation cancellation in the isolated smoke window"});
    parser.addOption({"smoke-exit-entry", "Quit entry used by the isolated exit regression (native or tray)", "entry", "native"});
    parser.addOption({"smoke-kimi", "Check Kimi settings with an isolated fixture bridge"});
#ifdef ORBIS_SMOKE_INTERACTION
    parser.addOption({"smoke-modal-lighting", "Check a provider menu and stacked confirmation using a fixture bridge"});
#endif
    parser.addOption({"smoke-guide", "Walk the overview through activation, connection, pairing and open steps with synthetic bridge events"});
    parser.process(app);
    QString runtimeRoot = parser.value("runtime-root");
    if (runtimeRoot.isEmpty()) {
#ifdef Q_OS_MACOS
        runtimeRoot = app.applicationDirPath() + "/../Resources/runtime";
#else
        runtimeRoot = app.applicationDirPath() + "/runtime";
#endif
    }
    runtimeRoot = QDir(runtimeRoot).absolutePath();
    const auto sharedDataDir = QDir(QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation)).absolutePath();
    QString dataDir = parser.value("data-dir");
#ifdef ORBIS_QA_BUILD
    QString qaError;
    const auto qaActivation = QaActivation::load(runtimeRoot, &qaError);
    if (!qaActivation) { std::fprintf(stderr, "%s\n", qPrintable(qaError)); return 5; }
    if (dataDir.isEmpty()) dataDir = sharedDataDir + '/' + qaActivation->environmentId;
#else
    if (dataDir.isEmpty()) dataDir = sharedDataDir;
#endif
    dataDir = QDir(dataDir).absolutePath(); QDir().mkpath(dataDir);
    // Normal launches from a portable package and an installed package share
    // one user credential store. Smoke tests keep their explicitly isolated
    // data and credentials so they cannot touch the user's activated Host.
    const auto credentialDir =
#ifdef ORBIS_QA_BUILD
        dataDir;
#else
        parser.isSet("smoke-test") ? dataDir : sharedDataDir;
#endif
    if (parser.isSet("smoke-test")) qputenv("ORBIS_NO_KEYCHAIN", "1");
    if (parser.isSet("smoke-test") && parser.isSet("smoke-providers")) qputenv("ORBIS_PROVIDER_TEST_ROOT", (dataDir + "/test-agents").toUtf8());
    const auto serverName = "OrbisHost-" + QString::fromLatin1(QCryptographicHash::hash(dataDir.toUtf8(), QCryptographicHash::Sha256).toHex().left(24));
    const auto installerServerName = "OrbisSetup-" + serverName.right(24);
    QLockFile lock(dataDir + "/desktop.lock"); lock.setStaleLockTime(0);
    if (!lock.tryLock(100)) {
        const bool confirmed = parser.isSet("prepare-update-confirmed");
        // A separate endpoint cannot accidentally activate an older portable Host which
        // treats unknown commands as "show window". Setup falls back to manual closure.
        QLocalSocket other; other.connectToServer(confirmed ? installerServerName : serverName);
        if (confirmed || parser.isSet("prepare-update")) {
            if (!other.waitForConnected(2000)) return confirmed ? 1 : 20;
            other.write("prepare-update\n"); other.waitForBytesWritten(1000);
            QByteArray result = other.readAll();
            while (!result.contains('\n') && other.waitForReadyRead(180000)) result += other.readAll();
            return result.trimmed() == "ready" ? 0 : 20;
        }
        if (other.waitForConnected(2000)) { other.write("activate\n"); other.waitForBytesWritten(1000); }
        return 0;
    }
    QLocalServer instance; instance.setSocketOptions(QLocalServer::UserAccessOption);
    if (!instance.listen(serverName)) return 2;
    QString hostStateDir = parser.value("host-state-dir");
#ifdef ORBIS_QA_BUILD
    if (hostStateDir.isEmpty()) hostStateDir = dataDir + "/host";
#endif
    if (parser.isSet("smoke-test") && hostStateDir.isEmpty()) hostStateDir = dataDir + "/test-host";
    HostController controller(QDir(runtimeRoot).absolutePath(), dataDir, hostStateDir, credentialDir, !parser.isSet("smoke-test"));
    if (parser.isSet("prepare-update-confirmed")) {
        // HOST-UPDATE-03: no QML engine, tray or core is created for installer-only cleanup.
        app.setQuitOnLastWindowClosed(false);
        QObject::connect(&controller, &HostController::exitReady, &app, [&] { app.exit(0); }, Qt::QueuedConnection);
        QObject::connect(&controller, &HostController::exitFailed, &app, [&] {
            std::fprintf(stderr, "%s\n", qPrintable(controller.message())); app.exit(20);
        }, Qt::QueuedConnection);
        controller.prepareInstallerExit();
        return app.exec();
    }
    if (parser.isSet("prepare-update")) controller.deferStartup();
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("host", &controller);
    engine.rootContext()->setContextProperty("orbisAppearanceSettings", QUrl::fromLocalFile(dataDir + "/appearance.ini"));
    auto motionEnabled = [] { return systemMotionEnabled() && !qEnvironmentVariableIsSet("ORBIS_REDUCE_MOTION"); };
    bool previousMotionEnabled = motionEnabled();
    engine.rootContext()->setContextProperty("orbisMotionEnabled", previousMotionEnabled);
    QTimer motionPreferences;
    QObject::connect(&motionPreferences, &QTimer::timeout, &engine, [&] {
        const bool enabled = motionEnabled();
        if (enabled == previousMotionEnabled) return;
        previousMotionEnabled = enabled;
        engine.rootContext()->setContextProperty("orbisMotionEnabled", enabled);
    });
    motionPreferences.start(1000);
    engine.rootContext()->setContextProperty("trayAvailable", QSystemTrayIcon::isSystemTrayAvailable());
    engine.loadFromModule("Orbis.Host", "Main");
    if (engine.rootObjects().isEmpty()) return 3;
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    if (!window) return 4;
    window->setTitle(app.applicationName());
    auto show = [window] { window->showNormal(); window->raise(); window->requestActivate(); };
    QPointer<QLocalSocket> installerClient;
    const auto replyInstaller = [&](const QByteArray &reply) {
        if (installerClient) { installerClient->write(reply + '\n'); installerClient->flush(); installerClient->disconnectFromServer(); installerClient.clear(); }
    };
    QLocalServer installerInstance; installerInstance.setSocketOptions(QLocalServer::UserAccessOption);
    if (!installerInstance.listen(installerServerName)) return 2;
    const auto acceptConnections = [&](QLocalServer &server, bool confirmed) {
        while (auto *socket = server.nextPendingConnection()) {
            QObject::connect(socket, &QLocalSocket::disconnected, socket, &QObject::deleteLater);
            const auto receive = [&, socket, confirmed] {
                if (socket->bytesAvailable() > 1024) { socket->disconnectFromServer(); return; }
                if (!socket->canReadLine()) return;
                const auto command = socket->readLine().trimmed();
                if (command == "prepare-update") {
                    if (installerClient || controller.exitApproved()) { socket->write("busy\n"); socket->disconnectFromServer(); return; }
                    installerClient = socket;
                    if (confirmed) controller.confirmExit();
                    else controller.requestInstallerExit();
                } else { if (!confirmed) show(); socket->disconnectFromServer(); }
            };
            QObject::connect(socket, &QLocalSocket::readyRead, &app, receive);
            if (socket->canReadLine()) receive();
        }
    };
    QObject::connect(&instance, &QLocalServer::newConnection, &app, [&] { acceptConnections(instance, false); });
    QObject::connect(&installerInstance, &QLocalServer::newConnection, &app, [&] { acceptConnections(installerInstance, true); });
    QObject::connect(&controller, &HostController::exitReady, &app, [&] { replyInstaller("ready"); });
    QObject::connect(&controller, &HostController::exitCancelled, &app, [&] { replyInstaller("cancelled"); if (parser.isSet("prepare-update")) app.exit(20); });
    // HOST-EXIT-06: a failed cleanup keeps the Host running; bring its reason to the front.
    QObject::connect(&controller, &HostController::exitFailed, &app, [&] { replyInstaller("failed"); show(); });
    QSystemTrayIcon tray(QIcon(":/src/assets/orbis.png"));
    QMenu menu;
    menu.addAction("打开 Orbis", &app, show);
    menu.addAction("添加手机", &controller, [&controller, show] { show(); controller.pair(); });
    menu.addSeparator();
    menu.addAction("开始连接", &controller, &HostController::startHost);
    menu.addAction("暂停连接", &controller, &HostController::stopHost);
    menu.addSeparator();
    auto *exitAction = menu.addAction("退出 Orbis", &controller, &HostController::requestExit);
    tray.setContextMenu(&menu); tray.setToolTip(app.applicationName());
    if (QSystemTrayIcon::isSystemTrayAvailable()) { app.setQuitOnLastWindowClosed(false); tray.show(); }
    QObject::connect(&tray, &QSystemTrayIcon::activated, &app, [show](QSystemTrayIcon::ActivationReason reason) { if (reason == QSystemTrayIcon::Trigger || reason == QSystemTrayIcon::DoubleClick) show(); });
    QObject::connect(&controller, &HostController::notification, &tray, [&tray](const QString &title, const QString &body) { tray.showMessage(title, body, QSystemTrayIcon::Information, 4000); });
    QObject::connect(&app, &QApplication::aboutToQuit, &controller, &HostController::shutdown);
    ExitGuard exitGuard([&] { return controller.exitApproved(); }, [&] { controller.requestExit(); });
    app.installEventFilter(&exitGuard);
    QObject::connect(&controller, &HostController::exitReady, &app, [&] {
        // Cleanup and user confirmation are already complete. Finish the event loop instead
        // of asking the native platform to approve Quit a second time.
        tray.hide();
        window->close();
        QCoreApplication::exit(0);
    }, Qt::QueuedConnection);
    if (parser.isSet("prepare-update")) QTimer::singleShot(0, &controller, &HostController::requestInstallerExit);
    if (parser.isSet("tray") && QSystemTrayIcon::isSystemTrayAvailable() && !parser.isSet("smoke-test")) window->hide();
    QString smokeModelUrl;
    int smokePiModelCount = 0;
    const auto requestSmokeExit = [&] {
        if (parser.value("smoke-exit-entry") == "tray") exitAction->trigger();
        else QCoreApplication::quit();
    };
    if (parser.isSet("smoke-test")) {
        if (parser.isSet("smoke-providers")) {
            auto *models = new QTcpServer(&app);
            if (!models->listen(QHostAddress::LocalHost, 0)) return 23;
            smokeModelUrl = QString("http://127.0.0.1:%1/v1").arg(models->serverPort());
            QObject::connect(models, &QTcpServer::newConnection, &app, [models] {
                while (auto *socket = models->nextPendingConnection()) {
                    QObject::connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
                    QObject::connect(socket, &QTcpSocket::readyRead, socket, [socket] {
                        const auto request = socket->property("request").toByteArray() + socket->readAll();
                        socket->setProperty("request", request);
                        if (!request.contains("\r\n\r\n")) return;
                        const bool valid = request.startsWith("GET /v1/models ") && request.toLower().contains("authorization: bearer smoke-only");
                        const QByteArray body = valid ? R"({"data":[{"id":"smoke-a","displayName":"Model A"},{"id":"smoke-b","displayName":"Model B"}]})" : R"({"error":"invalid smoke request"})";
                        socket->write(QByteArray("HTTP/1.1 ") + (valid ? "200 OK" : "403 Forbidden") + "\r\nContent-Type: application/json\r\nContent-Length: " + QByteArray::number(body.size()) + "\r\nConnection: close\r\n\r\n" + body);
                        socket->disconnectFromHost();
                    });
                }
            });
        }
        if (parser.isSet("smoke-compact")) window->resize(window->minimumSize());
        QTimer::singleShot(8000, Qt::PreciseTimer, &app, [&] {
            bool imageOk = true;
            if (parser.isSet("screenshot") && !parser.isSet("smoke-kimi")) imageOk = window->grabWindow().save(parser.value("screenshot"));
            QFile report(dataDir + "/smoke-result.json");
            if (report.open(QIODevice::WriteOnly)) report.write(QJsonDocument(QJsonObject{{"bridgeReady", controller.bridgeReady()}, {"windowVisible", window->isVisible()}, {"screenshotSaved", imageOk}, {"message", controller.message()}, {"claudeInstalled", controller.claudeInstalled()}, {"agents", QJsonArray::fromVariantList(controller.agents())}}).toJson());
            if (!controller.bridgeReady() || !imageOk) { app.exit(5); return; }
#ifdef ORBIS_SMOKE_INTERACTION
            if (parser.isSet("smoke-agent-entry")) {
                // HOST-CLI-DISCOVERY-01: the help belongs to the settled status dot,
                // never a pending detection or a healthy CLI on a stopped Host.
                controller.smokeReceive({{"event", "claudeStatus"}, {"detecting", true}});
                QTest::qWait(80);
                auto *pending = findVisualItem(window->contentItem(), "overviewAgentState-claude");
                if (pending && pending->isVisible()) { app.exit(93); return; }
                controller.smokeReceive({{"event", "claudeStatus"}, {"installed", false}, {"cliIssue", "missing"}});
                controller.smokeAgents({QVariantMap{{"kind", "pi"}, {"installed", true}},
                    QVariantMap{{"kind", "codex"}, {"installed", false}, {"installedButBroken", true}, {"cliIssue", "unrunnable"}}});
                QTest::qWait(100);
                auto *healthy = findVisualItem(window->contentItem(), "overviewAgentState-pi");
                auto *missing = findVisualItem(window->contentItem(), "overviewAgentState-claude");
                auto *broken = findVisualItem(window->contentItem(), "overviewAgentState-codex");
                if (!healthy || healthy->property("canEdit").toBool() || !missing || !missing->isVisible() ||
                    !missing->property("detail").toString().contains("未在终端") || !broken || !broken->isVisible() ||
                    !broken->property("detail").toString().contains("无法运行")) { app.exit(94); return; }
                auto *scroll = window->findChild<QObject *>("pageScroll");
                auto *viewport = scroll ? qobject_cast<QQuickItem *>(scroll->property("contentItem").value<QObject *>()) : nullptr;
                if (!viewport) { app.exit(95); return; }
                const auto y = viewport->property("contentY").toReal() + broken->mapToItem(viewport, QPointF()).y() - viewport->height() / 2;
                viewport->setProperty("contentY", qBound(0.0, y, qMax(0.0, viewport->property("contentHeight").toReal() - viewport->height())));
                QTest::qWait(100);
                const auto target = broken->mapToScene(QPointF(broken->width() - 6, broken->height() / 2)).toPoint();
                // Offscreen Qt can omit the platform mouse-enter packet. Deliver
                // the scene-positioned move through Qt's normal window dispatch.
                QEnterEvent enter(target, target, window->mapToGlobal(target));
                QCoreApplication::sendEvent(window, &enter);
                QMouseEvent move(QEvent::MouseMove, target, window->mapToGlobal(target), Qt::NoButton, Qt::NoButton, Qt::NoModifier);
                QCoreApplication::sendEvent(window, &move);
                QTest::qWait(420);
                if (!broken->property("hintVisible").toBool()) {
                    qWarning() << "Agent status hover failed" << target << window->size();
                    app.exit(96); return;
                }
                if (!clickSmokeItem(window, "overviewAgentState-codex")) { app.exit(97); return; }
                QTest::qWait(250);
                auto *dialog = window->findChild<QObject *>("agentEntryDialog");
                if (!dialog || !dialog->property("visible").toBool() || dialog->property("kind").toString() != "codex" ||
                    !findVisualItem(window->contentItem(), "agentEntryPath")) { app.exit(98); return; }
                app.exit(0);
                return;
            }
            if (parser.isSet("smoke-kimi")) {
                // KIMI-10: the fixture advertises an inherited opt-in; render observed status on the settings page.
                controller.smokeActivation(true);
                controller.smokeReceive({{"event", "status"}, {"kimiCodeState", "connected"}});
                QMetaObject::invokeMethod(window, "selectPage", Q_ARG(QVariant, 3));
                QTimer::singleShot(400, &app, [&] {
                    auto *toggle = findVisualItem(window->contentItem(), "kimiCodeSwitch");
                    auto *status = findVisualItem(window->contentItem(), "kimiCodeStatus");
                    auto *source = findVisualItem(window->contentItem(), "kimiCodeSource");
                    auto *scroll = findVisualItem(window->contentItem(), "pageScroll");
                    auto *viewport = scroll ? qobject_cast<QQuickItem *>(scroll->property("contentItem").value<QObject *>()) : nullptr;
                    if (!toggle || !toggle->isVisible() || !toggle->property("checked").toBool() ||
                        !status || !status->isVisible() || status->property("text").toString() != "已接入" || !viewport) { app.exit(86); return; }
                    if (controller.kimiDesktopSupported() && (!source || !source->isVisible() ||
                        source->property("currentValue").toString() != controller.kimiCodeSource())) { app.exit(90); return; }
                    const auto y = toggle->mapToItem(viewport, QPointF()).y() + viewport->property("contentY").toReal();
                    viewport->setProperty("contentY", qBound(0.0, y - viewport->height() / 3, qMax(0.0, viewport->property("contentHeight").toReal() - viewport->height())));
                    QTimer::singleShot(120, &app, [&, toggle, status, viewport] {
                        const auto bounds = toggle->mapRectToScene(toggle->boundingRect()).united(status->mapRectToScene(status->boundingRect()));
                        const auto viewportBounds = viewport->mapRectToScene(viewport->boundingRect());
                        if (!viewportBounds.contains(bounds)) { app.exit(87); return; }
                        const auto finish = [&, status] {
                            controller.smokeActivation(false);
                            app.exit(status->property("text").toString() == "未连接" ? 0 : 89);
                        };
                        if (!parser.isSet("screenshot")) { finish(); return; }
                        const auto grab = toggle->parentItem()->grabToImage();
                        if (!grab) { app.exit(88); return; }
                        QObject::connect(grab.data(), &QQuickItemGrabResult::ready, &app, [&, grab, finish] {
                            if (!grab->saveToFile(parser.value("screenshot"))) { app.exit(88); return; }
                            finish();
                        });
                        QTimer::singleShot(2500, &app, [&] { app.exit(88); });
                    });
                });
                return;
            }
            if (parser.isSet("smoke-motion")) {
                auto *metric = findVisualItem(window->contentItem(), "home-metric-0");
                if (!metric) { app.exit(47); return; }
                QQmlProperty::write(metric, "text", "12");
                QTimer::singleShot(80, &app, [&, metric] {
                    const auto p = metric->property("progress").toDouble();
                    const bool enabled = window->property("motionEnabled").toBool();
                    if (metric->property("shown").toString() != "12" || (enabled ? !(p > 0 && p < 1) : p != 1)) { qWarning() << "metric motion" << p << metric->property("shown") << enabled; if (parser.isSet("screenshot")) window->grabWindow().save(parser.value("screenshot") + ".metric-failed.png"); app.exit(48); return; }
                    if (parser.isSet("screenshot")) window->grabWindow().save(parser.value("screenshot") + ".metric-middle.png");
                    QQmlProperty::write(metric, "text", "3");
                    if (metric->property("direction").toInt() != -1) app.exit(49);
                });
                QTimer::singleShot(500, &app, [&, metric] {
                    if (metric->property("shown").toString() != "3" || metric->property("progress").toDouble() != 1) { qWarning() << "metric settled" << metric->property("shown") << metric->property("progress"); app.exit(50); return; }
                    if (parser.isSet("screenshot")) window->grabWindow().save(parser.value("screenshot") + ".metric-settled.png");
                });
            }
            QList<QRectF> launchBounds;
            for (const auto &name : {"overviewAgent-pi", "overviewAgent-codex", "overviewAgent-codexDesktop", "overviewAgent-claude", "overviewAgent-dsh", "overviewAgent-dshDesktop"}) {
                auto *button = findVisualItem(window->contentItem(), name);
                if (!button || !button->isVisible()) { app.exit(44); return; }
                const auto bounds = button->mapRectToScene(button->boundingRect());
                // Rows may scroll below the fold at the minimum height; they must never overflow sideways.
                if (bounds.left() < 0 || bounds.right() > window->width()) { app.exit(45); return; }
                for (const auto &other : launchBounds) if (bounds.intersects(other)) { app.exit(46); return; }
                launchBounds.append(bounds);
            }
            // A caption keeps the button's optical center whether or not a glyph sits beside it:
            // a reserved slot without an icon would push the text right by half of its width.
            auto contentIsCentered = [](QQuickItem *button) {
                auto *caption = findVisualItem(button, "actionButtonCaption");
                if (!caption) return false;
                QRectF content = caption->mapRectToScene(caption->boundingRect());
                if (auto *glyph = findVisualItem(button, "actionButtonGlyph"); glyph && glyph->isVisible())
                    content = content.united(glyph->mapRectToScene(glyph->boundingRect()));
                const auto bounds = button->mapRectToScene(button->boundingRect());
                return qAbs(content.center().x() - bounds.center().x()) <= 1.0;
            };
            for (const auto &name : {"overviewAgent-pi", "overviewAgent-codex", "overviewAgent-codexDesktop", "overviewAgent-claude", "overviewAgent-dsh", "overviewAgent-dshDesktop"})
                if (!contentIsCentered(findVisualItem(window->contentItem(), name))) { app.exit(56); return; }
            // HOST-AGENT-MARK-02: desktop variants retain the vendor identity.
            // Verify the rendered image as well as the model so a missing SVG cannot pass.
            for (const auto &kind : {QString("codex"), QString("dsh")}) {
                auto *mark = findVisualItem(window->contentItem(), "overviewAgentMark-" + kind + "Desktop");
                if (!mark || !mark->isVisible() || mark->property("kind").toString() != kind) { app.exit(84); return; }
                bool loaded = false;
                for (auto *child : mark->childItems()) if (child->property("source").toUrl().toString().startsWith("data:image/svg+xml,"))
                    loaded = child->property("status").toInt() == 1;
                if (!loaded) { app.exit(85); return; }
            }
            if (auto *plain = findVisualItem(window->contentItem(), "overviewActivate"); !plain || !contentIsCentered(plain)) { app.exit(57); return; }
#endif
            controller.requestCode("not-a-qq-mailbox@example.com");
            if (!controller.message().contains("@qq.com")) { app.exit(6); return; }
            controller.clearMessage();
            // Exercise every native page with the actual controller; no fixture is shown in the product UI.
            for (int page = 1; page <= 4; ++page) {
                QTimer::singleShot(page * 350 + (parser.isSet("smoke-motion") ? 400 : 0), &app, [&, page] {
                    QMetaObject::invokeMethod(window, "selectPage", Q_ARG(QVariant, page));
#ifdef ORBIS_SMOKE_INTERACTION
                    if (parser.isSet("smoke-motion")) QTimer::singleShot(65, &app, [&, page] {
                        auto *button = findVisualItem(window->contentItem(), QString("page-button-%1").arg(page));
                        if (!button) { app.exit(51); return; }
                        const auto p = button->property("selectionProgress").toDouble();
                        const bool enabled = window->property("motionEnabled").toBool();
                        if (enabled ? !(p > 0 && p < 1) : p != 1) { qWarning() << "sidebar motion" << page << p << enabled << window->property("page"); app.exit(52); return; }
                        if (parser.isSet("screenshot")) window->grabWindow().save(parser.value("screenshot") + QString(".page-%1-middle.png").arg(page));
                    });
#endif
                    if (parser.isSet("screenshot")) QTimer::singleShot(150, &app, [&, page] {
                        const auto path = parser.value("screenshot") + QString(".page-%1.png").arg(page);
                        if (!window->grabWindow().save(path)) app.exit(7);
                    });
                });
            }
            if (parser.isSet("smoke-providers")) {
                QTimer::singleShot(1800, &app, [&] {
                    QMetaObject::invokeMethod(window, "openProviders", Q_ARG(QVariant, "codex"));
                });
                QTimer::singleShot(2500, &app, [&] {
                    if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".providers.png")) app.exit(7);
                    controller.editProvider("");
                });
                QTimer::singleShot(3200, &app, [&] {
                    if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".provider-editor.png")) app.exit(7);
                    QMetaObject::invokeMethod(window, "closeProviderEditor");
                    QMetaObject::invokeMethod(window, "openProviders", Q_ARG(QVariant, "pi"));
                });
                QTimer::singleShot(3800, &app, [&] { controller.presetProvider("pi-0"); });
                QTimer::singleShot(4600, &app, [&] {
                    if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".pi-editor.png")) app.exit(7);
                    QMetaObject::invokeMethod(window, "saveProviderEditor");
                });
                QTimer::singleShot(5500, &app, [&] {
                    const auto providers = controller.providers();
                    if (providers.size() != 1 || !providers.first().toMap().value("enabled").toBool()) { app.exit(8); return; }
                    controller.copyProvider(providers.first().toMap().value("id").toString());
                });
                QTimer::singleShot(6200, &app, [&] {
                    const auto providers = controller.providers();
                    if (providers.size() != 2 || providers.last().toMap().value("enabled").toBool()) { app.exit(9); return; }
                    controller.switchProvider(providers.last().toMap().value("id").toString(), true);
                });
                QTimer::singleShot(7000, &app, [&] {
                    const auto providers = controller.providers();
                    if (providers.size() != 2 || !providers.last().toMap().value("enabled").toBool()) { app.exit(10); return; }
                    controller.removeProvider(providers.last().toMap().value("id").toString());
                });
                QTimer::singleShot(7800, &app, [&] {
                    const auto providers = controller.providers();
                    if (providers.size() != 1) { app.exit(11); return; }
                    if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".pi-list.png")) app.exit(7);
                    controller.copyProvider(providers.first().toMap().value("id").toString());
                });
                QTimer::singleShot(8500, &app, [&] {
                    const auto providers = controller.providers();
                    if (providers.size() != 2) { app.exit(13); return; }
#ifdef ORBIS_SMOKE_INTERACTION
                    auto *source = findVisualItem(window->contentItem(), "providerDragHandle-" + providers.last().toMap().value("id").toString());
                    auto *target = findVisualItem(window->contentItem(), "providerDragHandle-" + providers.first().toMap().value("id").toString());
                    if (!source || !target) { app.exit(22); return; }
                    const auto from = source->mapToScene(QPointF(source->width() / 2, source->height() / 2)).toPoint();
                    const auto to = target->mapToScene(QPointF(target->width() / 2, target->height() / 2)).toPoint();
                    QTest::mousePress(window, Qt::LeftButton, Qt::NoModifier, from);
                    QTest::mouseMove(window, from + QPoint(0, -24), 60);
                    QTest::mouseMove(window, to, 100);
                    QTest::mouseRelease(window, Qt::LeftButton, Qt::NoModifier, to, 100);
#else
                    QMetaObject::invokeMethod(window, "moveProvider", Q_ARG(QVariant, providers.last().toMap().value("id")), Q_ARG(QVariant, providers.first().toMap().value("id")));
#endif
                });
                QTimer::singleShot(9300, &app, [&] {
                    const auto providers = controller.providers();
                    if (!providers.first().toMap().value("id").toString().endsWith("-copy") || providers.first().toMap().value("enabled").toBool()) { app.exit(14); return; }
                    QMetaObject::invokeMethod(window, "openProviders", Q_ARG(QVariant, "codex"));
                });
                QTimer::singleShot(10000, Qt::PreciseTimer, &app, [&] { controller.presetProvider("codex-0"); });
                QTimer::singleShot(10800, Qt::PreciseTimer, &app, [&] {
                    auto *nativeMode = window->findChild<QObject *>("providerNativeMode");
                    auto *apiKey = window->findChild<QObject *>("providerApiKey");
                    if (!nativeMode || nativeMode->property("checked").toBool() || !apiKey || apiKey->property("visible").toBool()) { app.exit(15); return; }
                    if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".official-editor.png")) app.exit(7);
                    QMetaObject::invokeMethod(window, "saveProviderEditor");
                });
                QTimer::singleShot(11600, Qt::PreciseTimer, &app, [&] {
                    const auto providers = controller.providers();
                    if (providers.size() != 1 || !providers.first().toMap().value("enabled").toBool()) { app.exit(16); return; }
                    controller.editProvider("");
                });
                QTimer::singleShot(12400, Qt::PreciseTimer, &app, [&] {
                    // An incomplete new form must still be able to open native configuration.
                    QMetaObject::invokeMethod(window, "setProviderEditorMode", Q_ARG(QVariant, true));
                });
                QTimer::singleShot(13200, Qt::PreciseTimer, &app, [&] {
                    auto *nativeMode = window->findChild<QObject *>("providerNativeMode");
                    if (!nativeMode || !nativeMode->property("checked").toBool()) { app.exit(17); return; }
                    QMetaObject::invokeMethod(window, "setProviderEditorMode", Q_ARG(QVariant, false));
                });
                QTimer::singleShot(14000, Qt::PreciseTimer, &app, [&] {
                    const QMap<QString, QString> fields{{"providerName", "Smoke API"}, {"providerUrl", smokeModelUrl}, {"providerApiKey", "smoke-only"}};
                    for (auto it = fields.cbegin(); it != fields.cend(); ++it) {
                        auto *field = window->findChild<QObject *>(it.key());
                        if (!field) { app.exit(18); return; }
                        field->setProperty("text", it.value());
                    }
                    auto *model = window->findChild<QObject *>("providerDefaultModel");
                    auto *reasoning = window->findChild<QObject *>("codexReasoning");
                    if (!model || model->property("text").toString().isEmpty() || !reasoning || reasoning->property("currentText").toString().isEmpty()) { app.exit(24); return; }
#ifdef ORBIS_SMOKE_INTERACTION
                    if (!clickSmokeItem(window, "fetchDefaultModel", true)) { app.exit(25); return; }
#else
                    QMetaObject::invokeMethod(window, "requestProviderModels", Q_ARG(QVariant, -2));
#endif
                });
                QTimer::singleShot(14800, Qt::PreciseTimer, &app, [&] {
#ifdef ORBIS_SMOKE_INTERACTION
                    if (!clickSmokeItem(window, "discoveredModel-smoke-a") || !clickSmokeItem(window, "discoveredModel-smoke-b")) { app.exit(26); return; }
                    auto *first = findVisualItem(window->contentItem(), "discoveredModel-smoke-a");
                    auto *second = findVisualItem(window->contentItem(), "discoveredModel-smoke-b");
                    if (first->property("checked").toBool() || !second->property("checked").toBool()) { app.exit(27); return; }
#else
                    window->setProperty("fetchedModels", QVariantList{QVariantMap{{"id", "smoke-b"}, {"selected", true}}});
#endif
                    auto *dialog = window->findChild<QObject *>("fetchedModelsDialog");
                    if (!dialog || !dialog->property("visible").toBool()) { app.exit(28); return; }
                    if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".model-picker.png")) app.exit(7);
                    QMetaObject::invokeMethod(dialog, "accept");
                    QMetaObject::invokeMethod(window, "saveProviderEditor");
                });
                QTimer::singleShot(15600, Qt::PreciseTimer, &app, [&] {
                    const auto providers = controller.providers();
                    if (providers.size() != 2 || providers.last().toMap().value("enabled").toBool()) { app.exit(19); return; }
                    controller.editProvider(providers.last().toMap().value("id").toString());
                });
                QTimer::singleShot(16400, Qt::PreciseTimer, &app, [&] {
                    auto *nativeMode = window->findChild<QObject *>("providerNativeMode");
                    auto *model = window->findChild<QObject *>("providerDefaultModel");
                    if (!nativeMode || nativeMode->property("checked").toBool() || !model || model->property("text").toString() != "smoke-b" || window->property("providerDraft").toMap().value("config").toMap().contains("modelCatalog")) { app.exit(20); return; }
                    auto *scroll = window->findChild<QObject *>("providerFormScroll");
                    if (auto *viewport = scroll ? scroll->property("contentItem").value<QObject *>() : nullptr) viewport->setProperty("contentY", 220);
                    QTimer::singleShot(100, &app, [&] {
                        if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".custom-editor.png")) app.exit(7);
                        QMetaObject::invokeMethod(window, "closeProviderEditor");
                        controller.switchProvider(controller.providers().last().toMap().value("id").toString(), true);
                    });
                });
                QTimer::singleShot(17200, Qt::PreciseTimer, &app, [&] {
                    const auto providers = controller.providers();
                    if (providers.size() != 2 || providers.first().toMap().value("enabled").toBool() || !providers.last().toMap().value("enabled").toBool()) { app.exit(21); return; }
                    QMetaObject::invokeMethod(window, "openProviders", Q_ARG(QVariant, "pi"));
                });
                QTimer::singleShot(18000, Qt::PreciseTimer, &app, [&] { controller.editProvider(controller.providers().last().toMap().value("id").toString()); });
                QTimer::singleShot(18800, Qt::PreciseTimer, &app, [&] {
                    smokePiModelCount = window->property("providerModels").toList().size();
                    window->findChild<QObject *>("providerUrl")->setProperty("text", smokeModelUrl);
                    window->findChild<QObject *>("providerApiKey")->setProperty("text", "smoke-only");
#ifdef ORBIS_SMOKE_INTERACTION
                    if (!clickSmokeItem(window, "fetchCatalogModels", true)) { app.exit(29); return; }
#else
                    QMetaObject::invokeMethod(window, "requestProviderModels", Q_ARG(QVariant, -1));
#endif
                });
                QTimer::singleShot(19600, Qt::PreciseTimer, &app, [&] {
#ifdef ORBIS_SMOKE_INTERACTION
                    if (!clickSmokeItem(window, "discoveredModel-smoke-a") || !clickSmokeItem(window, "discoveredModel-smoke-b")) { app.exit(30); return; }
#else
                    window->setProperty("fetchedModels", QVariantList{QVariantMap{{"id", "smoke-a"}, {"selected", true}}, QVariantMap{{"id", "smoke-b"}, {"selected", true}}});
#endif
                    auto *dialog = window->findChild<QObject *>("fetchedModelsDialog");
                    if (!dialog || !dialog->property("visible").toBool()) { app.exit(31); return; }
                    QMetaObject::invokeMethod(dialog, "accept");
                    if (window->property("providerModels").toList().size() != smokePiModelCount + 2) { app.exit(32); return; }
                    QMetaObject::invokeMethod(window, "saveProviderEditor");
                });
                QTimer::singleShot(20400, Qt::PreciseTimer, &app, [&] { controller.editProvider(controller.providers().last().toMap().value("id").toString()); });
                QTimer::singleShot(21200, Qt::PreciseTimer, &app, [&] {
                    const auto models = window->property("providerModels").toList();
                    const auto last = models.last().toMap();
                    if (models.size() != smokePiModelCount + 2 || !last.value("contextWindow").toString().isEmpty() || !last.value("maxTokens").toString().isEmpty()) { app.exit(33); return; }
                    QMetaObject::invokeMethod(window, "closeProviderEditor");
                    QMetaObject::invokeMethod(window, "openProviders", Q_ARG(QVariant, "dsh"));
                });
                QTimer::singleShot(22000, Qt::PreciseTimer, &app, [&] { controller.editProvider(""); });
                QTimer::singleShot(22800, Qt::PreciseTimer, &app, [&] {
                    const QMap<QString, QString> fields{{"providerName", "Smoke DSH"}, {"providerUrl", smokeModelUrl}, {"providerApiKey", "smoke-only"}};
                    for (auto it = fields.cbegin(); it != fields.cend(); ++it) window->findChild<QObject *>(it.key())->setProperty("text", it.value());
#ifdef ORBIS_SMOKE_INTERACTION
                    if (!clickSmokeItem(window, "fetchCatalogModels", true)) { app.exit(34); return; }
#else
                    QMetaObject::invokeMethod(window, "requestProviderModels", Q_ARG(QVariant, -1));
#endif
                });
                QTimer::singleShot(23600, Qt::PreciseTimer, &app, [&] {
#ifdef ORBIS_SMOKE_INTERACTION
                    if (!clickSmokeItem(window, "discoveredModel-smoke-a") || !clickSmokeItem(window, "discoveredModel-smoke-b")) { app.exit(35); return; }
#else
                    window->setProperty("fetchedModels", QVariantList{QVariantMap{{"id", "smoke-a"}, {"selected", true}}, QVariantMap{{"id", "smoke-b"}, {"selected", true}}});
#endif
                    auto *dialog = window->findChild<QObject *>("fetchedModelsDialog");
                    if (!dialog || !dialog->property("visible").toBool()) { app.exit(36); return; }
                    QMetaObject::invokeMethod(dialog, "accept");
                    window->findChild<QObject *>("providerDefaultModel")->setProperty("text", "smoke-b");
                    QMetaObject::invokeMethod(window, "saveProviderEditor");
                });
                QTimer::singleShot(24400, Qt::PreciseTimer, &app, [&] {
                    if (controller.providers().size() != 1) { app.exit(37); return; }
                    controller.editProvider(controller.providers().first().toMap().value("id").toString());
                });
                QTimer::singleShot(25200, Qt::PreciseTimer, &app, [&] {
                    const auto models = window->property("providerModels").toList();
                    auto *model = window->findChild<QObject *>("providerDefaultModel");
                    if (models.size() != 2 || !model || model->property("text").toString() != "smoke-b" || models.first().toMap().value("maxTokens").toInt() <= 0) { app.exit(38); return; }
                    auto *scroll = window->findChild<QObject *>("providerFormScroll");
                    if (auto *viewport = scroll ? scroll->property("contentItem").value<QObject *>() : nullptr) viewport->setProperty("contentY", 450);
                    QTimer::singleShot(100, &app, [&] {
                        if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".dsh-models.png")) app.exit(7);
                        QMetaObject::invokeMethod(window, "deleteProviderModel", Q_ARG(QVariant, 0));
                        QMetaObject::invokeMethod(window, "addProviderModel");
#ifdef ORBIS_SMOKE_INTERACTION
                        if (!clickSmokeItem(window, "selectCatalogModel-1", true)) { app.exit(39); return; }
#else
                        QMetaObject::invokeMethod(window, "requestProviderModels", Q_ARG(QVariant, 1));
#endif
                    });
                });
                QTimer::singleShot(26400, Qt::PreciseTimer, &app, [&] {
#ifdef ORBIS_SMOKE_INTERACTION
                    if (!clickSmokeItem(window, "discoveredModel-smoke-a")) { app.exit(40); return; }
#else
                    window->setProperty("fetchedModels", QVariantList{QVariantMap{{"id", "smoke-a"}, {"selected", true}}});
#endif
                    auto *dialog = window->findChild<QObject *>("fetchedModelsDialog");
                    if (!dialog || !dialog->property("visible").toBool()) { app.exit(41); return; }
                    QMetaObject::invokeMethod(dialog, "accept");
                    const auto models = window->property("providerModels").toList();
                    if (models.size() != 2 || models.last().toMap().value("id").toString() != "smoke-a" || models.last().toMap().value("maxTokens").toInt() <= 0 || window->findChild<QObject *>("providerDefaultModel")->property("text").toString() != "smoke-b") { app.exit(42); return; }
                    QMetaObject::invokeMethod(window, "saveProviderEditor");
                });
                QTimer::singleShot(27200, Qt::PreciseTimer, &app, [&] {
                    controller.editProvider(controller.providers().first().toMap().value("id").toString());
                });
                QTimer::singleShot(28000, Qt::PreciseTimer, &app, [&] {
                    const auto models = window->property("providerModels").toList();
                    if (models.size() != 2 || models.first().toMap().value("id").toString() != "smoke-b" || models.last().toMap().value("id").toString() != "smoke-a") { app.exit(43); return; }
                    QMetaObject::invokeMethod(window, "closeProviderEditor");
                    QMetaObject::invokeMethod(window, "openProviders", Q_ARG(QVariant, "pi"));
                });
                QTimer::singleShot(28800, Qt::PreciseTimer, &app, [&] { controller.editProvider(controller.providers().last().toMap().value("id").toString()); });
                QTimer::singleShot(29600, Qt::PreciseTimer, &app, [&] {
                    auto *scroll = window->findChild<QObject *>("providerFormScroll");
                    auto *viewport = scroll ? scroll->property("contentItem").value<QObject *>() : nullptr;
                    if (viewport) viewport->setProperty("contentY", qMax(0.0, viewport->property("contentHeight").toReal() - viewport->property("height").toReal()));
                    QTimer::singleShot(100, &app, [&] {
                        if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".pi-models.png")) app.exit(7);
                        app.exit(0);
                    });
                });
            } else if (parser.isSet("smoke-appearance")) {
                // Preference writes and screenshots stay under the smoke data directory.
                const QStringList themes{"light", "dark", "sage-light", "sage-dark"};
                for (int index = 0; index < themes.size(); ++index) {
                    QTimer::singleShot(2600 + index * 650, &app, [&, themes, index] {
                        const auto theme = themes[index];
                        QMetaObject::invokeMethod(window, "selectPage", Q_ARG(QVariant, 3));
                        QMetaObject::invokeMethod(window, "applyAppearance", Q_ARG(QVariant, theme.startsWith("sage") ? "sage" : "mist"), Q_ARG(QVariant, theme.endsWith("dark") ? "dark" : "light"));
                        QTimer::singleShot(450, &app, [&, theme, index, themes] {
                            if (window->property("appearanceThemeId").toString() != theme) { app.exit(53); return; }
                            if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + "." + theme + ".png")) { app.exit(7); return; }
                            if (index == themes.size() - 1) app.exit(0);
                        });
                    });
                }
            } else if (parser.isSet("smoke-agents")) {
                // Agent detection includes bounded network lookups. Start the dialog checks
                // after the real result arrives, retaining failure for a missing agent list.
                auto *waitAgents = new QTimer(&app); waitAgents->setInterval(100);
                const auto started = QDateTime::currentMSecsSinceEpoch();
                QObject::connect(waitAgents, &QTimer::timeout, &app, [&, waitAgents, started] {
                    if (controller.agents().isEmpty() && QDateTime::currentMSecsSinceEpoch() - started < 45000) return;
                    waitAgents->stop(); waitAgents->deleteLater();
                    if (controller.agents().isEmpty()) { app.exit(12); return; }
                    QTimer::singleShot(1800, &app, [&] { QMetaObject::invokeMethod(window, "selectPage", Q_ARG(QVariant, 2)); });
                    QTimer::singleShot(2500, &app, [&] {
                        if (controller.agents().isEmpty()) { app.exit(12); return; }
                        QMetaObject::invokeMethod(window, "showAgentInstaller", Q_ARG(QVariant, controller.agents().first()));
                    });
                    QTimer::singleShot(3200, &app, [&] {
                        if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".agent-install.png")) app.exit(7);
                        QMetaObject::invokeMethod(window, "closeAgentDialogs");
                        QMetaObject::invokeMethod(window, "showAgentBatch");
                    });
                    QTimer::singleShot(4000, &app, [&] {
                        if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".agent-batch.png")) app.exit(7);
                        QMetaObject::invokeMethod(window, "closeAgentDialogs");
#ifdef ORBIS_SMOKE_INTERACTION
                        // HOST-CLAUDE-UPDATE-02: show current/latest, and offer an update for an old CLI.
                        // Only open and cancel the real dialog; never update the machine in smoke.
                        controller.smokeReceive({{"event", "claudeStatus"}, {"installed", true}, {"compatible", false}, {"version", "2.1.286"}, {"minimumVersion", "2.1.287"}, {"latestVersion", "2.1.325"}, {"updateAvailable", true}});
                        QTimer::singleShot(250, &app, [&] {
                            auto *button = findVisualItem(window->contentItem(), "updateClaude");
                            auto *scroll = window->findChild<QObject *>("pageScroll");
                            auto *viewport = scroll ? scroll->property("contentItem").value<QObject *>() : nullptr;
                            if (!button || !button->isEnabled() || !viewport) { app.exit(86); return; }
                            auto *versions = window->findChild<QObject *>("claudeVersions");
                            if (!versions || versions->property("text").toString() != "当前 2.1.286，最新 2.1.325，有可用更新") { app.exit(89); return; }
                            viewport->setProperty("contentY", qMax(0.0, viewport->property("contentHeight").toReal() - viewport->property("height").toReal()));
                            QTest::qWait(80);
                            if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".claude-card.png")) { app.exit(7); return; }
                            if (!clickSmokeItem(window, "updateClaude")) { app.exit(86); return; }
                            QTimer::singleShot(200, &app, [&] {
                                auto *dialog = window->findChild<QObject *>("agentInstallDialog");
                                if (!dialog || !dialog->property("visible").toBool() || dialog->property("title").toString() != "更新 Claude Code 到最新版本" || window->property("installKind").toString() != "claude") { app.exit(87); return; }
                                if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".claude-update.png")) { app.exit(7); return; }
                                QMetaObject::invokeMethod(window, "closeAgentDialogs");
                                controller.smokeReceive({{"event", "claudeStatus"}, {"installed", true}, {"compatible", true}, {"version", "2.1.325"}, {"latestVersion", "2.1.325"}});
                                QTest::qWait(40);
                                auto *currentButton = findVisualItem(window->contentItem(), "updateClaude");
                                if (!currentButton || currentButton->isEnabled() || currentButton->property("text").toString() != "已是最新版本") { app.exit(90); return; }
                                controller.smokeReceive({{"event", "claudeStatus"}, {"installed", true}, {"compatible", true}, {"version", "2.1.325"}, {"latestError", "Claude Code 最新版本查询失败，请检查网络后重试"}});
                                QTest::qWait(40);
                                if (!currentButton->isEnabled() || currentButton->property("text").toString() != "更新到最新版本") { app.exit(91); return; }
                                controller.smokeReceive({{"event", "claudeStatus"}, {"installed", false}, {"compatible", false}});
                                QTimer::singleShot(100, &app, [&] {
                                    auto *button = findVisualItem(window->contentItem(), "updateClaude");
                                    app.exit(button && !button->isEnabled() ? 0 : 88);
                                });
                            });
                        });
#else
                        app.exit(0);
#endif
                    });
                });
                waitAgents->start();
            } else if (parser.isSet("smoke-exit")) {
                requestSmokeExit();
                QTimer::singleShot(500, &app, [&] {
                    auto *dialog = window->findChild<QObject *>("hostExitDialog");
                    if (!dialog || !dialog->property("visible").toBool() || controller.exiting()) { app.exit(60); return; }
                    if (parser.isSet("screenshot")) window->grabWindow().save(parser.value("screenshot") + ".exit.png");
                    QMetaObject::invokeMethod(dialog, "reject");
                    controller.updateConfirmationRequested();
                });
                QTimer::singleShot(1100, &app, [&] {
                    auto *dialog = window->findChild<QObject *>("hostUpdateDialog");
                    if (!dialog || !dialog->property("visible").toBool() || controller.exiting()) { app.exit(61); return; }
                    if (parser.isSet("screenshot")) window->grabWindow().save(parser.value("screenshot") + ".update.png");
                    QMetaObject::invokeMethod(dialog, "reject");
                    controller.requestInstallerExit();
                });
                QTimer::singleShot(1700, &app, [&] {
                    auto *dialog = window->findChild<QObject *>("installerExitDialog");
                    if (!dialog || !dialog->property("visible").toBool() || controller.exiting()) { app.exit(62); return; }
                    if (parser.isSet("screenshot")) window->grabWindow().save(parser.value("screenshot") + ".installer.png");
                    QMetaObject::invokeMethod(dialog, "reject");
                });
                QTimer::singleShot(2200, &app, [&] {
                    if (controller.exiting() || controller.exitApproved()) { app.exit(63); return; }
                    requestSmokeExit();
                    QTimer::singleShot(500, &app, [&] {
                        auto *dialog = window->findChild<QObject *>("hostExitDialog");
                        if (!dialog || !dialog->property("visible").toBool()) { app.exit(64); return; }
                        QMetaObject::invokeMethod(dialog, "accept");
                    });
                    // Exercise the real Quit path after cleanup, including QML's close handler.
                    QTimer::singleShot(20000, &app, [&] { app.exit(65); });
                });
            }
#ifdef ORBIS_SMOKE_INTERACTION
            else if (parser.isSet("smoke-modal-lighting")) {
                // S67: supplier dropdowns and nested dialogs use cast shadows, and Esc cancels
                // only the active layer without undoing edits or changing the parent surface.
                QMetaObject::invokeMethod(window, "openProviders", Q_ARG(QVariant, "codex"));
                controller.editProvider("");
                QTimer::singleShot(500, &app, [&] {
                    auto *combo = window->findChild<QObject *>("codexReasoning");
                    auto *name = window->findChild<QObject *>("providerName");
                    if (!combo || !name || !name->property("visible").toBool()) { app.exit(93); return; }
                    auto *popup = combo->property("popup").value<QObject *>();
                    auto *bg = popup ? popup->property("background").value<QObject *>() : nullptr;
                    auto *visual = qobject_cast<QQuickItem *>(combo);
                    if (!visual || !popup) { app.exit(93); return; }
                    visual->forceActiveFocus(Qt::TabFocusReason);
                    QMetaObject::invokeMethod(popup, "open");
                    QTest::qWait(250);
                    if (!bg || !popup->property("visible").toBool() || bg->property("outerHighlightEnabled").toBool()) { app.exit(94); return; }
                    const auto shot = [&](const QString &suffix) {
                        return !parser.isSet("screenshot") || window->grabWindow().save(parser.value("screenshot") + suffix + ".png");
                    };
                    if (!shot(".provider-combo")) { app.exit(7); return; }
                    QTest::keyClick(window, Qt::Key_Escape);
                    if (popup->property("visible").toBool() || !name->property("visible").toBool()) { app.exit(95); return; }
                    window->setProperty("providerFormDirty", true);
                    QMetaObject::invokeMethod(window, "changePreset", Q_ARG(QVariant, "different-fixture-preset"));
                    auto *confirm = window->findChild<QObject *>("providerChangePresetDialog");
                    QTest::qWait(250);
                    bg = confirm ? confirm->property("background").value<QObject *>() : nullptr;
                    if (!bg || !confirm->property("visible").toBool() || bg->property("outerHighlightEnabled").toBool()) { app.exit(96); return; }
                    if (!shot(".provider-confirm")) { app.exit(7); return; }
                    QTest::keyClick(window, Qt::Key_Escape);
                    QTest::qWait(200);
                    app.exit(!confirm->property("visible").toBool() && name->property("visible").toBool()
                            && window->property("providerFormDirty").toBool() ? 0 : 97);
                });
            } else if (parser.isSet("smoke-guide")) {
                // HOST-GUIDE-01: in every overview step only that step's controls carry the accent.
                // Bridge events are synthetic and pass through the real reducer; nothing is activated or paired.
                static const QStringList kinds{"pi", "codex", "codexDesktop", "claude", "dsh", "dshDesktop"};
                auto item = [&](const QString &name) { return findVisualItem(window->contentItem(), name); };
                // Helpers outlive this block inside the timers: they hold each other by value.
                auto accented = [item](const QString &name) { auto *found = item(name); return found && found->isVisible() && found->property("primary").toBool(); };
                auto agentAccented = [accented](const QString &kind) { return accented("overviewAgent-" + kind); };
                auto anyAgentAccented = [agentAccented] { for (const auto &kind : kinds) if (agentAccented(kind)) return true; return false; };
                auto step = [&]() { return window->property("nextStep").toString(); };
                auto shot = [&](const QString &name) { if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".guide-" + name + ".png")) app.exit(7); };
                auto *waitIdle = new QTimer(&app); waitIdle->setInterval(250);
                const auto started = QDateTime::currentMSecsSinceEpoch();
                QObject::connect(waitIdle, &QTimer::timeout, &app, [&, waitIdle, started, item, accented, agentAccented, anyAgentAccented, step, shot] {
                    // Agent detection must settle first, or its late result would replace the fixture agents.
                    if (controller.busy() && QDateTime::currentMSecsSinceEpoch() - started < 45000) return;
                    waitIdle->stop(); waitIdle->deleteLater();
                    QMetaObject::invokeMethod(window, "selectPage", Q_ARG(QVariant, 0));
                    controller.smokeAgents({
                        QVariantMap{{"kind", "pi"}, {"installed", true}, {"version", "0.70.0"}},
                        QVariantMap{{"kind", "codex"}, {"installed", true}, {"desktopInstalled", true}, {"version", "0.130.0"}},
                        QVariantMap{{"kind", "dsh"}, {"installed", false}, {"desktopInstalled", true}}});
                    controller.smokeReceive({{"event", "claudeStatus"}, {"installed", true}, {"compatible", true}, {"version", "2.1.300"}, {"minimumVersion", "2.1.287"}});
                    QTimer::singleShot(600, &app, [&, item, anyAgentAccented, step, shot] {
                        if (step() != "activate") { qWarning() << "guide step" << step(); app.exit(66); return; }
                        if (anyAgentAccented()) { app.exit(67); return; }
                        if (auto *connection = item("overviewConnection"); connection && connection->isVisible()) { app.exit(68); return; }
                        shot("1-activate");
                        controller.smokeActivation(false);
                        controller.smokeReceive({{"event", "state"}, {"state", "stopped"}});
                    });
                    QTimer::singleShot(1200, &app, [&, item, accented, anyAgentAccented, step, shot] {
                        if (step() != "connect") { qWarning() << "guide step" << step(); app.exit(69); return; }
                        if (!accented("overviewConnection") || accented("overviewPair") || anyAgentAccented()) {
                            auto *connection = item("overviewConnection");
                            qWarning() << "guide connect" << (connection ? connection->isVisible() : false) << (connection ? connection->property("primary") : QVariant()) << accented("overviewPair") << anyAgentAccented();
                            shot("2-connect-failed"); app.exit(70); return;
                        }
                        shot("2-connect");
                        controller.smokeActivation(true);
                        controller.smokeReceive({{"event", "state"}, {"state", "connected"}});
                    });
                    QTimer::singleShot(1800, &app, [&, item, accented, anyAgentAccented, step, shot] {
                        if (step() != "pair") { qWarning() << "guide step" << step(); app.exit(71); return; }
                        if (!accented("overviewPair") || !item("overviewPair")->isEnabled() || accented("overviewConnection") || anyAgentAccented()) { app.exit(72); return; }
                        shot("3-pair");
                        auto backend = [](const QString &kind, bool launchable, int sessions) {
                            return QJsonObject{{"kind", kind}, {"ready", launchable}, {"launchable", launchable}, {"runtimeCount", sessions}, {"reason", QJsonValue::Null}};
                        };
                        const QJsonObject backends{{"domain", "backends"}, {"value", QJsonObject{{"backends", QJsonArray{
                            backend("pi", true, 2), backend("codex", true, 0), backend("codexDesktop", true, 0), backend("dsh", false, 0), backend("claude", true, 1),
                            backend("dshDesktop", true, 0)}}}}};
                        controller.smokeReceive({{"event", "status"}, {"runtimeCount", 3},
                            {"devices", QJsonArray{QJsonObject{{"deviceId", "smoke-phone"}, {"label", "手机"}, {"path", "relay"}, {"createdAt", 1}}}},
                            {"model", QJsonObject{{"domains", QJsonArray{backends}}}}});
                    });
                    QTimer::singleShot(2700, &app, [&, item, accented, agentAccented, step, shot] {
                        if (step() != "open") { qWarning() << "guide step" << step(); app.exit(73); return; }
                        if (!agentAccented("pi") || !agentAccented("codex") || agentAccented("dsh") || accented("overviewConnection") || accented("overviewPair")) { app.exit(74); return; }
                        auto *sessions = item("overviewAgentSessions-pi");
                        if (!sessions || !sessions->isVisible() || sessions->property("text").toString() != "2") { app.exit(75); return; }
                        shot("4-open");
                        // DSH-DESKTOP-09: a DeepSeek Desktop opened elsewhere keeps opening it from Orbis as the accented
                        // step, and the wait for the user to quit it shows on that button, without explanatory text.
                        if (!agentAccented("dshDesktop")) { app.exit(78); return; }
                        controller.smokeReceive({{"event", "dshDesktop"}, {"status", QJsonObject{{"state", "running"}, {"reason", "DeepSeek 桌面版需由 Orbis 打开"}, {"version", "0.2.2-rc.2"}}}});
                        auto *desktop = item("overviewAgent-dshDesktop");
                        if (!agentAccented("dshDesktop") || !desktop || desktop->property("loading").toBool() || desktop->property("text").toString() != "打开") { app.exit(79); return; }
                        controller.smokeReceive({{"event", "dshDesktopOpen"}, {"state", "waiting"}});
                        if (!item("overviewAgent-dshDesktop")->property("loading").toBool()) { app.exit(80); return; }
                        shot("4-dsh-desktop-waiting");
                        controller.smokeReceive({{"event", "dshDesktopOpen"}, {"state", "idle"}});
                        controller.smokeReceive({{"event", "dshDesktop"}, {"status", QJsonObject{{"state", "attached"}, {"reason", "已接入 DeepSeek 桌面版 0.2.2-rc.2"}, {"version", "0.2.2-rc.2"}}}});
                        if (item("overviewAgent-dshDesktop")->property("loading").toBool() || !agentAccented("dshDesktop")) { app.exit(81); return; }
                        controller.smokePauseForChange();
                    });
                    QTimer::singleShot(3300, &app, [&, item, shot] {
                        auto *state = item("overviewLinkState");
                        if (!controller.resumePending() || !state || state->property("text").toString() != "完成后自动恢复") { app.exit(76); return; }
                        if (item("overviewConnection")->isEnabled()) { app.exit(77); return; }
                        shot("5-resume");
                        app.exit(0);
                    });
                });
                // The shared smoke flow visits pages 1-4 first; start once it has returned control.
                QTimer::singleShot(parser.isSet("smoke-motion") ? 2400 : 2000, &app, [waitIdle] { waitIdle->start(); });
            }
#endif
            else QTimer::singleShot(parser.isSet("smoke-motion") ? 2300 : 1800, &app, [&] { app.exit(0); });
        });
    }
    const int result = app.exec();
    // A successful smoke run must reach verified cleanup, not leave via a test-only Quit bypass.
    if (parser.isSet("smoke-exit")) {
        QFile report(dataDir + "/smoke-exit-result.json");
        if (report.open(QIODevice::WriteOnly)) report.write(QJsonDocument(QJsonObject{
            {"exitApproved", controller.exitApproved()}, {"bridgeReady", controller.bridgeReady()},
            {"windowVisible", window->isVisible()}, {"trayVisible", tray.isVisible()},
            {"entry", parser.value("smoke-exit-entry")}, {"exitCode", result}}).toJson());
        if (!controller.exitApproved() || controller.bridgeReady() || window->isVisible() || tray.isVisible()) return 78;
    }
    return result;
}
