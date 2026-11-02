#include <QQmlComponent>
#include <QQmlEngine>
#include <QtTest>
#include <memory>

class MotionTextTest : public QObject {
    Q_OBJECT
private slots:
    void rapidUpdatesExposeOnlyTheNewestValueAndSettle() {
        QQmlEngine engine;
        QQmlComponent component(&engine, QUrl::fromLocalFile(QStringLiteral(ORBIS_MOTION_TEXT_QML)));
        QVERIFY2(component.isReady(), qPrintable(component.errorString()));
        std::unique_ptr<QObject> label(component.createWithInitialProperties({{"text", "8"}, {"roll", true}}));
        QVERIFY(label);
        QCOMPARE(label->property("progress").toDouble(), 1.0);
        label->setProperty("text", "12");
        QCOMPARE(label->property("shown").toString(), QString("12"));
        QCOMPARE(label->property("previous").toString(), QString("8"));
        QTRY_VERIFY(label->property("progress").toDouble() > 0.0);
        QVERIFY(label->property("progress").toDouble() < 1.0);
        label->setProperty("text", "3");
        QCOMPARE(label->property("shown").toString(), QString("3"));
        QCOMPARE(label->property("direction").toInt(), -1);
        QTRY_COMPARE(label->property("progress").toDouble(), 1.0);
        QCOMPARE(label->property("text").toString(), QString("3"));
    }
    void disablingMotionSettlesTheCurrentTransitionAndFutureChanges() {
        QQmlEngine engine;
        QQmlComponent component(&engine, QUrl::fromLocalFile(QStringLiteral(ORBIS_MOTION_TEXT_QML)));
        QVERIFY2(component.isReady(), qPrintable(component.errorString()));
        std::unique_ptr<QObject> label(component.createWithInitialProperties({{"text", "正在同步"}}));
        QVERIFY(label);
        label->setProperty("text", "已连接");
        label->setProperty("motionEnabled", false);
        QCOMPARE(label->property("progress").toDouble(), 1.0);
        label->setProperty("text", "连接中");
        QCOMPARE(label->property("shown").toString(), QString("连接中"));
        QCOMPARE(label->property("progress").toDouble(), 1.0);
    }
};
QTEST_MAIN(MotionTextTest)
#include "MotionTextTest.moc"
