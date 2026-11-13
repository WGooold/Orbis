#include "CredentialStore.h"
#include <QFile>
#include <QSaveFile>
#include <QJsonDocument>
#include <QFileInfo>
#include <QUuid>
#include <QDir>
#include <QCryptographicHash>
#include <QJsonArray>
#include <QUrl>
#ifdef Q_OS_WIN
#include <windows.h>
#include <wincrypt.h>
#endif

#include <QtGlobal>

// QA 构建每次重新签名后，macOS 会为钥匙串条目重新要求人工授权；隔离测试
// 用 ORBIS_NO_KEYCHAIN=1 把激活凭据存在激活文件旁边，不碰钥匙串与 DPAPI。
static bool plainFileStore() {
    const auto value = qgetenv("ORBIS_NO_KEYCHAIN");
    return value == "1" || value == "true";
}

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
    if (plainFileStore()) {
        QSaveFile file(path);
        if (!file.open(QIODevice::WriteOnly)) {
            if (error) *error = QStringLiteral("无法保存激活凭据：") + file.errorString();
            return false;
        }
        file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner);
        const auto plain = QJsonDocument(value).toJson(QJsonDocument::Compact);
        if (file.write(plain) != plain.size() || !file.commit()) {
            if (error) *error = QStringLiteral("无法保存激活凭据：") + file.errorString();
            return false;
        }
        return true;
    }
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

bool CredentialStore::clear(const QString &path, QString *error) {
    QFile file(path);
    if (!file.exists()) return true;
    if (plainFileStore()) {
        if (!file.remove()) { if (error) *error = file.errorString(); return false; }
        return true;
    }
#ifdef Q_OS_MACOS
    if (!file.open(QIODevice::ReadOnly)) { if (error) *error = file.errorString(); return false; }
    const auto reference = file.readAll();
    file.close();
#endif
    if (!file.remove()) { if (error) *error = file.errorString(); return false; }
#ifdef Q_OS_MACOS
    keychainRemove(path, reference);
#endif
    return true;
}

QJsonObject CredentialStore::load(const QString &path, QString *error) {
    QFile file(path);
    if (!file.exists()) return {};
    if (!file.open(QIODevice::ReadOnly)) { if (error) *error = file.errorString(); return {}; }
    if (plainFileStore()) {
        QJsonParseError parseError;
        const auto value = QJsonDocument::fromJson(file.readAll(), &parseError).object();
        if (parseError.error != QJsonParseError::NoError && error) *error = QStringLiteral("激活凭据已损坏，请重新验证邮箱");
        return value;
    }
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

QString CredentialStore::normalizedRelay(const QString &relay) {
    QUrl url(relay.trimmed());
    if ((url.scheme() == "wss" && url.port() == 443) || (url.scheme() == "ws" && url.port() == 80)) url.setPort(-1);
    auto result = url.toString(QUrl::FullyEncoded);
    while (result.endsWith('/')) result.chop(1);
    return result;
}

static QString activationArchivePath(const QString &path, const QString &relay, const QString &hostId) {
    const auto key = QJsonDocument(QJsonArray{CredentialStore::normalizedRelay(relay), hostId}).toJson(QJsonDocument::Compact);
    return QFileInfo(path).absolutePath() + "/relay-activations/" +
        QString::fromLatin1(QCryptographicHash::hash(key, QCryptographicHash::Sha256).toHex()) + ".dat";
}

QJsonObject CredentialStore::selectActivation(const QString &path, const QString &relay, const QString &hostId, QString *error) {
    error->clear();
    const auto endpoint = normalizedRelay(relay);
    const auto matches = [&](const QJsonObject &value) {
        return normalizedRelay(value.value("relayUrl").toString()) == endpoint && value.value("hostId").toString() == hostId;
    };
    auto current = load(path, error);
    if (!error->isEmpty()) return {};
    if (matches(current)) {
        if (current.value("relayUrl").toString() != endpoint) {
            current.insert("relayUrl", endpoint);
            if (!save(path, current, error)) return {};
        }
        return current;
    }
    const auto directory = QFileInfo(path).absolutePath() + "/relay-activations";
    if (!current.value("relayUrl").toString().isEmpty() && !current.value("hostId").toString().isEmpty()) {
        if (!QDir().mkpath(directory)) { *error = "无法保存原服务器的激活凭据"; return {}; }
        // The active slot is authoritative, including credential-less recovery state
        // and credentials rotated by an older client after a rollback.
        if (!save(activationArchivePath(path, current.value("relayUrl").toString(), current.value("hostId").toString()), current, error)) return {};
    }
    auto selected = hostId.isEmpty() ? QJsonObject() : load(activationArchivePath(path, endpoint, hostId), error);
    if (!error->isEmpty()) return {};
    if (!selected.isEmpty() && !matches(selected)) { *error = "保存的激活凭据与服务器或电脑身份不匹配"; return {}; }
    selected.insert("relayUrl", endpoint); selected.insert("hostId", hostId);
    // Atomic replacement: if either archive or selection fails, the previous active
    // slot remains intact and the caller must keep its previous Relay selected.
    if (!save(path, selected, error)) return {};
    return selected;
}

bool CredentialStore::invalidateActivation(const QString &path, const QJsonObject &recovery, QString *error) {
    error->clear();
    // Also replace an archived copy: clearing an unreadable active slot must never
    // make a previously rejected credential eligible for restoration.
    const auto archive = activationArchivePath(path, recovery.value("relayUrl").toString(), recovery.value("hostId").toString());
    for (const auto &target : {archive, path}) {
        QString saveError, clearError;
        if (QDir().mkpath(QFileInfo(target).absolutePath()) && save(target, recovery, &saveError)) continue;
        if (!clear(target, &clearError)) *error += clearError + '\n';
    }
    return error->isEmpty();
}
