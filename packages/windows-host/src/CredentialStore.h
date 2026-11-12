#pragma once
#include <QJsonObject>
#include <QString>

class CredentialStore {
public:
    static bool save(const QString &path, const QJsonObject &value, QString *error = nullptr);
    static QJsonObject load(const QString &path, QString *error = nullptr);
    static bool clear(const QString &path, QString *error = nullptr);
    static QString normalizedRelay(const QString &relay);
    // Run on the credential worker: archive the current slot before selecting another
    // Relay/Host pair. The active slot retains the format read by released clients.
    static QJsonObject selectActivation(const QString &path, const QString &relay, const QString &hostId, QString *error);
    static bool invalidateActivation(const QString &path, const QJsonObject &recovery, QString *error);
};
