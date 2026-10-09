#include "../DiagnosticLogModel.h"
#include "../NeuSurface.h"
#include <QAbstractItemModelTester>
#include <QQmlComponent>
#include <QQmlEngine>
#include <QQuickItem>
#include <QQuickWindow>
#include <QtTest>
#include <memory>

class DiagnosticLogTest : public QObject {
    Q_OBJECT
    static int visibleLogRows(QQuickItem *item) {
        int count = item->objectName() == "diagnosticLogRow" ? 1 : 0;
        for (auto *child : item->childItems()) count += visibleLogRows(child);
        return count;
    }
private slots:
    void burstCaptureIsBoundedAndExportIncludesUnflushedError() {
        DiagnosticLogModel model;
        QAbstractItemModelTester invariant(&model, QAbstractItemModelTester::FailureReportingMode::QtTest);
        QSignalSpy inserts(&model, &QAbstractItemModel::rowsInserted);
        QSignalSpy resets(&model, &QAbstractItemModel::modelReset);
        for (int i = 0; i < 10000; ++i) model.append(QString("sync %1 ").arg(i) + QString(5000, 'x'));
        model.append("desktop_refresh_failed: reason");
        QCOMPARE(model.rowCount(), 0);
        QCOMPARE(model.snapshot().size(), DiagnosticLogModel::MaxEntries);
        QCOMPARE(model.snapshot().last(), "desktop_refresh_failed: reason");
        for (const auto &line : model.snapshot()) QVERIFY(line.size() <= 1600);
        QTRY_COMPARE(model.rowCount(), DiagnosticLogModel::MaxEntries);
        QCOMPARE(inserts.count(), 1);
        QCOMPARE(resets.count(), 0);
        QCOMPARE(model.data(model.index(299), Qt::UserRole).toString(), "desktop_refresh_failed: reason");
        model.append("next error");
        QCOMPARE(model.snapshot().size(), DiagnosticLogModel::MaxEntries);
        QCOMPARE(model.snapshot().last(), "next error");
        QTRY_COMPARE(inserts.count(), 2);
        QCOMPARE(model.rowCount(), DiagnosticLogModel::MaxEntries);
        QCOMPARE(model.data(model.index(299), Qt::UserRole).toString(), "next error");
    }

    void logFloodKeepsVisibleDelegatesAndEventLoopBounded() {
        QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
        qmlRegisterType<NeuSurface>("Orbis.Host", 1, 0, "NeuSurface");
        DiagnosticLogModel model;
        QAbstractItemModelTester invariant(&model, QAbstractItemModelTester::FailureReportingMode::QtTest);
        QQmlEngine engine;
        QQmlComponent component(&engine, QUrl::fromLocalFile(QStringLiteral(ORBIS_LOG_VIEW)));
        QVERIFY2(component.isReady(), qPrintable(component.errorString()));
        std::unique_ptr<QObject> view(component.createWithInitialProperties({{"logModel", QVariant::fromValue(static_cast<QAbstractItemModel *>(&model))}}));
        QVERIFY2(view != nullptr, qPrintable(component.errorString()));
        auto *item = qobject_cast<QQuickItem *>(view.get());
        QVERIFY(item);
        QQuickWindow window;
        window.resize(900, 320);
        item->setParentItem(window.contentItem());
        item->setSize(QSizeF(900, 320));
        window.show();
        auto *list = item->findChild<QQuickItem *>("diagnosticLogList");
        QVERIFY(list);
        QSignalSpy inserts(&model, &QAbstractItemModel::rowsInserted);
        int produced = 0, heartbeats = 0;
        QTimer producer, heartbeat;
        connect(&producer, &QTimer::timeout, &model, [&] {
            for (int i = 0; i < 20; ++i) model.append(QString("sync %1 ").arg(++produced) + QString(1450, 'x'));
        });
        connect(&heartbeat, &QTimer::timeout, &model, [&] { ++heartbeats; });
        producer.start(2);
        heartbeat.start(10);
        QTest::qWait(1200);
        producer.stop();
        QVERIFY(produced >= 1000);
        QVERIFY(heartbeats >= 20);
        QVERIFY(inserts.count() >= 2 && inserts.count() <= 6);
        QCOMPARE(model.rowCount(), DiagnosticLogModel::MaxEntries);
        QTRY_COMPARE(list->property("count").toInt(), DiagnosticLogModel::MaxEntries);
        model.append("latest desktop refresh error");
        QTRY_COMPARE(model.data(model.index(299), Qt::UserRole).toString(), "latest desktop refresh error");
        QTRY_VERIFY(list->property("atYEnd").toBool());
        // A full 300-row QTextDocument is never created: only viewport delegates exist.
        const int delegates = visibleLogRows(item);
        QVERIFY(delegates > 0);
        QVERIFY2(delegates < 30, qPrintable(QString("Rendered %1 rows").arg(delegates)));
        qInfo("Captured %d logs, %d UI heartbeats, %lld row batches, %d viewport delegates", produced, heartbeats, inserts.count(), delegates);
        const auto screenshot = qEnvironmentVariable("ORBIS_DIAGNOSTIC_TEST_SCREENSHOT");
        if (!screenshot.isEmpty()) QVERIFY(window.grabWindow().save(screenshot));
        QCOMPARE(int(item->height()), 320);
        window.hide();
    }
};
QTEST_MAIN(DiagnosticLogTest)
#include "DiagnosticLogTest.moc"
