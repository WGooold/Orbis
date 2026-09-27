#include "HostController.h"
#include <QApplication>
#include <QCommandLineParser>
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonArray>
#include <QLocalServer>
#include <QLocalSocket>
#include <QLockFile>
#include <QMenu>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QTcpServer>
#include <QTcpSocket>
#ifdef ORBIS_SMOKE_INTERACTION
#include <QQuickItem>
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
    app.setOrganizationName("Orbis"); app.setApplicationName("Orbis Host"); app.setApplicationVersion(ORBIS_VERSION);
    app.setWindowIcon(QIcon(":/src/assets/orbis.png"));
    QQuickStyle::setStyle("Basic");
    // Reliable scaling and soft surfaces on integrated graphics and Windows Remote Desktop.
    QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
    QCommandLineParser parser; parser.addHelpOption(); parser.addVersionOption();
    parser.addOption({"runtime-root", "Host runtime directory (development only)", "path"});
    parser.addOption({"data-dir", "Isolated desktop settings directory", "path"});
    parser.addOption({"host-state-dir", "Isolated Host identity directory", "path"});
    parser.addOption({"tray", "Start in the system tray"});
    parser.addOption({"smoke-test", "Render the window and exit after checking the Host bridge"});
    parser.addOption({"smoke-compact", "Run the smoke test at the minimum window size"});
    parser.addOption({"screenshot", "Save the smoke-test window image", "path"});
    parser.addOption({"smoke-providers", "Also render provider list and editor using isolated smoke-test data"});
    parser.addOption({"smoke-agents", "Also render Agent installation dialogs without starting downloads"});
    parser.process(app);
    QString dataDir = parser.value("data-dir"); if (dataDir.isEmpty()) dataDir = QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation);
    dataDir = QDir(dataDir).absolutePath(); QDir().mkpath(dataDir);
    if (parser.isSet("smoke-test") && parser.isSet("smoke-providers")) qputenv("ORBIS_PROVIDER_TEST_ROOT", (dataDir + "/test-agents").toUtf8());
    const auto serverName = "OrbisHost-" + QString::fromLatin1(QCryptographicHash::hash(dataDir.toUtf8(), QCryptographicHash::Sha256).toHex().left(24));
    QLockFile lock(dataDir + "/desktop.lock"); lock.setStaleLockTime(0);
    if (!lock.tryLock(100)) {
        QLocalSocket other; other.connectToServer(serverName);
        if (other.waitForConnected(2000)) { other.write("activate\n"); other.waitForBytesWritten(1000); }
        return 0;
    }
    QLocalServer instance; instance.setSocketOptions(QLocalServer::UserAccessOption);
    if (!instance.listen(serverName)) return 2;
    QString runtimeRoot = parser.value("runtime-root"); if (runtimeRoot.isEmpty()) runtimeRoot = app.applicationDirPath() + "/runtime";
    QString hostStateDir = parser.value("host-state-dir");
    if (parser.isSet("smoke-test") && hostStateDir.isEmpty()) hostStateDir = dataDir + "/test-host";
    HostController controller(QDir(runtimeRoot).absolutePath(), dataDir, hostStateDir);
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("host", &controller);
    engine.rootContext()->setContextProperty("trayAvailable", QSystemTrayIcon::isSystemTrayAvailable());
    engine.loadFromModule("Orbis.Host", "Main");
    if (engine.rootObjects().isEmpty()) return 3;
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    if (!window) return 4;
    auto show = [window] { window->showNormal(); window->raise(); window->requestActivate(); };
    QObject::connect(&instance, &QLocalServer::newConnection, &app, [&instance, show] {
        while (auto *socket = instance.nextPendingConnection()) { show(); socket->disconnectFromServer(); socket->deleteLater(); }
    });
    QSystemTrayIcon tray(app.windowIcon());
    QMenu menu;
    menu.addAction("打开 Orbis", &app, show);
    menu.addAction("添加手机", &controller, [&controller, show] { show(); controller.pair(); });
    menu.addSeparator();
    menu.addAction("开始连接", &controller, &HostController::startHost);
    menu.addAction("暂停连接", &controller, &HostController::stopHost);
    menu.addSeparator();
    menu.addAction("退出 Orbis", &app, &QApplication::quit);
    tray.setContextMenu(&menu); tray.setToolTip("Orbis Host");
    if (QSystemTrayIcon::isSystemTrayAvailable()) { app.setQuitOnLastWindowClosed(false); tray.show(); }
    QObject::connect(&tray, &QSystemTrayIcon::activated, &app, [show](QSystemTrayIcon::ActivationReason reason) { if (reason == QSystemTrayIcon::Trigger || reason == QSystemTrayIcon::DoubleClick) show(); });
    QObject::connect(&controller, &HostController::notification, &tray, [&tray](const QString &title, const QString &body) { tray.showMessage(title, body, QSystemTrayIcon::Information, 4000); });
    QObject::connect(&app, &QApplication::aboutToQuit, &controller, &HostController::shutdown);
    if (parser.isSet("tray") && QSystemTrayIcon::isSystemTrayAvailable() && !parser.isSet("smoke-test")) window->hide();
    QString smokeModelUrl;
    int smokePiModelCount = 0;
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
            if (parser.isSet("screenshot")) imageOk = window->grabWindow().save(parser.value("screenshot"));
            QFile report(dataDir + "/smoke-result.json");
            if (report.open(QIODevice::WriteOnly)) report.write(QJsonDocument(QJsonObject{{"bridgeReady", controller.bridgeReady()}, {"windowVisible", window->isVisible()}, {"screenshotSaved", imageOk}, {"message", controller.message()}, {"agents", QJsonArray::fromVariantList(controller.agents())}}).toJson());
            if (!controller.bridgeReady() || !imageOk) { app.exit(5); return; }
            controller.requestCode("not-a-qq-mailbox@example.com");
            if (!controller.message().contains("@qq.com")) { app.exit(6); return; }
            controller.clearMessage();
            // Exercise every native page with the actual controller; no fixture is shown in the product UI.
            for (int page = 1; page <= 4; ++page) {
                QTimer::singleShot(page * 350, &app, [&, page] {
                    QMetaObject::invokeMethod(window, "selectPage", Q_ARG(QVariant, page));
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
            } else if (parser.isSet("smoke-agents")) {
                QTimer::singleShot(1800, &app, [&] { QMetaObject::invokeMethod(window, "selectPage", Q_ARG(QVariant, 2)); });
                QTimer::singleShot(2500, &app, [&] {
                    if (controller.agents().isEmpty()) { app.exit(12); return; }
                    QMetaObject::invokeMethod(window, "showAgentInstaller", Q_ARG(QVariant, controller.agents().first()));
                });
                QTimer::singleShot(3200, &app, [&] {
                    if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".agent-install.png")) app.exit(7);
                    QMetaObject::invokeMethod(window, "closeAgentDialogs");
                    QMetaObject::invokeMethod(window, "showAgentHistory", Q_ARG(QVariant, controller.agents().first()));
                });
                QTimer::singleShot(4000, &app, [&] {
                    if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".agent-history.png")) app.exit(7);
                    QMetaObject::invokeMethod(window, "closeAgentDialogs");
                    QMetaObject::invokeMethod(window, "showAgentBatch", Q_ARG(QVariant, "update"));
                });
                QTimer::singleShot(4800, &app, [&] {
                    if (parser.isSet("screenshot") && !window->grabWindow().save(parser.value("screenshot") + ".agent-batch.png")) app.exit(7);
                    app.exit(0);
                });
            } else QTimer::singleShot(1800, &app, [&] { app.exit(0); });
        });
    }
    return app.exec();
}
