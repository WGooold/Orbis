#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalServer>
#include <QLocalSocket>
#include <QLockFile>
#include <QProcess>
#include <QTemporaryDir>
#include <QtTest>

class InstallerUpdateTest : public QObject {
    Q_OBJECT
    static bool write(const QString &path, const QByteArray &source) {
        QFile file(path);
        return file.open(QIODevice::WriteOnly) && file.write(source) == source.size();
    }
    static QString serverName(const QString &data) {
        return "OrbisHost-" + QString::fromLatin1(QCryptographicHash::hash(data.toUtf8(), QCryptographicHash::Sha256).toHex().left(24));
    }
    static void fixture(const QString &root, bool failure) {
        const auto dist = root + "/packages/host/dist";
        QVERIFY(QDir().mkpath(dist));
        QVERIFY(write(dist + "/desktop-bridge.js",
            "require('node:fs').appendFileSync(__dirname+'/bridge-started','started\\n');"
            "const rl=require('node:readline').createInterface({input:process.stdin});"
            "rl.on('line',line=>{const r=JSON.parse(line);if(r.method==='shutdown')process.exit(0);"
            "if(r.id)console.log(JSON.stringify({id:r.id,result:{}}))});"));
        const QByteArray result = failure
            ? "console.log(JSON.stringify({event:'error',message:'fixture cleanup refused'}));process.exit(1)"
            : "console.log(JSON.stringify({event:'done'}));rl.close()";
        QVERIFY(write(dist + "/desktop-shutdown.js",
            "const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});"
            "let first=true;rl.on('line',line=>{if(first){first=false;"
            "fs.writeFileSync(__dirname+'/cleanup-request.json',line);"
            "console.log(JSON.stringify({event:'ready'}))}else if(line==='proceed'){" + result + "}});"));
    }
    static QStringList arguments(const QString &root) {
        return {"--runtime-root", root, "--data-dir", root + "/data", "--host-state-dir", root + "/host", "--smoke-test"};
    }
private slots:
    // Shared CI runners stall on antivirus scans and cold starts: a 10s ceiling made the
    // closed-Host case fail once and pass on the next identical run.
    void closedHost_data() {
        QTest::addColumn<bool>("failure");
        QTest::newRow("verified-cleanup") << false;
        QTest::newRow("cleanup-refused") << true;
    }
    // HOST-UPDATE-03: execute the real installer entry without a running Host. A fake bridge
    // records accidental startup; success and failure must both finish without opening the app.
    void closedHost() {
        QFETCH(bool, failure);
        QTemporaryDir root; fixture(root.path(), failure);
        QProcess child;
        child.start(QStringLiteral(ORBIS_HOST_EXECUTABLE), arguments(root.path()) + QStringList{"--prepare-update-confirmed"});
        QVERIFY(child.waitForStarted());
        QVERIFY2(child.waitForFinished(30000), qPrintable(QString::fromUtf8(child.readAllStandardError())));
        QCOMPARE(child.exitStatus(), QProcess::NormalExit);
        QCOMPARE(child.exitCode(), failure ? 20 : 0);
        const auto dist = root.path() + "/packages/host/dist";
        QVERIFY2(!QFile::exists(dist + "/bridge-started"), "Installer cleanup must never start or recover the desktop bridge");
        QFile request(dist + "/cleanup-request.json"); QVERIFY(request.open(QIODevice::ReadOnly));
        QCOMPARE(QJsonDocument::fromJson(request.readAll()).object().value("bridgePid").toInt(), 0);
    }
    // An older running portable Host maps unknown IPC to window activation. Keep its original
    // endpoint untouched and let setup offer manual closure when the new endpoint is unavailable.
    void olderInstanceIsNotActivated() {
        QTemporaryDir root; fixture(root.path(), false);
        const auto data = root.path() + "/data"; QVERIFY(QDir().mkpath(data));
        QLockFile lock(data + "/desktop.lock"); QVERIFY(lock.tryLock());
        QLocalServer old; QVERIFY(old.listen(serverName(data)));
        QSignalSpy connections(&old, &QLocalServer::newConnection);
        QProcess child;
        child.start(QStringLiteral(ORBIS_HOST_EXECUTABLE), arguments(root.path()) + QStringList{"--prepare-update-confirmed"});
        QVERIFY(child.waitForStarted()); QVERIFY(child.waitForFinished(30000));
        QCOMPARE(child.exitCode(), 1);
        QCoreApplication::processEvents(); QCOMPARE(connections.size(), 0);
        QVERIFY(!QFile::exists(root.path() + "/packages/host/dist/cleanup-request.json"));
    }
    // A running Host accepts setup's confirmation once, shuts down its existing bridge and
    // releases the real main event loop. No QML confirmation is answered by this test.
    void runningHostUsesInstallerConfirmation() {
        QTemporaryDir root; fixture(root.path(), false);
        QProcess host; host.start(QStringLiteral(ORBIS_HOST_EXECUTABLE), arguments(root.path()));
        QVERIFY(host.waitForStarted());
        QTRY_VERIFY2_WITH_TIMEOUT(QFile::exists(root.path() + "/packages/host/dist/bridge-started"), qPrintable(QString::fromUtf8(host.readAllStandardError())), 20000);
        QProcess installer;
        installer.start(QStringLiteral(ORBIS_HOST_EXECUTABLE), arguments(root.path()) + QStringList{"--prepare-update-confirmed"});
        QVERIFY(installer.waitForStarted());
        QVERIFY2(installer.waitForFinished(20000), qPrintable(QString::fromUtf8(host.readAllStandardError())));
        QCOMPARE(installer.exitCode(), 0);
        if (host.state() != QProcess::NotRunning) QVERIFY(host.waitForFinished(10000));
        QCOMPARE(host.exitCode(), 0);
        QFile request(root.path() + "/packages/host/dist/cleanup-request.json"); QVERIFY(request.open(QIODevice::ReadOnly));
        QVERIFY(QJsonDocument::fromJson(request.readAll()).object().value("bridgePid").toDouble() > 0);
    }
};

QTEST_GUILESS_MAIN(InstallerUpdateTest)
#include "InstallerUpdateTest.moc"
