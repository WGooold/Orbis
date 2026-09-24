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
    parser.addOption({"screenshot", "Save the smoke-test window image", "path"});
    parser.addOption({"smoke-providers", "Also render provider list and editor using isolated smoke-test data"});
    parser.process(app);
    QString dataDir = parser.value("data-dir"); if (dataDir.isEmpty()) dataDir = QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation);
    dataDir = QDir(dataDir).absolutePath(); QDir().mkpath(dataDir);
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
    if (parser.isSet("smoke-test")) {
        QTimer::singleShot(8000, &app, [&] {
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
                    app.exit(0);
                });
            } else QTimer::singleShot(1800, &app, [&] { app.exit(0); });
        });
    }
    return app.exec();
}
