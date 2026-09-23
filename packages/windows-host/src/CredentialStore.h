#pragma once
#include <QJsonObject>
#include <QString>

class CredentialStore {
public:
    static bool save(const QString &path, const QJsonObject &value, QString *error = nullptr);
    static QJsonObject load(const QString &path, QString *error = nullptr);
};
