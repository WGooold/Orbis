#include "../CredentialStore.h"
#include <QFile>
#include <QJsonDocument>
#include <QTemporaryDir>
#include <QtTest>

class CredentialStoreTest : public QObject {
    Q_OBJECT
private slots:
    void credentialsAreEncryptedAndRecoverable() {
        QTemporaryDir temp;
        const auto path = temp.path() + "/activation.dat";
        const QJsonObject original{{"credential", "a-secret-that-must-not-be-readable"}, {"email", "test@qq.com"}};
        QString error;
        QVERIFY2(CredentialStore::save(path, original, &error), qPrintable(error));
        QFile file(path); QVERIFY(file.open(QIODevice::ReadOnly)); const auto encrypted = file.readAll(); file.close();
        QVERIFY(!encrypted.contains("a-secret-that-must-not-be-readable"));
        QVERIFY(!encrypted.contains("test@qq.com"));
        QCOMPARE(CredentialStore::load(path, &error), original);
        QVERIFY(error.isEmpty());
    }
    void tamperingDoesNotSilentlyActivate() {
        QTemporaryDir temp;
        const auto path = temp.path() + "/activation.dat";
        QFile file(path); QVERIFY(file.open(QIODevice::WriteOnly)); file.write("invalid activation bytes"); file.close();
        QString error;
        QVERIFY(CredentialStore::load(path, &error).isEmpty());
        QVERIFY(!error.isEmpty());
    }
    // 隔离测试：QA 构建每次重新签名，钥匙串会反复要求人工授权，因此允许改存文件。
    void isolatedRunsCanSkipTheKeychain() {
        QTemporaryDir temp;
        const auto path = temp.path() + "/activation.dat";
        qputenv("ORBIS_NO_KEYCHAIN", "1");
        const QJsonObject value{{"credential", "isolated-secret"}, {"email", "qa@qq.com"}};
        QString error;
        QVERIFY2(CredentialStore::save(path, value, &error), qPrintable(error));
        QFile file(path); QVERIFY(file.open(QIODevice::ReadOnly)); const auto plain = file.readAll(); file.close();
        QCOMPARE(QJsonDocument::fromJson(plain).object(), value);
        QCOMPARE(CredentialStore::load(path, &error), value);
        QVERIFY(CredentialStore::clear(path, &error));
        QVERIFY(!QFile::exists(path));
        qunsetenv("ORBIS_NO_KEYCHAIN");
    }
    void updatedCredentialsReplacePreviousValue() {
        QTemporaryDir temp;
        const auto path = temp.path() + "/activation.dat";
        QString error;
        QVERIFY2(CredentialStore::save(path, {{"credential", "old-secret"}}, &error), qPrintable(error));
        const QJsonObject updated{{"credential", "new-secret"}};
        QVERIFY2(CredentialStore::save(path, updated, &error), qPrintable(error));
        QCOMPARE(CredentialStore::load(path, &error), updated);
        QVERIFY(QFile::remove(path));
        QVERIFY(CredentialStore::load(path, &error).isEmpty());
    }
};
QTEST_GUILESS_MAIN(CredentialStoreTest)
#include "CredentialStoreTest.moc"
