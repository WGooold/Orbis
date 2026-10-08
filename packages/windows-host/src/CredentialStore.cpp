#include "CredentialStore.h"
#include <QFile>
#include <QSaveFile>
#include <QJsonDocument>
#include <QFileInfo>
#include <QUuid>
#ifdef Q_OS_WIN
#include <windows.h>
#include <wincrypt.h>
#endif

#ifdef Q_OS_MACOS
#include <Security/Security.h>

// activation.dat contains only a random reference; secrets stay in the user's Keychain.
// Stage a new item before atomically replacing the reference, so a failed save keeps
// the previous credential usable. Never put credentials in a subprocess command line.
static CFMutableDictionaryRef keychainQuery(const QString &path, const QByteArray &reference) {
    auto query = CFDictionaryCreateMutable(nullptr, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    const auto account = QFileInfo(path).absoluteFilePath().toUtf8() + ":" + reference;
    auto accountString = CFStringCreateWithBytes(nullptr, reinterpret_cast<const UInt8 *>(account.constData()), account.size(), kCFStringEncodingUTF8, false);
    CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query, kSecAttrService, CFSTR("com.orbis.host.activation"));
    CFDictionarySetValue(query, kSecAttrAccount, accountString);
    CFRelease(accountString);
    return query;
}
static bool validReference(const QByteArray &reference) {
    return reference.size() == 36 && QUuid(QString::fromLatin1(reference)).toString(QUuid::WithoutBraces).toLatin1() == reference;
}
static void keychainRemove(const QString &path, const QByteArray &reference) {
    if (!validReference(reference)) return;
    auto query = keychainQuery(path, reference);
    SecItemDelete(query);
    CFRelease(query);
}
static bool keychainWrite(const QString &path, const QByteArray &plain, QString *error) {
    QByteArray previous;
    QFile oldFile(path);
    if (oldFile.open(QIODevice::ReadOnly)) previous = oldFile.readAll();
    oldFile.close();
    const auto reference = QUuid::createUuid().toString(QUuid::WithoutBraces).toLatin1();
    auto query = keychainQuery(path, reference);
    auto data = CFDataCreate(nullptr, reinterpret_cast<const UInt8 *>(plain.constData()), plain.size());
    CFDictionarySetValue(query, kSecValueData, data);
    const auto status = SecItemAdd(query, nullptr);
    CFRelease(data);
    CFRelease(query);
    if (status != errSecSuccess) {
        if (error) *error = QStringLiteral("无法保存 macOS 钥匙串中的激活凭据（%1）").arg(status);
        return false;
    }
    QSaveFile file(path);
    if (!file.open(QIODevice::WriteOnly) || file.write(reference) != reference.size() || !file.commit()) {
        keychainRemove(path, reference);
        if (error) *error = QStringLiteral("无法保存激活凭据引用：") + file.errorString();
        return false;
    }
    keychainRemove(path, previous);
    return true;
}
static QByteArray keychainRead(const QString &path, const QByteArray &reference, QString *error) {
    if (!validReference(reference)) {
        if (error) *error = QStringLiteral("激活凭据引用已损坏，请重新验证邮箱");
        return {};
    }
    auto query = keychainQuery(path, reference);
    CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
    CFTypeRef result = nullptr;
    const auto status = SecItemCopyMatching(query, &result);
    CFRelease(query);
    if (status != errSecSuccess) {
        if (error) *error = QStringLiteral("无法读取 macOS 钥匙串中的激活凭据（%1）").arg(status);
        return {};
    }
    const auto data = static_cast<CFDataRef>(result);
    const QByteArray plain(reinterpret_cast<const char *>(CFDataGetBytePtr(data)), CFDataGetLength(data));
    CFRelease(result);
    return plain;
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
    const auto plain = keychainRead(path, file.readAll(), error); if (plain.isEmpty()) return {};
    QJsonParseError parseError;
    const auto value = QJsonDocument::fromJson(plain, &parseError).object();
    if (parseError.error != QJsonParseError::NoError && error) *error = QStringLiteral("激活凭据已损坏，请重新验证邮箱");
    return value;
#else
    if (error) *error = QStringLiteral("此版本的凭据存储仅支持 Windows 和 macOS"); return {};
#endif
#endif
}
