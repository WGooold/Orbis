#include "../StartupSettings.h"
#include <QFile>
#include <QTemporaryDir>
#include <QXmlStreamReader>
#include <QtTest>

class StartupSettingsTest : public QObject {
    Q_OBJECT
private slots:
    // Login startup applies immediately, using an isolated path rather than a real LaunchAgent.
    void loginAgentRoundTripsEscapedProgramAndCanBeRemoved() {
        QTemporaryDir temp;
        QVERIFY(temp.isValid());
        const auto path = temp.path() + "/nested/com.orbis.host.plist";
        const auto program = QStringLiteral("/Apps/Orbis & Partners/<preview>/Orbis Host");
        QString error;
        QVERIFY2(writeLoginAgent(path, program, true, &error), qPrintable(error));
        QFile file(path); QVERIFY(file.open(QIODevice::ReadOnly));
        const auto bytes = file.readAll(); file.close();
        QXmlStreamReader xml(bytes);
        QStringList strings;
        while (!xml.atEnd()) { xml.readNext(); if (xml.isStartElement() && xml.name() == "string") strings.append(xml.readElementText()); }
        QVERIFY2(!xml.hasError(), qPrintable(xml.errorString()));
        QVERIFY(strings.contains(program)); QVERIFY(strings.contains("--tray"));
        QVERIFY(writeLoginAgent(path, program, false, &error));
        QVERIFY(!QFile::exists(path));
        QVERIFY(writeLoginAgent(path, program, false, &error));
    }
    // Failure to create the target leaves unrelated user files intact and reports an error.
    void invalidLocationDoesNotOverwriteExistingFile() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const auto existing = temp.path() + "/keep";
        QFile file(existing); QVERIFY(file.open(QIODevice::WriteOnly)); file.write("retained"); file.close();
        QString error;
        QVERIFY(!writeLoginAgent(existing + "/child.plist", "/App/Orbis", true, &error));
        QVERIFY(!error.isEmpty());
        QVERIFY(file.open(QIODevice::ReadOnly)); QCOMPARE(file.readAll(), QByteArray("retained"));
    }
};
QTEST_GUILESS_MAIN(StartupSettingsTest)
#include "StartupSettingsTest.moc"
