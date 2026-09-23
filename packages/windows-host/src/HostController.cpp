#include "HostController.h"
#include "CredentialStore.h"
#include <QCoreApplication>
#include <QApplication>
#include <QClipboard>
#include <QDateTime>
#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QJsonArray>
#include <QJsonDocument>
#include <QNetworkReply>
#include <QRegularExpression>
#include <QSaveFile>
#include <QStandardPaths>
#include <QVersionNumber>

static QString friendlyError(const QString &code) {
    static const QHash<QString, QString> messages{
        {"qq_email_required", "请填写有效的 @qq.com 邮箱"},
        {"registration_unavailable", "注册服务暂未启用：服务器尚未配置邮件发送服务。请稍后再试。"},
        {"email_verification_required", "服务器现在要求验证 QQ 邮箱，请获取验证码后重试"},
        {"verification_delivery_failed", "验证码发送失败，请稍后重试或联系服务维护者"},
        {"invalid_verification_code", "验证码错误、已过期或已使用，请重新获取"},
        {"host_already_registered", "这台电脑已注册；无法直接覆盖现有凭据"},
        {"code_cooldown", "验证码已发送，请等待 60 秒后再试"},
        {"too_many_requests", "请求次数过多，请稍后重试"},
        {"registration_busy", "注册服务繁忙，请稍后重试"},
        {"not_found", "服务器尚未支持邮箱注册，请更新 Relay 或检查服务器地址"}
    };
    return messages.value(code, code);
}

static bool validRelay(const QString &value) {
    QUrl url(value);
    return url.isValid() && !url.host().isEmpty() && url.userInfo().isEmpty() && !url.hasQuery() && !url.hasFragment()
        && (url.scheme() == "wss" || (url.scheme() == "ws" && (url.host() == "localhost" || url.host() == "127.0.0.1" || url.host() == "::1")));
}

HostController::HostController(QString runtimeRoot, QString dataDir, QString hostStateDir, QObject *parent)
    : QObject(parent), m_runtimeRoot(std::move(runtimeRoot)), m_dataDir(std::move(dataDir)), m_hostStateDir(std::move(hostStateDir)),
      m_settings(m_dataDir + "/settings.ini", QSettings::IniFormat) {
    QDir().mkpath(m_dataDir);
    QString error;
    auto stored = CredentialStore::load(m_dataDir + "/activation.dat", &error);
    // An upgrade must retain an activated installation's endpoint even when the
    // compiled default changes. Fresh installs still use ORBIS_DEFAULT_RELAY.
    if (!m_settings.contains("relayUrl") && validRelay(stored.value("relayUrl").toString())) {
        m_settings.setValue("relayUrl", stored.value("relayUrl").toString());
    }
    if (stored.value("relayUrl").toString() == relayUrl()) {
        m_email = stored.value("email").toString();
        m_credential = stored.value("credential").toString();
        m_hostId = stored.value("hostId").toString();
    }
    if (!error.isEmpty()) setMessage(error);
    connect(&m_bridge, &QProcess::started, this, [this] {
        command("initialize", {}, [this](const QJsonValue &result) {
            const auto obj = result.toObject();
            const auto actualId = obj.value("hostId").toString();
            if (!m_hostId.isEmpty() && m_hostId != actualId) { m_credential.clear(); setMessage("电脑身份与激活凭据不匹配，请重新验证邮箱"); }
            m_hostId = actualId; m_hostName = obj.value("hostName").toString();
            m_devices = obj.value("devices").toArray().toVariantList();
            m_bridgeReady = true;
            refreshRegistrationPolicy();
            appendLog("Host 核心已就绪 · " + obj.value("nodeVersion").toString());
            detectAgents();
            if (activated() && m_settings.value("runHost", true).toBool()) startHost();
            emit changed();
        });
    });
    connect(&m_bridge, &QProcess::readyReadStandardOutput, this, [this] {
        m_stdout += m_bridge.readAllStandardOutput();
        if (m_stdout.size() > 4 * 1024 * 1024) { m_stdout.clear(); setMessage("Host 返回了过大的消息"); return; }
        int newline;
        while ((newline = m_stdout.indexOf('\n')) >= 0) {
            const auto line = m_stdout.left(newline); m_stdout.remove(0, newline + 1);
            const auto document = QJsonDocument::fromJson(line);
            if (document.isObject()) receiveLine(document.object());
        }
    });
    connect(&m_bridge, &QProcess::readyReadStandardError, this, [this] { appendLog(QString::fromUtf8(m_bridge.readAllStandardError()).trimmed()); });
    connect(&m_bridge, &QProcess::errorOccurred, this, [this](QProcess::ProcessError error) {
        if (error == QProcess::FailedToStart) { m_state = "error"; setMessage("无法启动内置 Host：" + m_bridge.errorString()); }
    });
    connect(&m_bridge, &QProcess::finished, this, [this](int code, QProcess::ExitStatus) {
        m_bridgeReady = false; m_desiredRunning = false; m_pending.clear(); m_methods.clear(); m_busy = 0; m_qr.clear();
        if (m_shutdown) return;
        m_state = "error";
        setMessage(QString("Host 核心已退出（%1）").arg(code));
        if (++m_crashes <= 3) QTimer::singleShot(3000 * m_crashes, this, [this] { if (!m_shutdown) launchBridge(); });
    });
    connect(&m_tick, &QTimer::timeout, this, [this] {
        if (m_cooldown > 0) --m_cooldown;
        if (!m_qr.isEmpty() && pairSeconds() <= 0) { m_qr.clear(); command("cancelPair"); }
        if (!activated() && ++m_policyTicks >= 30) { m_policyTicks = 0; refreshRegistrationPolicy(); }
        emit changed();
    });
    m_tick.start(1000);
    QTimer::singleShot(0, this, &HostController::launchBridge);
}

HostController::~HostController() { shutdown(); }
int HostController::pairSeconds() const { return int(qMax<qint64>(0, (m_pairExpires - QDateTime::currentMSecsSinceEpoch() + 999) / 1000)); }
void HostController::launchBridge() {
    if (m_bridge.state() != QProcess::NotRunning) return;
    QString node = m_runtimeRoot + "/node/node.exe";
    if (!QFile::exists(node)) node = QStandardPaths::findExecutable("node.exe");
    const auto entry = m_runtimeRoot + "/packages/host/dist/desktop-bridge.js";
    if (node.isEmpty() || !QFile::exists(entry)) { m_state = "error"; setMessage("安装不完整：未找到内置 Host 或 Node.js，请重新安装客户端"); return; }
    auto env = QProcessEnvironment::systemEnvironment();
    if (!m_hostStateDir.isEmpty()) env.insert("ORBIS_HOST_STATE_DIR", m_hostStateDir);
    m_bridge.setProcessEnvironment(env);
    m_bridge.setWorkingDirectory(m_runtimeRoot);
    m_bridge.setProgram(node); m_bridge.setArguments({entry});
    m_stdout.clear();
    m_bridge.start();
}
void HostController::command(const QString &method, const QJsonObject &params, Callback done) {
    if (m_bridge.state() != QProcess::Running) { setMessage("Host 核心尚未就绪"); return; }
    int id = m_nextId++;
    m_pending.insert(id, std::move(done)); m_methods.insert(id, method); ++m_busy;
    m_bridge.write(QJsonDocument(QJsonObject{{"id", id}, {"method", method}, {"params", params}}).toJson(QJsonDocument::Compact) + '\n');
    emit changed();
}
void HostController::receiveLine(const QJsonObject &line) {
    if (line.contains("id")) {
        int id = line.value("id").toInt();
        if (!m_pending.contains(id)) return;
        auto callback = m_pending.take(id); auto method = m_methods.take(id); m_busy = qMax(0, m_busy - 1);
        if (line.contains("error")) { if (method == "start") { m_desiredRunning = false; m_state = "error"; } setMessage(line.value("error").toString()); }
        else if (callback) callback(line.value("result"));
    } else {
        const auto event = line.value("event").toString();
        if (event == "state") { m_state = line.value("state").toString(); if (m_state == "error") m_desiredRunning = false; if (line.contains("message")) setMessage(line.value("message").toString()); }
        else if (event == "log") appendLog(line.value("message").toString());
        else if (event == "status") { m_devices = line.value("devices").toArray().toVariantList(); m_runtimeCount = line.value("runtimeCount").toInt(); }
        else if (event == "paired") { m_qr.clear(); m_pairExpires = 0; setMessage("手机配对成功，现在可以在手机上使用 Orbis"); emit paired(); emit notification("Orbis", "新手机已配对"); }
    }
    emit changed();
}
void HostController::api(const QString &endpoint, const QJsonObject &body, Callback done) {
    if (!validRelay(relayUrl())) { setMessage("请在设置中填写有效的 wss:// 中继地址"); return; }
    QUrl url(relayUrl() + endpoint); url.setScheme(url.scheme() == "wss" ? "https" : "http");
    QNetworkRequest request(url); request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    request.setTransferTimeout(30000);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
    auto *reply = m_network.post(request, QJsonDocument(body).toJson(QJsonDocument::Compact));
    ++m_busy; emit changed();
    connect(reply, &QNetworkReply::finished, this, [this, reply, done = std::move(done)] {
        m_busy = qMax(0, m_busy - 1);
        auto result = QJsonDocument::fromJson(reply->readAll());
        int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        if (status >= 200 && status < 300 && result.isObject()) done(result.object());
        else if (result.object().contains("error")) {
            const auto code = result.object().value("error").toString();
            if (code == "email_verification_required") { m_verificationRequired = true; emit changed(); }
            setMessage(friendlyError(code));
        }
        else setMessage("无法连接注册服务：" + reply->errorString());
        reply->deleteLater(); emit changed();
    });
}
void HostController::requestCode(const QString &email) {
    const auto normalized = email.trimmed().toLower();
    if (!QRegularExpression("^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@qq\\.com$").match(normalized).hasMatch()) { setMessage("注册仅支持 @qq.com 邮箱"); return; }
    if (!m_bridgeReady || m_cooldown > 0 || busy()) return;
    api("/v1/registration/code", {{"email", normalized}, {"hostId", m_hostId}}, [this, normalized](const QJsonValue &value) {
        m_challenge = value.toObject().value("challengeId").toString(); m_challengeEmail = normalized;
        m_cooldown = value.toObject().value("retryAfterSeconds").toInt(60);
        setMessage("验证码已发送，请检查 QQ 邮箱和垃圾邮件文件夹");
    });
}
void HostController::activate(const QString &email, const QString &code) {
    const auto normalized = email.trimmed().toLower();
    if (m_challenge.isEmpty() || normalized != m_challengeEmail) { setMessage("请先为这个 QQ 邮箱获取验证码"); return; }
    if (!QRegularExpression("^\\d{6}$").match(code.trimmed()).hasMatch()) { setMessage("请输入 6 位验证码"); return; }
    api("/v1/registration/activate", {{"email", normalized}, {"hostId", m_hostId}, {"challengeId", m_challenge}, {"code", code.trimmed()}}, [this](const QJsonValue &value) { saveActivation(value, "QQ 邮箱验证成功，这台电脑已激活"); });
}
void HostController::activateWithoutEmail() {
    if (!m_bridgeReady || busy() || activated() || m_verificationRequired || !m_registrationAvailable) return;
    api("/v1/registration/activate", {{"hostId", m_hostId}}, [this](const QJsonValue &value) { saveActivation(value, "这台电脑已激活，可以开始连接"); });
}
void HostController::saveActivation(const QJsonValue &value, const QString &successMessage) {
    auto obj = value.toObject();
    if (obj.value("hostId").toString() != m_hostId || !obj.value("credential").toString().startsWith("orbis_host_")) { setMessage("服务器返回了无效的激活凭据"); return; }
    obj.insert("relayUrl", relayUrl()); QString error;
    if (!CredentialStore::save(m_dataDir + "/activation.dat", obj, &error)) { setMessage(error); return; }
    m_email = obj.value("email").toString(); m_credential = obj.value("credential").toString(); m_challenge.clear();
    setMessage(successMessage);
    startHost();
}
void HostController::refreshRegistrationPolicy() {
    if (!validRelay(relayUrl())) return;
    QUrl url(relayUrl() + "/v1/registration/status"); url.setScheme(url.scheme() == "wss" ? "https" : "http");
    QNetworkRequest request(url); request.setTransferTimeout(15000);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
    const auto requestedRelay = relayUrl();
    auto *reply = m_network.get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply, requestedRelay] {
        const auto status = QJsonDocument::fromJson(reply->readAll()).object();
        if (requestedRelay == relayUrl()) {
            if (reply->error() == QNetworkReply::NoError && status.value("enabled").isBool()) {
                m_verificationRequired = status.value("qqEmailVerificationRequired").toBool(true);
                m_registrationAvailable = status.value("enabled").toBool();
            } else {
                m_verificationRequired = true; m_registrationAvailable = false;
            }
            emit changed();
        }
        reply->deleteLater();
    });
}
QJsonObject HostController::agentSettings() const { return {{"piEntry", piEntry()}, {"codexEntry", codexEntry()}, {"dshEntry", dshEntry()}}; }
void HostController::startHost() {
    if (!activated() || !m_bridgeReady || m_desiredRunning) return;
    m_desiredRunning = true; m_state = "connecting"; m_settings.setValue("runHost", true);
    auto params = agentSettings(); params.insert("relayUrl", relayUrl()); params.insert("credential", m_credential); params.insert("codexEnabled", codexEnabled());
    params.insert("dshEnabled", dshEnabled());
    command("start", params);
}
void HostController::stopHost() { m_desiredRunning = false; m_settings.setValue("runHost", false); m_qr.clear(); command("stop"); }
void HostController::pair() { command("pair", {}, [this](const QJsonValue &value) { m_qr = value.toObject().value("qr").toString(); m_pairExpires = qint64(value.toObject().value("expiresAt").toDouble()); emit changed(); }); }
void HostController::cancelPair() { m_qr.clear(); m_pairExpires = 0; command("cancelPair"); }
void HostController::revoke(const QString &deviceId) { command("revoke", {{"deviceId", deviceId}}, [this](const QJsonValue &) { setMessage("设备已撤销，连接立即失效"); }); }
void HostController::renameDevice(const QString &deviceId, const QString &label) { command("renameDevice", {{"deviceId", deviceId}, {"label", label}}); }
void HostController::detectAgents() { command("detect", agentSettings(), [this](const QJsonValue &value) { m_agents = value.toArray().toVariantList(); emit changed(); }); }
void HostController::installAgent(const QString &kind) { command("install", {{"kind", kind}}, [this](const QJsonValue &) { detectAgents(); }); }
void HostController::openAgent(const QString &kind) { command("openAgent", {{"kind", kind}}); }
void HostController::openAgentTui(const QString &kind) {
    if (!m_bridgeReady || busy()) return;
    command("openAgent", {{"kind", kind}, {"mode", "tui"}}, [this, kind](const QJsonValue &) {
        setMessage(QString("已打开 %1 终端界面。请在新窗口中继续操作。").arg(kind == "pi" ? "Pi" : kind == "dsh" ? "DeepSeek Harness" : "Codex"));
    });
}
void HostController::saveSettings(const QString &relay, bool startup, bool codex, const QString &piPath, const QString &codexPath, const QString &name, bool dsh, const QString &dshPath) {
    QString normalized = relay.trimmed(); while (normalized.endsWith('/')) normalized.chop(1);
    if (!validRelay(normalized)) { setMessage("中继地址必须使用 wss://；本机测试可使用 ws://127.0.0.1"); return; }
    if (m_desiredRunning) { setMessage("请先在概览中暂停连接，再修改设置"); return; }
    if (normalized != relayUrl()) { m_credential.clear(); m_email.clear(); m_challenge.clear(); m_verificationRequired = true; m_registrationAvailable = false; QFile::remove(m_dataDir + "/activation.dat"); }
    m_settings.setValue("relayUrl", normalized); m_settings.setValue("autoStart", startup); m_settings.setValue("codexEnabled", codex);
    m_settings.setValue("piEntry", piPath.trimmed()); m_settings.setValue("codexEntry", codexPath.trimmed()); m_settings.sync();
    m_settings.setValue("dshEnabled", dsh); m_settings.setValue("dshEntry", dshPath.trimmed()); m_settings.sync();
#ifdef Q_OS_WIN
    QSettings startupRegistry("HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", QSettings::NativeFormat);
    if (startup) startupRegistry.setValue("OrbisHost", '"' + QDir::toNativeSeparators(QCoreApplication::applicationFilePath()) + "\" --tray");
    else startupRegistry.remove("OrbisHost");
#endif
    if (!name.trimmed().isEmpty() && name.trimmed() != m_hostName) command("rename", {{"name", name.trimmed()}}, [this, name](const QJsonValue &) { m_hostName = name.trimmed(); emit changed(); });
    setMessage("设置已保存"); detectAgents(); refreshRegistrationPolicy();
}
void HostController::diagnose() {
    detectAgents();
    QUrl url(relayUrl() + "/healthz"); url.setScheme(url.scheme() == "wss" ? "https" : "http");
    QNetworkRequest request(url); request.setTransferTimeout(15000);
    auto *reply = m_network.get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply] {
        const bool ok = reply->error() == QNetworkReply::NoError && QJsonDocument::fromJson(reply->readAll()).object().value("status").toString() == "ok";
        setMessage(ok ? "中继服务可达；Agent 检测结果已更新" : "中继连接失败：" + reply->errorString());
        reply->deleteLater();
    });
}
QString HostController::diagnostics() const {
    QJsonArray agents;
    for (const auto &value : m_agents) { auto agent = QJsonObject::fromVariantMap(value.toMap()); agent.remove("path"); agent.remove("error"); agents.append(agent); }
    QJsonObject result{{"version", version()}, {"state", m_state}, {"activated", activated()}, {"devices", m_devices.size()}, {"agents", agents}, {"logs", QJsonArray::fromStringList(m_logs)}};
    return QString::fromUtf8(QJsonDocument(result).toJson());
}
void HostController::copyDiagnostics() { QApplication::clipboard()->setText(diagnostics()); setMessage("脱敏诊断信息已复制"); }
void HostController::exportDiagnostics() {
    const auto path = QFileDialog::getSaveFileName(nullptr, "导出诊断信息", QStandardPaths::writableLocation(QStandardPaths::DesktopLocation) + "/orbis-diagnostics.json", "JSON (*.json)");
    if (path.isEmpty()) return;
    QSaveFile file(path);
    if (file.open(QIODevice::WriteOnly) && file.write(diagnostics().toUtf8()) >= 0 && file.commit()) setMessage("诊断信息已导出"); else setMessage("无法写入诊断文件");
}
void HostController::checkUpdates() {
    QNetworkRequest request(QUrl("https://api.github.com/repos/WGooold/Orbis/releases/latest")); request.setRawHeader("User-Agent", "OrbisHost/" ORBIS_VERSION); request.setTransferTimeout(15000);
    auto *reply = m_network.get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply] {
        auto result = QJsonDocument::fromJson(reply->readAll()).object();
        if (reply->error() != QNetworkReply::NoError) setMessage("暂时无法获取公开版本信息，请在下载页查看发布状态");
        else {
            auto tag = result.value("tag_name").toString(); if (tag.startsWith('v')) tag.remove(0, 1);
            if (QVersionNumber::fromString(tag) > QVersionNumber::fromString(version())) setMessage("发现新版本 " + tag + "，请打开下载页查看更新说明并安装");
            else setMessage("当前已是最新公开版本");
        }
        reply->deleteLater();
    });
}
void HostController::openDownloads() { QDesktopServices::openUrl(QUrl("https://github.com/WGooold/Orbis/releases")); }
void HostController::openDataDirectory() { QDesktopServices::openUrl(QUrl::fromLocalFile(m_dataDir)); }
void HostController::clearMessage() { m_message.clear(); emit changed(); }
void HostController::setMessage(const QString &message) { m_message = message; appendLog(message); emit changed(); }
void HostController::appendLog(QString message) {
    if (message.isEmpty()) return;
    message.replace(QRegularExpression("orbis_host_[A-Za-z0-9_-]+"), "[credential]");
    message.replace(QRegularExpression("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"), "[email]");
    message.replace(QDir::homePath(), "[user]", Qt::CaseInsensitive);
    message.replace(QDir::toNativeSeparators(QDir::homePath()), "[user]", Qt::CaseInsensitive);
    if (!m_credential.isEmpty()) message.replace(m_credential, "[credential]");
    m_logs.append(QDateTime::currentDateTime().toString("HH:mm:ss") + "  " + message.left(1500));
    while (m_logs.size() > 300) m_logs.removeFirst();
    emit changed();
}
void HostController::shutdown() {
    if (m_shutdown) return;
    m_shutdown = true; m_tick.stop();
    if (m_bridge.state() == QProcess::Running) {
        command("shutdown"); m_bridge.closeWriteChannel();
        if (!m_bridge.waitForFinished(45000)) { m_bridge.terminate(); if (!m_bridge.waitForFinished(2000)) { m_bridge.kill(); m_bridge.waitForFinished(1000); } }
    }
}
