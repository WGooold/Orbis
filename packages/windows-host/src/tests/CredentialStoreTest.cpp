#include "../CredentialStore.h"
#include <QFile>
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
};
QTEST_GUILESS_MAIN(CredentialStoreTest)
#include "CredentialStoreTest.moc"
