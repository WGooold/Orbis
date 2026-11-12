#include "../HostController.h"
#include "../ExitGuard.h"
#include <QDir>
#include <QFile>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QStandardPaths>
#include <QCryptographicHash>
#include <QFileInfo>
#include <QTcpServer>
#include <QTcpSocket>
#include <QtTest>

class HostExitTest : public QObject {
    Q_OBJECT
    static void helper(const QString &root, const QByteArray &script) {
        QDir().mkpath(root + "/packages/host/dist");
        QFile file(root + "/packages/host/dist/desktop-shutdown.js");
        QVERIFY(file.open(QIODevice::WriteOnly)); QCOMPARE(file.write(script), script.size());
    }
private slots:
    // HOST-EXIT-01: requesting exit/update only opens confirmation; cancellation has no side effects.
    void requestsRequireConfirmation() {
        QTemporaryDir root;
        HostController host(root.path(), root.path(), root.path(), root.path(), false);
        QSignalSpy exit(&host, &HostController::exitConfirmationRequested), update(&host, &HostController::updateConfirmationRequested);
        host.m_updateVersion = "99.0.0"; host.m_updateInstallerUrl = "http://127.0.0.1/update"; host.m_updateChecksumUrl = "http://127.0.0.1/hash";
        host.requestExit(); host.updateHost();
        QCOMPARE(exit.size(), 1); QCOMPARE(update.size(), 1);
        QVERIFY(!host.exiting()); QVERIFY(!host.m_updating); QVERIFY(!host.exitApproved());
        QCOMPARE(host.m_exitWorker.state(), QProcess::NotRunning);
        host.m_shutdown = true;
    }
    // HOST-EXIT-02: the real child handshake stays asynchronous and duplicate confirmation is ignored.
    void confirmationWaitsForVerifiedCleanup() {
        QTemporaryDir root;
        helper(root.path(), "const rl=require('node:readline').createInterface({input:process.stdin});let first=true;rl.on('line',line=>{if(first){first=false;console.log('{\"event\":\"ready\"}')}else if(line==='proceed'){setTimeout(()=>{console.log('{\"event\":\"done\"}');rl.close()},100)}});");
        HostController host(root.path(), root.path(), root.path(), root.path(), false);
        host.m_bridge.setProgram(QStandardPaths::findExecutable("node"));
        QVERIFY(!host.m_bridge.program().isEmpty());
        QSignalSpy ready(&host, &HostController::exitReady);
        host.confirmExit(); host.confirmExit();
        QVERIFY(host.exiting()); QVERIFY(!host.exitApproved()); QCOMPARE(ready.size(), 0);
        QTRY_COMPARE_WITH_TIMEOUT(ready.size(), 1, 5000);
        QVERIFY(host.exitApproved()); QCOMPARE(host.m_exitWorker.state(), QProcess::NotRunning);
    }
    // HOST-UPDATE-01: incomplete cleanup must never authorize quit or start an installer.
    void cleanupFailureKeepsApplicationOpen() {
        QTemporaryDir root;
        helper(root.path(), "console.log(JSON.stringify({event:'error',message:'fixture cleanup refused'}));process.exit(1)");
        HostController host(root.path(), root.path(), root.path(), root.path(), false);
        host.m_bridge.setProgram(QStandardPaths::findExecutable("node"));
        QSignalSpy ready(&host, &HostController::exitReady);
        host.beginExit(root.path() + "/must-not-launch");
        QTRY_VERIFY_WITH_TIMEOUT(!host.exiting(), 5000);
        QCOMPARE(ready.size(), 0); QVERIFY(!host.exitApproved()); QVERIFY(host.m_exitInstaller.isEmpty());
        QCOMPARE(host.message(), "fixture cleanup refused");
        host.m_shutdown = true;
    }
    void cleanupTimeoutKeepsApplicationOpen() {
        QTemporaryDir root;
        helper(root.path(), "setInterval(()=>{},1000)");
        HostController host(root.path(), root.path(), root.path(), root.path(), false);
        host.m_bridge.setProgram(QStandardPaths::findExecutable("node"));
        QSignalSpy ready(&host, &HostController::exitReady);
        host.confirmExit();
        QTRY_COMPARE_WITH_TIMEOUT(host.m_exitWorker.state(), QProcess::Running, 5000);
        host.m_exitDeadline.start(20);
        QTRY_VERIFY_WITH_TIMEOUT(!host.exiting(), 5000);
        QCOMPARE(ready.size(), 0); QVERIFY(host.message().contains("超时"));
        host.m_shutdown = true;
    }
    void installerLaunchFailureDoesNotApproveExit() {
        QTemporaryDir root;
        helper(root.path(), "process.stdin.resume();process.stdin.on('data',()=>{console.log('{\"event\":\"done\"}');process.exit(0)})");
        HostController host(root.path(), root.path(), root.path(), root.path(), false);
        host.m_bridge.setProgram(QStandardPaths::findExecutable("node"));
        int launches = 0;
        host.m_installLauncher = [&](const QString &) { launches++; return false; };
        QSignalSpy ready(&host, &HostController::exitReady);
        host.beginExit(root.path() + "/installer");
        QTRY_VERIFY_WITH_TIMEOUT(!host.exiting(), 5000);
        QCOMPARE(launches, 1); QCOMPARE(ready.size(), 0); QVERIFY(!host.exitApproved()); QVERIFY(host.message().contains("无法打开"));
        host.m_shutdown = true;
    }
    // The native Quit event must use the same prompt as the tray and must not exit on cancellation.
    void nativeQuitIsGuarded() {
        bool approved = false; int requests = 0;
        QObject target; ExitGuard guard([&] { return approved; }, [&] { requests++; }); target.installEventFilter(&guard);
        QEvent quit(QEvent::Quit); QCoreApplication::sendEvent(&target, &quit); QCOMPARE(requests, 1); QVERIFY(!quit.isAccepted());
        approved = true; QEvent confirmed(QEvent::Quit); QCoreApplication::sendEvent(&target, &confirmed); QCOMPARE(requests, 1);
    }
    // A failed download must leave the running Host alone and permit a later retry.
    void downloadFailureDoesNotStartCleanup() {
        QTemporaryDir root; QTcpServer server; QVERIFY(server.listen(QHostAddress::LocalHost));
        connect(&server, &QTcpServer::newConnection, &server, [&] {
            auto *socket = server.nextPendingConnection();
            connect(socket, &QTcpSocket::readyRead, socket, [socket] { socket->readAll(); socket->write("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); socket->disconnectFromHost(); });
            connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
        });
        HostController host(root.path(), root.path(), root.path(), root.path(), false);
        host.m_shutdown = true; // This fixture never launches the real desktop bridge.
        host.m_updateVersion = "99.0.0";
        host.m_updateInstallerUrl = QString("http://127.0.0.1:%1/update").arg(server.serverPort()); host.m_updateChecksumUrl = host.m_updateInstallerUrl;
        host.confirmHostUpdate(); QVERIFY(host.m_updating);
        QTRY_VERIFY_WITH_TIMEOUT(!host.m_updating, 5000);
        QVERIFY(!host.exiting()); QVERIFY(!host.exitApproved()); QCOMPARE(host.m_exitWorker.state(), QProcess::NotRunning);
        QVERIFY(host.message().contains("下载失败"));
    }
    void verifiedUpdate_data() {
        QTest::addColumn<bool>("valid"); QTest::newRow("checksum-mismatch") << false; QTest::newRow("verified-install") << true;
    }
    // HOST-UPDATE-01: verify bytes before stopping anything and launch exactly once after cleanup completes.
    void verifiedUpdate() {
        QFETCH(bool, valid);
        QTemporaryDir root; QTcpServer server; QVERIFY(server.listen(QHostAddress::LocalHost));
        const QByteArray payload = "synthetic installer; never executed";
        const auto digest = valid ? QCryptographicHash::hash(payload, QCryptographicHash::Sha256).toHex() : QByteArray(64, '0');
        connect(&server, &QTcpServer::newConnection, &server, [&] {
            auto *socket = server.nextPendingConnection();
            connect(socket, &QTcpSocket::readyRead, socket, [=] {
                const auto request = socket->readAll(); const auto body = request.startsWith("GET /hash ") ? digest : payload;
                socket->write("HTTP/1.1 200 OK\r\nContent-Length: " + QByteArray::number(body.size()) + "\r\nConnection: close\r\n\r\n" + body);
                socket->disconnectFromHost();
            });
            connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
        });
        helper(root.path(), "const rl=require('node:readline').createInterface({input:process.stdin});let first=true;rl.on('line',()=>{if(first){first=false;console.log('{\"event\":\"ready\"}')}else{console.log('{\"event\":\"done\"}');rl.close()}});");
        HostController host(root.path(), root.path(), root.path(), root.path(), false);
        host.m_shutdown = true; host.m_bridge.setProgram(QStandardPaths::findExecutable("node"));
        host.m_updateVersion = "99.0.0";
        host.m_updateInstallerUrl = QString("http://127.0.0.1:%1/update.dmg").arg(server.serverPort());
        host.m_updateChecksumUrl = QString("http://127.0.0.1:%1/hash").arg(server.serverPort());
        int launches = 0; QString installed;
        host.m_installLauncher = [&](const QString &path) { launches++; installed = path; return host.m_exitWorkerDone; };
        QSignalSpy ready(&host, &HostController::exitReady);
        host.confirmHostUpdate(); host.confirmHostUpdate();
        QTRY_VERIFY_WITH_TIMEOUT(!host.m_updating, 5000);
        if (valid) {
            QTRY_COMPARE_WITH_TIMEOUT(ready.size(), 1, 5000); QCOMPARE(launches, 1);
            QFile file(installed); QVERIFY(file.open(QIODevice::ReadOnly)); QCOMPARE(file.readAll(), payload); file.close();
            QDir(QFileInfo(installed).absolutePath()).removeRecursively();
        } else {
            QCOMPARE(launches, 0); QCOMPARE(ready.size(), 0); QVERIFY(!host.exiting()); QVERIFY(host.message().contains("校验失败"));
        }
    }
    // An exit requested during a download still prompts; cancellation leaves that download alone.
    void exitWhileDownloading() {
        QTemporaryDir root; HostController host(root.path(), root.path(), root.path(), root.path(), false);
        host.m_shutdown = true; host.m_updating = true;
        QSignalSpy requested(&host, &HostController::exitConfirmationRequested), cancelled(&host, &HostController::exitCancelled);
        host.requestExit(); host.cancelExit(); QCOMPARE(requested.size(), 1); QCOMPARE(cancelled.size(), 1);
        QVERIFY(host.m_updating); QVERIFY(!host.exiting());
    }
};
QTEST_MAIN(HostExitTest)
#include "HostExitTest.moc"
