#include "../HostController.h"
#include "../QaActivation.h"
#include <QFile>
#include <QJsonDocument>
#include <QScopeGuard>
#include <QTemporaryDir>
#include <QtTest>

// HOST-QA-01: QA packages use their own credential and data even when production
// credentials/environment are present; a broken package never falls back to them.
class HostQaActivationTest : public QObject {
    Q_OBJECT
    static QJsonObject manifest() {
        return {{"version", 1}, {"environmentId", "native-qa-fixture"},
                {"relayUrl", "wss://qa.example.test:18443"}, {"credential", "qa-fixture-credential-123456"}};
    }
    static void write(const QString &path, const QByteArray &content) {
        QDir().mkpath(QFileInfo(path).absolutePath());
        QFile file(path); QVERIFY(file.open(QIODevice::WriteOnly)); QCOMPARE(file.write(content), content.size());
    }
    static QByteArray read(const QString &path) {
        QFile file(path); return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray();
    }
    static void bridge(const QString &root) {
        write(root + "/packages/host/dist/desktop-bridge.js", R"JS(
const fs = require('node:fs'), path = require('node:path');
const out = result => process.stdout.write(JSON.stringify(result) + '\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const {id,method,params} = JSON.parse(line);
  if (method === 'initialize') {
    fs.writeFileSync(path.join(__dirname,'initialize.json'),JSON.stringify({params,env:process.env}));
    return out({id,result:{hostId:'qa-isolated-host',hostName:'QA fixture',hostPub:'qa-public-key',devices:[],nodeVersion:process.version}});
  }
  if (method === 'start') {
    fs.writeFileSync(path.join(__dirname,'start.json'),JSON.stringify(params));
    out({event:'state',state:'connected'});
  }
  out({id,result:method==='detect'?[]:{}});
});
)JS");
    }
private slots:
    void usesPackagedActivationWithoutCredentialStore() {
        QTemporaryDir temp;
        const auto runtime = temp.path() + "/runtime", data = temp.path() + "/qa", formal = temp.path() + "/formal";
        write(runtime + "/qa-activation.json", QJsonDocument(manifest()).toJson());
        write(formal + "/activation.dat", "formal-credential-sentinel");
        bridge(runtime);
        int reads = 0;
        HostController::s_credentialLoader = [&reads](const QString &, QString *) { ++reads; return QJsonObject(); };
        const auto reset = qScopeGuard([] { HostController::s_credentialLoader = {}; });
        const auto oldKey = qgetenv("ANTHROPIC_API_KEY"), oldProvider = qgetenv("ORBIS_PROVIDER_TEST_ROOT");
        qputenv("ANTHROPIC_API_KEY", "formal-key-fixture"); qputenv("ORBIS_PROVIDER_TEST_ROOT", formal.toUtf8());
        const auto restoreEnv = qScopeGuard([oldKey, oldProvider] {
            if (oldKey.isNull()) qunsetenv("ANTHROPIC_API_KEY"); else qputenv("ANTHROPIC_API_KEY", oldKey);
            if (oldProvider.isNull()) qunsetenv("ORBIS_PROVIDER_TEST_ROOT"); else qputenv("ORBIS_PROVIDER_TEST_ROOT", oldProvider);
        });
        HostController host(runtime, data, {}, formal, true);
        QTRY_COMPARE_WITH_TIMEOUT(host.state(), QString("connected"), 10000);
        QCOMPARE(reads, 0);
        QVERIFY(host.activated()); QVERIFY(!host.credentialsLoading()); QVERIFY(!host.m_automaticIntegrations);
        QCOMPARE(host.relayUrl(), manifest().value("relayUrl").toString());
        QCOMPARE(host.m_credential, manifest().value("credential").toString());
        QCOMPARE(host.m_credentialDir, data);
        QCOMPARE(read(formal + "/activation.dat"), QByteArray("formal-credential-sentinel"));
        QVERIFY(!QFile::exists(data + "/activation.dat"));
        const auto initialization = QJsonDocument::fromJson(read(runtime + "/packages/host/dist/initialize.json")).object();
        QVERIFY(!initialization.value("params").toObject().value("claudeIntegrationEnabled").toBool());
        const auto env = initialization.value("env").toObject();
        QCOMPARE(env.value("ORBIS_QA_HOME").toString(), data + "/home");
        QCOMPARE(env.value("HOME").toString(), data + "/home");
        QCOMPARE(env.value("ORBIS_HOST_STATE_DIR").toString(), data + "/host");
        QCOMPARE(env.value("ORBIS_PROVIDER_TEST_ROOT").toString(), data + "/home");
        QCOMPARE(env.value("ORBIS_NO_KEYCHAIN").toString(), QString("1"));
        QVERIFY(!env.contains("ANTHROPIC_API_KEY"));
        const auto start = QJsonDocument::fromJson(read(runtime + "/packages/host/dist/start.json")).object();
        QCOMPARE(start.value("credential"), manifest().value("credential"));
        QVERIFY(!host.hostUpdateAvailable());
        host.setAutoStart(true); QVERIFY(!host.autoStart());
        QTRY_VERIFY(!host.busy());
        host.saveSettings("wss://formal.example.test", false, false, "", false, "", false, false);
        QCOMPARE(host.relayUrl(), manifest().value("relayUrl").toString());
        host.invalidateActivation();
        QVERIFY(!host.activated()); QCOMPARE(host.state(), QString("error"));
        host.appendLog("refused " + manifest().value("credential").toString());
        QVERIFY(!host.diagnostics().contains(manifest().value("credential").toString()));
        QVERIFY(!QFile::exists(data + "/activation.dat"));
        QCOMPARE(read(formal + "/activation.dat"), QByteArray("formal-credential-sentinel"));
    }
    void invalidPackageCannotStartOrLoadFormalCredentials() {
        QTemporaryDir temp;
        int reads = 0;
        HostController::s_credentialLoader = [&reads](const QString &, QString *) { ++reads; return manifest(); };
        const auto reset = qScopeGuard([] { HostController::s_credentialLoader = {}; });
        HostController host(temp.path() + "/missing", temp.path() + "/qa", {}, temp.path() + "/formal");
        QCoreApplication::processEvents();
        QCOMPARE(reads, 0); QVERIFY(!host.activated()); QCOMPARE(host.state(), QString("error"));
        QCOMPARE(host.m_bridge.state(), QProcess::NotRunning);
        QVERIFY(host.message().contains("重新打包"));
    }
    void rejectsMalformedActivation_data() {
        QTest::addColumn<QJsonObject>("value");
        auto value = manifest(); value["environmentId"] = "../formal"; QTest::newRow("escaped-directory") << value;
        value = manifest(); value["credential"] = "bad\ncredential-123456"; QTest::newRow("multiline-credential") << value;
        value = manifest(); value["relayUrl"] = "wss://user:secret@example.test"; QTest::newRow("url-userinfo") << value;
        value = manifest(); value["relayUrl"] = "ws://remote.example.test"; QTest::newRow("remote-plaintext") << value;
        value = manifest(); value["version"] = 2; QTest::newRow("unknown-version") << value;
    }
    void rejectsMalformedActivation() {
        QFETCH(QJsonObject, value);
        QTemporaryDir temp;
        write(temp.path() + "/qa-activation.json", QJsonDocument(value).toJson());
        QString error;
        QVERIFY(!QaActivation::load(temp.path(), &error));
        QVERIFY(!error.contains(value.value("credential").toString()));
    }
};

QTEST_MAIN(HostQaActivationTest)
#include "HostQaActivationTest.moc"
