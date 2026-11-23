#include "../HostController.h"
#include "../NeuSurface.h"
#include <QBuffer>
#include <QDir>
#include <QFile>
#include <QImage>
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

QString makeQrDataUrl(const QColor &accent) {
    QImage img(64, 64, QImage::Format_RGB32);
    img.fill(Qt::white);
    for (int y = 6; y < 58; ++y) {
        for (int x = 6; x < 58; ++x) {
            const bool finder = (x < 20 && y < 20) || (x >= 44 && y < 20) || (x < 20 && y >= 44);
            if (finder || ((x / 4 + y / 4) % 2 == 0)) img.setPixelColor(x, y, accent);
        }
    }
    QByteArray png;
    QBuffer buffer(&png);
    buffer.open(QIODevice::WriteOnly);
    img.save(&buffer, "PNG");
    return QStringLiteral("data:image/png;base64,") + QString::fromLatin1(png.toBase64());
}

void writeFixtureBridge(const QString &root, bool includeIosQr, bool androidUpdateAvailable) {
    QDir().mkpath(root + "/packages/host/dist");
    QFile file(root + "/packages/host/dist/desktop-bridge.js");
    QVERIFY(file.open(QIODevice::WriteOnly));
    const QString androidQr = makeQrDataUrl(Qt::black);
    const QString iosQr = includeIosQr ? makeQrDataUrl(QColor("#1a1a1a")) : QString();
    const QString deviceJson = androidUpdateAvailable
        ? R"({"deviceId":"phone-1","label":"Pixel","path":"relay","createdAt":1,"platform":"android","appVersion":"0.1.0","latestAndroidVersion":"0.1.24","androidUpdateAvailable":true})"
        : R"({"deviceId":"phone-1","label":"iPhone","path":"relay","createdAt":1})";
    const QString script = QString(R"JS(
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
const androidQr = %1;
const iosQr = %2;
const devices = [%3];
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") {
    const result = {
      hostId: "fixture-host",
      hostName: "Fixture",
      appDownloadQr: androidQr,
      devices,
      agentEnablement: { revision: 1, agents: [] },
      openClaw: { source: "file", url: "", hasToken: false },
      hermesRemote: { source: "file", host: "", port: 22, profile: "" }
    };
    if (iosQr) result.iosAppDownloadQr = iosQr;
    out({ id, result });
    out({ event: "state", state: "connected" });
    out({ event: "status", runtimeCount: 0, devices });
    return;
  }
  if (method === "detect") {
    out({ id, result: [] });
    return;
  }
  if (method === "shutdown") {
    out({ id, result: {} });
    process.exit(0);
  }
  out({ id, result: {} });
});
)JS")
        .arg(QJsonDocument(QJsonArray{androidQr}).toJson(QJsonDocument::Compact).mid(1).chopped(1))
        .arg(QJsonDocument(QJsonArray{iosQr}).toJson(QJsonDocument::Compact).mid(1).chopped(1))
        .arg(deviceJson);
    file.write(script.toUtf8());
}
}

class MobileDownloadLayoutTest : public QObject {
    Q_OBJECT
private slots:
    void initTestCase() {
        qputenv("ORBIS_NO_KEYCHAIN", "1");
        QQuickStyle::setStyle("Basic");
        QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
        qmlRegisterType<NeuSurface>("Orbis.Host", 1, 0, "NeuSurface");
    }

    void dropdownMenuOpensEachPlatformQrDialog_data() {
        QTest::addColumn<int>("windowWidth");
        QTest::addColumn<QString>("mode");
        QTest::newRow("compact-light") << 1020 << QString("light");
        QTest::newRow("default-light") << 1180 << QString("light");
        QTest::newRow("default-dark") << 1180 << QString("dark");
    }

    // HOST-MOBILE-DOWNLOAD-02: clicking "下载移动端" opens a dropdown submenu with
    // Android and iOS entries instead of inline QR codes; choosing an entry opens its QR dialog.
    void dropdownMenuOpensEachPlatformQrDialog() {
        QFETCH(int, windowWidth);
        QFETCH(QString, mode);
        QVERIFY(!QStandardPaths::findExecutable("node").isEmpty());
        QTemporaryDir root;
        QVERIFY(root.isValid());
        writeFixtureBridge(root.path(), true, false);

        const QString dataDir = root.path() + "/desktop";
        QDir().mkpath(dataDir);
        {
            QSettings appearance(dataDir + "/appearance.ini", QSettings::IniFormat);
            appearance.beginGroup("Appearance");
            appearance.setValue("material", "mist");
            appearance.setValue("mode", mode);
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
        QTRY_VERIFY_WITH_TIMEOUT(controller.bridgeReady() && !controller.appDownloadQr().isEmpty() && !controller.iosAppDownloadQr().isEmpty(), 10000);

        QVERIFY(QMetaObject::invokeMethod(window, "selectPage", Q_ARG(QVariant, 1)));
        QTRY_COMPARE(window->property("page").toInt(), 1);

        auto *toggle = findVisualItem(window->contentItem(), "downloadMobileClient");
        auto *caption = findVisualItem(window->contentItem(), "downloadMobileCaption");
        auto *chevron = findVisualItem(window->contentItem(), "downloadMobileChevron");
        auto *updateDot = findVisualItem(window->contentItem(), "downloadMobileUpdateDot");
        auto *menu = window->findChild<QObject *>("mobileDownloadMenu");
        auto *dialog = window->findChild<QObject *>("appDownloadDialog");
        QVERIFY(toggle && caption && chevron && updateDot && menu && dialog);
        QTRY_VERIFY(toggle->isVisible());
        QCOMPARE(caption->property("text").toString(), QString("下载移动端"));
        QCOMPARE(chevron->rotation(), 0.0);
        QVERIFY(!updateDot->isVisible());
        QVERIFY(!menu->property("visible").toBool());
        QVERIFY(!dialog->property("visible").toBool());

        const auto screenshotBase = qEnvironmentVariable("ORBIS_MOBILE_DOWNLOAD_SCREENSHOT");
        if (!screenshotBase.isEmpty()) {
            QTest::qWait(80);
            window->grabWindow().save(QString("%1-%2-%3-closed.png").arg(screenshotBase).arg(windowWidth).arg(mode));
        }

        // Open dropdown menu by clicking "下载移动端".
        const QPoint togglePoint = toggle->mapRectToScene(toggle->boundingRect()).center().toPoint();
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, togglePoint);
        QTRY_VERIFY(menu->property("visible").toBool());
        QCOMPARE(chevron->rotation(), 180.0);

        auto *androidItem = menu->findChild<QQuickItem *>("downloadAndroidClient");
        auto *iosItem = menu->findChild<QQuickItem *>("downloadIosClient");
        auto *menuSurface = menu->findChild<QQuickItem *>("mobileDownloadMenuSurface");
        auto *androidSurface = menu->findChild<QQuickItem *>("downloadAndroidSurface");
        auto *androidLabel = menu->findChild<QQuickItem *>("downloadAndroidLabel");
        auto *iosLabel = menu->findChild<QQuickItem *>("downloadIosLabel");
        auto *iosHint = menu->findChild<QQuickItem *>("downloadIosHint");
        QVERIFY(androidItem && iosItem && menuSurface && androidSurface && androidLabel && iosLabel && iosHint);
        QTRY_VERIFY(androidItem->isVisible() && iosItem->isVisible());

        // Design-system compliance for Menu (orbis-design-system.md §11.4, §5, §6, §2):
        // container width 220-300, radius-lg 24, raised-lg shadowScale 1.0, padding 8;
        // items height >= 48, concentric radius-md 16, body 15/400, no middle-dot separator.
        const qreal menuWidth = menu->property("width").toReal();
        QVERIFY(menuWidth >= 220.0 && menuWidth <= 300.0);
        QCOMPARE(menu->property("padding").toReal(), 8.0);
        QCOMPARE(menuSurface->property("cornerRadius").toReal(), 24.0);
        QCOMPARE(menuSurface->property("shadowScale").toReal(), 1.0);
        QVERIFY(menuSurface->property("outerHighlightEnabled").toBool());
        QVERIFY(androidItem->height() >= 48.0 && iosItem->height() >= 48.0);
        QCOMPARE(androidSurface->property("cornerRadius").toReal(), 16.0);
        QCOMPARE(androidSurface->property("shadowScale").toReal(), 0.4);
        QCOMPARE(androidLabel->property("text").toString(), QString("Android"));
        QCOMPARE(iosLabel->property("text").toString(), QString("iOS"));
        QCOMPARE(iosHint->property("text").toString(), QString("TestFlight"));
        QVERIFY(!iosLabel->property("text").toString().contains(QStringLiteral("·")));
        QCOMPARE(androidLabel->property("font").value<QFont>().pixelSize(), 15);
        QCOMPARE(androidLabel->property("font").value<QFont>().weight(), QFont::Normal);
        QCOMPARE(iosHint->property("font").value<QFont>().pixelSize(), 13);

        // Menu aligns below the trigger with space-8 gap and stays inside the window.
        QTRY_VERIFY(iosItem->mapRectToScene(iosItem->boundingRect()).top() > androidItem->mapRectToScene(androidItem->boundingRect()).bottom());
        const auto toggleBounds = toggle->mapRectToScene(toggle->boundingRect());
        const auto androidItemBounds = androidItem->mapRectToScene(androidItem->boundingRect());
        const auto iosItemBounds = iosItem->mapRectToScene(iosItem->boundingRect());
        QVERIFY(androidItemBounds.top() > toggleBounds.bottom());
        QVERIFY(iosItemBounds.top() > androidItemBounds.bottom());
        QVERIFY(iosItemBounds.right() <= window->width());

        if (!screenshotBase.isEmpty()) {
            QTest::qWait(80);
            window->grabWindow().save(QString("%1-%2-%3-menu.png").arg(screenshotBase).arg(windowWidth).arg(mode));
        }

        // Pressing Escape dismisses the submenu cleanly.
        QTest::keyClick(window, Qt::Key_Escape);
        QTRY_VERIFY(!menu->property("visible").toBool());
        QCOMPARE(chevron->rotation(), 0.0);

        // Open menu again, then clicking the trigger itself toggles it closed cleanly.
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, togglePoint);
        QTRY_VERIFY(menu->property("visible").toBool());
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, togglePoint);
        QTRY_VERIFY(!menu->property("visible").toBool());
        QCOMPARE(chevron->rotation(), 0.0);

        // Open menu again and choose Android.
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, togglePoint);
        QTRY_VERIFY(menu->property("visible").toBool());
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, androidItem->mapRectToScene(androidItem->boundingRect()).center().toPoint());
        QTRY_VERIFY(!menu->property("visible").toBool());
        QTRY_VERIFY(dialog->property("visible").toBool());
        QCOMPARE(dialog->property("platform").toString(), QString("android"));
        QCOMPARE(dialog->property("title").toString(), QString("Orbis Android"));
        auto *qrImage = dialog->findChild<QQuickItem *>("appDownloadQrImage");
        QVERIFY(qrImage);
        QTRY_COMPARE(qrImage->property("status").toInt(), 1);
        QCOMPARE(qrImage->property("source").toString(), controller.appDownloadQr());
        QVERIFY(QMetaObject::invokeMethod(dialog, "reject"));
        QTRY_VERIFY(!dialog->property("visible").toBool());

        // Open menu again and choose iOS.
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, togglePoint);
        QTRY_VERIFY(menu->property("visible").toBool());
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, iosItem->mapRectToScene(iosItem->boundingRect()).center().toPoint());
        QTRY_VERIFY(!menu->property("visible").toBool());
        QTRY_VERIFY(dialog->property("visible").toBool());
        QCOMPARE(dialog->property("platform").toString(), QString("ios"));
        QCOMPARE(dialog->property("title").toString(), QString("Orbis iOS · TestFlight"));
        QTRY_COMPARE(qrImage->property("status").toInt(), 1);
        QCOMPARE(qrImage->property("source").toString(), controller.iosAppDownloadQr());

        if (!screenshotBase.isEmpty() && windowWidth == 1180 && mode == "light") {
            QTest::qWait(80);
            window->grabWindow().save(QString("%1-%2-%3-ios-dialog.png").arg(screenshotBase).arg(windowWidth).arg(mode));
        }

        QVERIFY(QMetaObject::invokeMethod(dialog, "reject"));
        QTRY_VERIFY(!dialog->property("visible").toBool());

        controller.shutdown();
    }

    // Older runtimes without iosAppDownloadQr hide the iOS submenu item while showing the Android update badge.
    void singlePlatformRuntimeHidesIosEntryAndShowsUpdateBadge() {
        QVERIFY(!QStandardPaths::findExecutable("node").isEmpty());
        QTemporaryDir root;
        QVERIFY(root.isValid());
        writeFixtureBridge(root.path(), false, true);

        const QString dataDir = root.path() + "/desktop";
        QDir().mkpath(dataDir);

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
        window->resize(1180, 820);
        QVERIFY(QTest::qWaitForWindowExposed(window));
        QTRY_VERIFY_WITH_TIMEOUT(controller.bridgeReady() && !controller.appDownloadQr().isEmpty(), 10000);
        QVERIFY(controller.iosAppDownloadQr().isEmpty());
        controller.m_androidLatestVersion = "0.1.24";
        controller.m_androidLatestVersionCode = 24;
        controller.refreshDeviceUpdateIndicators();
        emit controller.changed();

        QVERIFY(QMetaObject::invokeMethod(window, "selectPage", Q_ARG(QVariant, 1)));
        QTRY_COMPARE(window->property("page").toInt(), 1);

        auto *toggle = findVisualItem(window->contentItem(), "downloadMobileClient");
        auto *updateDot = findVisualItem(window->contentItem(), "downloadMobileUpdateDot");
        auto *menu = window->findChild<QObject *>("mobileDownloadMenu");
        QVERIFY(toggle && updateDot && menu);
        QTRY_VERIFY(toggle->isVisible() && updateDot->isVisible());
        QTest::qWait(80);
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, toggle->mapRectToScene(toggle->boundingRect()).center().toPoint());
        QTRY_VERIFY(menu->property("visible").toBool());

        auto *androidItem = menu->findChild<QQuickItem *>("downloadAndroidClient");
        auto *androidBadge = menu->findChild<QQuickItem *>("androidDownloadUpdateBadge");
        auto *iosItem = menu->findChild<QQuickItem *>("downloadIosClient");
        QVERIFY(androidItem && androidBadge && iosItem);
        QTRY_VERIFY(androidItem->isVisible() && androidBadge->isVisible() && !iosItem->isVisible());

        const auto screenshotBase = qEnvironmentVariable("ORBIS_MOBILE_DOWNLOAD_SCREENSHOT");
        if (!screenshotBase.isEmpty()) {
            QTest::qWait(80);
            window->grabWindow().save(QString("%1-single-android-update-menu.png").arg(screenshotBase));
        }

        controller.shutdown();
    }
};
QTEST_MAIN(MobileDownloadLayoutTest)
#include "MobileDownloadLayoutTest.moc"
