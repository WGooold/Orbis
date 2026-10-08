#include "CredentialStore.h"
#include <QFile>
#include <QSaveFile>
#include <QJsonDocument>
#include <QProcess>
#include <QFileInfo>
#ifdef Q_OS_WIN
#include <windows.h>
#include <wincrypt.h>
#endif

#ifdef Q_OS_MACOS
static QString keychainService() { return QStringLiteral("com.orbis.host.activation"); }
static QString keychainAccount(const QString &path) { return QFileInfo(path).absoluteFilePath(); }
static bool keychainWrite(const QString &path, const QByteArray &plain, QString *error) {
    const auto account = keychainAccount(path);
    QProcess remove;
    remove.start("security", {"delete-generic-password", "-s", keychainService(), "-a", account});
    remove.waitForFinished(5000);
    QProcess process;
    process.start("security", {"add-generic-password", "-U", "-s", keychainService(), "-a", account, "-w", QString::fromUtf8(plain)});
    if (!process.waitForFinished(10000) || process.exitCode() != 0) { if (error) *error = QStringLiteral("无法保存 macOS 钥匙串中的激活凭据"); return false; }
    return true;
}
static QByteArray keychainRead(const QString &path, QString *error) {
    QProcess process;
    process.start("security", {"find-generic-password", "-w", "-s", keychainService(), "-a", keychainAccount(path)});
    if (!process.waitForFinished(10000) || process.exitCode() != 0) { if (error) *error = QStringLiteral("无法读取 macOS 钥匙串中的激活凭据"); return {}; }
    return process.readAllStandardOutput().trimmed();
}
#endif

bool CredentialStore::save(const QString &path, const QJsonObject &value, QString *error) {
#ifdef Q_OS_WIN
    QByteArray plain = QJsonDocument(value).toJson(QJsonDocument::Compact);
    DATA_BLOB input{DWORD(plain.size()), reinterpret_cast<BYTE *>(plain.data())}, encrypted{};
    if (!CryptProtectData(&input, L"Orbis Host activation", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &encrypted)) {
        if (error) *error = QStringLiteral("Windows 无法保护激活凭据");
        return false;
    }
    QSaveFile file(path);
    const bool saved = file.open(QIODevice::WriteOnly)
        && file.write(reinterpret_cast<const char *>(encrypted.pbData), encrypted.cbData) == encrypted.cbData && file.commit();
    SecureZeroMemory(plain.data(), plain.size());
    LocalFree(encrypted.pbData);
    if (!saved && error) *error = QStringLiteral("无法保存激活凭据：") + file.errorString();
    return saved;
#else
#ifdef Q_OS_MACOS
    return keychainWrite(path, QJsonDocument(value).toJson(QJsonDocument::Compact), error);
#else
    Q_UNUSED(path); Q_UNUSED(value); if (error) *error = QStringLiteral("此版本的凭据存储仅支持 Windows 和 macOS"); return false;
#endif
#endif
}

QJsonObject CredentialStore::load(const QString &path, QString *error) {
    QFile file(path);
    if (!file.exists()) return {};
    if (!file.open(QIODevice::ReadOnly)) { if (error) *error = file.errorString(); return {}; }
#ifdef Q_OS_WIN
    QByteArray encrypted = file.readAll();
    DATA_BLOB input{DWORD(encrypted.size()), reinterpret_cast<BYTE *>(encrypted.data())}, plain{};
    if (!CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &plain)) {
        if (error) *error = QStringLiteral("无法解密激活凭据，请使用原 Windows 账户，或重新验证 QQ 邮箱");
        return {};
    }
    QJsonParseError parseError;
    const auto value = QJsonDocument::fromJson(QByteArray(reinterpret_cast<const char *>(plain.pbData), plain.cbData), &parseError).object();
    SecureZeroMemory(plain.pbData, plain.cbData);
    LocalFree(plain.pbData);
    if (parseError.error != QJsonParseError::NoError && error) *error = QStringLiteral("激活凭据已损坏，请重新验证邮箱");
    return value;
#else
#ifdef Q_OS_MACOS
    const auto plain = keychainRead(path, error); if (plain.isEmpty()) return {};
    QJsonParseError parseError;
    const auto value = QJsonDocument::fromJson(plain, &parseError).object();
    if (parseError.error != QJsonParseError::NoError && error) *error = QStringLiteral("激活凭据已损坏，请重新验证邮箱");
    return value;
#else
    if (error) *error = QStringLiteral("此版本的凭据存储仅支持 Windows 和 macOS"); return {};
#endif
#endif
}
