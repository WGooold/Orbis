#pragma once
#include <QString>

// Writes only the supplied path; the caller selects the current user's login location.
bool writeLoginAgent(const QString &path, const QString &program, bool enabled, QString *error);
