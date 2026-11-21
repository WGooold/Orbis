#include "../NeuSurface.h"
#include <QDir>
#include <QQmlComponent>
#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QTemporaryDir>
#include <QtTest>
#include <cmath>
#include <memory>

class ActionButtonTest : public QObject {
    Q_OBJECT
    static double luminance(const QColor &color) {
        auto linear = [](double value) { return value <= 0.04045 ? value / 12.92 : std::pow((value + 0.055) / 1.055, 2.4); };
        return 0.2126 * linear(color.redF()) + 0.7152 * linear(color.greenF()) + 0.0722 * linear(color.blueF());
    }
private slots:
    void initTestCase() {
        QQuickStyle::setStyle("Basic");
        QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
        qmlRegisterType<NeuSurface>("Orbis.Host", 1, 0, "NeuSurface");
        qmlRegisterSingletonType(QUrl("qrc:/qt/qml/Orbis/Host/Theme.qml"), "Orbis.Host", 1, 0, "Theme");
    }
    void agentMarksLoadWithBothAppearances() {
        // AGENT-MARK-01: test the bundled images through the shared QML mark,
        // including the two desktop aliases and live light/dark asset changes.
        QTemporaryDir settings; QVERIFY(settings.isValid());
        QQmlEngine engine;
        engine.rootContext()->setContextProperty("orbisAppearanceSettings", QUrl::fromLocalFile(settings.filePath("appearance.ini")));
        auto *theme = engine.singletonInstance<QObject *>("Orbis.Host", "Theme"); QVERIFY(theme);
        auto *preferences = theme->property("preferences").value<QObject *>(); QVERIFY(preferences);
        QQmlComponent component(&engine, QUrl("qrc:/qt/qml/Orbis/Host/AgentMark.qml"));
        QVERIFY2(component.isReady(), qPrintable(component.errorString()));
        std::unique_ptr<QObject> mark(component.create()); QVERIFY2(mark, qPrintable(component.errorString()));
        auto *image = mark->findChild<QObject *>("agentMarkImage"); QVERIFY(image);
        for (const auto &mode : {QString("light"), QString("dark")}) {
            QVERIFY(preferences->setProperty("mode", mode));
            QMap<QString, QUrl> sources;
            for (const QString kind : {"pi", "codex", "codexDesktop", "dsh", "dshDesktop", "claude", "openclaw", "hermes", "kimiCode", "opencode"}) {
                QVERIFY(mark->setProperty("kind", kind));
                QVERIFY2(mark->property("hasMark").toBool(), qPrintable(kind));
                QTRY_COMPARE(image->property("status").toInt(), 1);  // Image.Ready
                if (kind == "kimiCode" || kind == "opencode") {
                    const double ratio = kind == "kimiCode" ? 86.0 / 76 : 240.0 / 300;
                    QVERIFY(qAbs(image->property("paintedWidth").toDouble() / image->property("paintedHeight").toDouble() - ratio) < 0.07);
                }
                sources.insert(kind, image->property("source").toUrl());
            }
            QCOMPARE(sources["codexDesktop"], sources["codex"]);
            QCOMPARE(sources["dshDesktop"], sources["dsh"]);
            QCOMPARE(sources["kimiCode"], QUrl("qrc:/agent-marks/kimi-code.svg"));
            QCOMPARE(sources["opencode"], QUrl("qrc:/agent-marks/opencode-" + mode + ".svg"));
            QCOMPARE(sources["hermes"], QUrl("qrc:/agent-marks/hermes-" + mode + ".svg"));
        }
        QVERIFY(mark->setProperty("kind", "future-agent"));
        QVERIFY(!mark->property("hasMark").toBool());
    }
    void loadingRemainsLegible_data() {
        QTest::addColumn<QString>("material");
        QTest::addColumn<QString>("mode");
        QTest::addColumn<QString>("variant");
        QTest::addColumn<bool>("enabled");
        QTest::addColumn<bool>("motion");
        for (const auto &material : {QString("mist"), QString("sage")})
            for (const auto &mode : {QString("light"), QString("dark")})
                for (const auto &variant : {QString("plain"), QString("primary"), QString("danger")})
                    for (bool enabled : {false, true})
                        for (bool motion : {false, true}) {
                            const auto name = QString("%1-%2-%3-%4-%5").arg(material, mode, variant, enabled ? "enabled" : "disabled", motion ? "motion" : "still");
                            QTest::newRow(qPrintable(name)) << material << mode << variant << enabled << motion;
                        }
    }
    void loadingRemainsLegible() {
        // HOST-ACTIVITY-06: inspect actual software-rendered pixels so default
        // control padding, disabled styling and reduced-motion hiding cannot
        // leave only an expanded button with an effectively invisible spinner.
        QFETCH(QString, material); QFETCH(QString, mode); QFETCH(QString, variant);
        QFETCH(bool, enabled); QFETCH(bool, motion);
        QTemporaryDir settings; QVERIFY(settings.isValid());
        QQmlEngine engine;
        engine.rootContext()->setContextProperty("orbisAppearanceSettings", QUrl::fromLocalFile(settings.filePath("appearance.ini")));
        engine.rootContext()->setContextProperty("orbisMotionEnabled", motion);
        auto *theme = engine.singletonInstance<QObject *>("Orbis.Host", "Theme"); QVERIFY(theme);
        auto *preferences = theme->property("preferences").value<QObject *>(); QVERIFY(preferences);
        preferences->setProperty("material", material); preferences->setProperty("mode", mode);
        QQmlComponent component(&engine, QUrl::fromLocalFile(QStringLiteral(ORBIS_ACTION_BUTTON_QML)));
        QVERIFY2(component.isReady(), qPrintable(component.errorString()));
        std::unique_ptr<QObject> object(component.createWithInitialProperties({
            {"text", "Connect"}, {"loading", true}, {"enabled", enabled},
            {"primary", variant == "primary"}, {"danger", variant == "danger"}}));
        QVERIFY2(object != nullptr, qPrintable(component.errorString()));
        auto *button = qobject_cast<QQuickItem *>(object.get()); QVERIFY(button);
        QQuickWindow window;
        window.resize(220, 100);
        window.setColor(theme->property("surfaceBase").value<QColor>());
        button->setParentItem(window.contentItem());
        button->setPosition(QPointF(30, 26)); button->setSize(QSizeF(160, 48));
        auto *spinner = button->findChild<QQuickItem *>("actionButtonSpinner"); QVERIFY(spinner);
        QSignalSpy painted(spinner, SIGNAL(painted())); QVERIFY(painted.isValid());
        QSignalSpy rendered(&window, &QQuickWindow::afterRendering); QVERIFY(rendered.isValid());
        window.show();
        QVERIFY(QTest::qWaitForWindowExposed(&window));
        QTRY_VERIFY(!painted.isEmpty());
        // Canvas painting completes asynchronously. Sample only after a new
        // software-rendered frame can include that paint, including still mode.
        const auto framesBeforeUpdate = rendered.count();
        window.update();
        QTRY_VERIFY(rendered.count() > framesBeforeUpdate);
        auto *glyph = button->findChild<QQuickItem *>("actionButtonGlyph"); QVERIFY(glyph);
        const auto frame = window.grabWindow(); QVERIFY(!frame.isNull());
        const double scale = double(frame.width()) / window.width();
        const auto bounds = glyph->mapRectToScene(glyph->boundingRect());
        const auto center = bounds.center() * scale;
        const double background = luminance(frame.pixelColor(qRound(center.x()), qRound(center.y())));
        const QRect pixels(qFloor(bounds.x() * scale), qFloor(bounds.y() * scale), qCeil(bounds.width() * scale), qCeil(bounds.height() * scale));
        int legible = 0;
        for (int y = pixels.top(); y <= pixels.bottom(); ++y)
            for (int x = pixels.left(); x <= pixels.right(); ++x) {
                const double ink = luminance(frame.pixelColor(x, y));
                if ((qMax(ink, background) + 0.05) / (qMin(ink, background) + 0.05) >= 3.0) ++legible;
            }
        const auto output = qEnvironmentVariable("ORBIS_ACTION_BUTTON_TEST_SCREENSHOTS");
        if (!output.isEmpty()) {
            QVERIFY(QDir().mkpath(output));
            QVERIFY(frame.save(output + '/' + QString::fromLatin1(QTest::currentDataTag()) + ".png"));
        }
        const double area = legible / (scale * scale);
        QVERIFY2(area >= 24, qPrintable(QString("Only %1 logical pixels of the loading glyph reach 3:1 contrast").arg(area)));
        QTest::qWait(140);
        const auto nextGlyph = window.grabWindow().copy(pixels);
        QCOMPARE(nextGlyph != frame.copy(pixels), motion);
        button->setProperty("loading", false);
        QVERIFY(!glyph->isVisible());
        window.hide();
    }
};
QTEST_MAIN(ActionButtonTest)
#include "ActionButtonTest.moc"
