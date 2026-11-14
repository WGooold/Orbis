#pragma once
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcessEnvironment>
#include <QRegularExpression>
#include <QUrl>
#include <optional>

// HOST-QA-01: a QA package owns its activation and all runtime data. This file is
// supplied at packaging time; it is never a substitute for production activation.
struct QaActivation {
    QString environmentId;
    QString relayUrl;
    QString credential;

    static std::optional<QaActivation> load(const QString &runtimeRoot, QString *error) {
        QFile file(runtimeRoot + "/qa-activation.json");
        if (!file.open(QIODevice::ReadOnly) || file.size() > 16384) {
            if (error) *error = "测试包缺少有效激活配置，请重新打包";
            return std::nullopt;
        }
        const auto document = QJsonDocument::fromJson(file.readAll());
        const auto value = document.object();
        const auto id = value.value("environmentId").toString();
        const auto relay = value.value("relayUrl").toString();
        const auto credential = value.value("credential").toString();
        const QUrl endpoint(relay);
        const bool loopback = endpoint.host() == "localhost" || endpoint.host() == "127.0.0.1" || endpoint.host() == "::1";
        if (!document.isObject() || value.value("version") != QJsonValue(1)
            || !QRegularExpression("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$").match(id).hasMatch()
            || credential.size() < 16 || credential.size() > 512 || credential.contains('\r') || credential.contains('\n')
            || !endpoint.isValid() || endpoint.host().isEmpty() || !endpoint.userInfo().isEmpty()
            || endpoint.hasQuery() || endpoint.hasFragment()
            || (endpoint.scheme() != "wss" && !(endpoint.scheme() == "ws" && loopback))) {
            if (error) *error = "测试包激活配置无效，请重新打包";
            return std::nullopt;
        }
        return QaActivation{id, relay, credential};
    }

    static bool prepareDirectories(const QString &dataDir) {
        for (const auto &relative : {"host", "home/.pi/agent/sessions", "home/.claude", "home/.codex", "home/.dsh",
                                     "home/.config", "home/.cache", "home/.local/share", "workspace"}) {
            if (!QDir().mkpath(dataDir + '/' + relative)) return false;
        }
        return true;
    }

    static QProcessEnvironment processEnvironment(const QString &runtimeRoot, const QString &dataDir, const QString &hostStateDir) {
        // Preserve executable/toolchain discovery, not the caller's model keys,
        // production service tokens or backend configuration directories.
        const auto inherited = QProcessEnvironment::systemEnvironment();
        QProcessEnvironment env;
        for (const auto &key : {"PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TMP", "TEMP", "TMPDIR"}) {
            if (inherited.contains(key)) env.insert(key, inherited.value(key));
        }
        const auto home = dataDir + "/home";
        env.insert("HOME", home); env.insert("USERPROFILE", home);
        env.insert("APPDATA", home + "/.config"); env.insert("LOCALAPPDATA", home + "/.local/share");
        env.insert("XDG_CONFIG_HOME", home + "/.config"); env.insert("XDG_CACHE_HOME", home + "/.cache");
        env.insert("XDG_DATA_HOME", home + "/.local/share");
        env.insert("ORBIS_QA_HOME", home);
        env.insert("ORBIS_QA_ACTIVATION_FILE", runtimeRoot + "/qa-activation.json");
        env.insert("ORBIS_NO_KEYCHAIN", "1");
        env.insert("ORBIS_HOST_STATE_DIR", hostStateDir); env.insert("ORBIS_STATE_DIR", hostStateDir);
        env.insert("ORBIS_PROVIDER_TEST_ROOT", home);
        env.insert("CLAUDE_CONFIG_DIR", home + "/.claude"); env.insert("CODEX_HOME", home + "/.codex");
        env.insert("DSH_HOME", home + "/.dsh"); env.insert("PI_CODING_AGENT_DIR", home + "/.pi/agent");
        env.insert("PI_OFFLINE", "1"); env.insert("PI_SKIP_VERSION_CHECK", "1");
        return env;
    }
};
