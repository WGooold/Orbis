#include "HostController.h"
#include "CredentialStore.h"
#include "StartupSettings.h"
#include <QCoreApplication>
#include <QApplication>
#include <QClipboard>
#include <QDateTime>
#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QFutureWatcher>
#include <QJsonArray>
#include <QJsonDocument>
#include <QNetworkReply>
#include <QRegularExpression>
#include <QSaveFile>
#include <QStandardPaths>
#include <QUrlQuery>
#include <QVersionNumber>
#include <QUuid>
#include <QCryptographicHash>
#include <QtConcurrentRun>

static QString friendlyError(const QString &code) {
    static const QHash<QString, QString> messages{
        {"qq_email_required", "请填写有效的 @qq.com 邮箱"},
        {"registration_unavailable", "注册服务暂未启用：服务器尚未配置邮件发送服务。请稍后再试。"},
        {"email_verification_required", "服务器现在要求验证 QQ 邮箱，请获取验证码后重试"},
        {"verification_delivery_failed", "验证码发送失败，请稍后重试或联系服务维护者"},
        {"invalid_verification_code", "验证码错误、已过期或已使用，请重新获取"},
        {"host_already_registered", "这台电脑已有激活记录，请恢复激活"},
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

HostController::HostController(QString runtimeRoot, QString dataDir, QString hostStateDir, QString credentialDir, bool automaticIntegrations, QObject *parent)
    : QObject(parent), m_runtimeRoot(std::move(runtimeRoot)), m_dataDir(std::move(dataDir)), m_hostStateDir(std::move(hostStateDir)), m_credentialDir(std::move(credentialDir)),
      m_settings(m_dataDir + "/settings.ini", QSettings::IniFormat) {
    m_activationPool.setMaxThreadCount(1);
    m_automaticIntegrations = automaticIntegrations;
    m_installLauncher = [](const QString &path) {
#ifdef Q_OS_MACOS
        return QProcess::startDetached("open", {path});
#else
        return QProcess::startDetached(path, {"/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS", "/ORBISHOSTCLOSED=1", "/ORBISRELAUNCH=1"});
#endif
    };
    m_exitDeadline.setSingleShot(true);
    connect(&m_exitDeadline, &QTimer::timeout, this, [this] {
        m_exitError = "后台收尾超时，请重试；尚未安装更新";
        m_exitWorker.kill();
    });
    connect(&m_exitWorker, &QProcess::started, this, [this] {
        const QJsonObject request{{"bridgePid", double(m_bridge.processId())}, {"runtimeRoot", m_runtimeRoot},
            {"stateDir", m_hostStateDir}, {"integrations", m_automaticIntegrations}, {"externalDsh", !dshWebUrl().trimmed().isEmpty()}};
        m_exitWorker.write(QJsonDocument(request).toJson(QJsonDocument::Compact) + '\n');
    });
    connect(&m_exitWorker, &QProcess::readyReadStandardOutput, this, [this] {
        m_exitOutput += m_exitWorker.readAllStandardOutput();
        int newline;
        while ((newline = m_exitOutput.indexOf('\n')) >= 0) {
            const auto result = QJsonDocument::fromJson(m_exitOutput.left(newline)).object();
            m_exitOutput.remove(0, newline + 1);
            if (result.value("event") == "ready") {
                if (m_bridge.state() == QProcess::Running) { command("shutdown"); m_bridge.closeWriteChannel(); }
                m_exitWorker.write("proceed\n"); m_exitWorker.closeWriteChannel();
            } else if (result.value("event") == "done") m_exitWorkerDone = true;
            else if (result.value("event") == "error") m_exitError = result.value("message").toString();
        }
    });
    connect(&m_exitWorker, &QProcess::errorOccurred, this, [this](QProcess::ProcessError error) {
        if (error == QProcess::FailedToStart) failExit("无法启动后台收尾程序，请修复 Host 安装后重试");
    });
    connect(&m_exitWorker, &QProcess::finished, this, [this](int code, QProcess::ExitStatus status) {
        m_exitDeadline.stop();
        if (code == 0 && status == QProcess::NormalExit && m_exitWorkerDone) finishExit();
        else failExit(m_exitError.isEmpty() ? "后台收尾失败，请重试；尚未安装更新" : m_exitError);
    });
    QDir().mkpath(m_dataDir);
    if (m_credentialDir.isEmpty()) m_credentialDir = m_dataDir;
    QDir().mkpath(m_credentialDir);
    // HOST-ACTIVITY-05: the macOS Keychain may wait for the user to authorize this read (a locked
    // Keychain or a re-signed app). It used to run here on the UI thread, before the window existed.
    loadStoredActivation();
    connect(&m_bridge, &QProcess::started, this, [this, automaticIntegrations] {
        command("initialize", {{"claudeIntegrationEnabled", automaticIntegrations && claudeIntegrationEnabled()}}, [this](const QJsonValue &result) {
            const auto obj = result.toObject();
            const auto actualId = obj.value("hostId").toString();
            m_hostName = obj.value("hostName").toString(); m_appDownloadQr = obj.value("appDownloadQr").toString();
            m_hostPub = obj.value("hostPub").toString();
            m_devices = obj.value("devices").toArray().toVariantList();
            refreshDeviceUpdateIndicators();
            m_bridgeReady = true;
            appendLog("Host 核心已就绪 · " + obj.value("nodeVersion").toString());
            detectAgents(true);
            checkUpdatesInternal(false);
            // The stored activation names the Relay and Host ID to restore; it may still be waiting on the key store.
            afterStoredActivation([this, actualId] {
                if (!m_hostId.isEmpty() && m_hostId != actualId) { m_credential.clear(); setMessage("电脑身份与激活凭据不匹配，请重新验证邮箱"); }
                m_hostId = actualId;
                refreshRegistrationPolicy();
                restoreActivation(relayUrl(), [this] {
                    if (!m_deferStartup && activated() && m_settings.value("runHost", true).toBool()) startHost();
                });
                emit changed();
            });
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
        m_bridgeReady = false; m_desiredRunning = false; m_pending.clear(); m_methods.clear(); m_requestParams.clear(); ++m_draftGeneration; m_busy = 0; m_qr.clear();
        // 在途命令随内核一起没了：进度说明也必须跟着消失，否则会永久停在“正在做什么”。
        m_activity.clear(); m_activityOrder.clear(); m_claudeDetecting = false;
        // 插件登记也属于这个内核进程；它退出后不再有“正在准备”。
        m_preparations.clear();
        // The relaunched core starts paused; a change that was waiting to resume the old one no longer applies.
        m_settled.clear(); m_resumePending = false; m_relaySelectionPending = false; clearRunningFacts();
        // 接入分档说的是「现在接上了吗」：Host 核心没了就没有现在，留着会在诊断页上
        // 显示一个已经不成立的「已接入」。
        m_codexDesktop.clear();
        m_dshDesktopOpen = "idle";
        m_claudeInstalled = false;
        m_claudeCompatible = false;
        m_claudeVersion.clear(); m_claudeMinimumVersion.clear(); m_claudeVersionError.clear();
        if (agentInstalling()) m_agentInstallStage = "error";
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
    if (m_shutdown || m_exiting || m_bridge.state() != QProcess::NotRunning) return;
    QString node = m_runtimeRoot + "/node/node";
#ifdef Q_OS_WIN
    node = m_runtimeRoot + "/node/node.exe";
    if (!QFile::exists(node)) node = QStandardPaths::findExecutable("node.exe");
#else
    if (!QFile::exists(node)) node = QStandardPaths::findExecutable("node");
#endif
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
static bool isProviderBackgroundRequest(const QString &method) {
    return method == "provider.check" || method == "provider.models";
}
/**
 * HOST-LANE-01: requests the bridge runs beside connection commands (desktop-command-lanes.ts). They do
 * not grey out unrelated controls; their own controls read activityKinds instead.
 */
static bool isBackgroundRequest(const QString &method) {
    return isProviderBackgroundRequest(method) || method == "detect";
}
/**
 * 每个桥命令在界面上叫什么。返回空 = 不值得单独提示（Agent 安装/更新有自己一套进度 UI）。
 * 目的只有一个：按钮因为 busy 变灰时，用户能读到“正在做什么”。
 */
static QPair<QString, QString> activityFor(const QString &method, const QJsonObject &params) {
    if (method == "initialize") return { "core", "正在启动 Host 核心" };
    if (method == "start") return { "connect", "正在连接中继" };
    if (method == "stop") return { "connect", "正在暂停连接" };
    if (method == "detect") return { "agents", params.value("checkLatest").toBool() ? "正在检查 Agent 更新" : "正在检测 Agent" };
    if (method == "pair") return { "pair", "正在生成二维码" };
    // Registration runs over HTTP (api()); activation I/O has its own state, not a bridge command.
    if (method == "replaceIdentity") return { "activation", "正在重新登记这台电脑" };
    if (method == "restartDshServer") return { "dsh", "正在重启 DSH Server" };
    // Not "agents": rows read that kind as "detection in progress", which a version switch is not.
    if (method == "activateInstallation") return { "agentVersion", "正在切换 Agent 版本" };
    if (method == "claudeIntegration") return { "claude", "正在更新 Claude Code 插件" };
    if (method == "revoke" || method == "renameDevice") return { "device", "正在保存设备变更" };
    if (method == "rename") return { "host", "正在保存电脑名称" };
    if (method.startsWith("provider.")) {
        if (method == "provider.save") return { "provider", "正在保存供应商" };
        if (method == "provider.saveCodexPreferences") return { "provider", "正在保存通用配置" };
        if (method == "provider.switch") return { "provider", "正在切换供应商" };
        if (method == "provider.remove") return { "provider", "正在删除供应商" };
        if (method == "provider.open") return { "provider", "正在打开供应商" };
        if (method == "provider.copy") return { "provider", "正在复制供应商" };
        if (method == "provider.piDefault") return { "provider", "正在保存默认供应商" };
        return { "provider", "正在读取供应商配置" };
    }
    return {};
}
QVariantMap HostController::activity() const {
    if (m_activityOrder.isEmpty()) return {};
    // Commands no longer finish in submission order (HOST-LANE-01). The connection card names the
    // connection first; a detection that started earlier keeps running beside it.
    auto id = m_activityOrder.first();
    for (const auto candidate : m_activityOrder) {
        const auto kind = m_activity.value(candidate).first;
        if (kind == "core" || kind == "connect" || kind == "pair") { id = candidate; break; }
    }
    const auto entry = m_activity.value(id);
    if (entry.first.isEmpty() && entry.second.isEmpty()) return {};
    return { { "kind", entry.first }, { "text", entry.second } };
}
QStringList HostController::activityKinds() const {
    QStringList kinds;
    for (const auto id : m_activityOrder) {
        const auto kind = m_activity.value(id).first;
        if (!kind.isEmpty() && !kinds.contains(kind)) kinds.append(kind);
    }
    return kinds;
}
void HostController::updateActivity(const QString &method, const QString &text) {
    for (auto it = m_methods.cbegin(); it != m_methods.cend(); ++it) {
        if (it.value() == method && m_activity.contains(it.key())) m_activity[it.key()].second = text;
    }
}
/**
 * 与 startHost() 的守卫逐条对应，只用于告诉用户“现在为什么点了没用”。
 * m_desiredRunning 表示已经在跑，不算阻塞。
 */
QString HostController::connectionBlockReason() const {
    if (m_exiting) return "正在退出";
    // A core that exited (crashed repeatedly, or an incomplete install) is not "starting"; its message says why.
    if (!m_bridgeReady) return m_state == "error" ? "Host 核心未运行" : "Host 核心正在启动";
    if (m_activationIO > 0) return m_systemAuthorizationWait ? "正在等待系统授权" : "正在读取激活信息";
    if (m_relaySelectionPending) return "正在切换中继服务器";
    if (!activated()) return "请先激活这台电脑";
    if (agentInstalling()) return "正在安装 Agent，完成后会自动连接";
    return {};
}
QStringList HostController::checkingProviderIds() const {
    QStringList ids;
    for (auto it = m_methods.cbegin(); it != m_methods.cend(); ++it) {
        const auto params = m_requestParams.value(it.key());
        if (it.value() == "provider.check" && params.value("kind").toString() == m_providerKind) ids.append(params.value("id").toString());
    }
    return ids;
}
int HostController::command(const QString &method, const QJsonObject &params, Callback done) {
    if (m_exiting && method != "shutdown") return -1;
    if (m_bridge.state() != QProcess::Running) { setMessage("Host 核心尚未就绪"); return -1; }
    int id = m_nextId++;
    m_pending.insert(id, std::move(done)); m_methods.insert(id, method); m_requestParams.insert(id, params);
    if (!isBackgroundRequest(method)) ++m_busy;
    const auto activity = activityFor(method, params);
    if (!activity.first.isEmpty() || !activity.second.isEmpty()) { m_activity.insert(id, activity); m_activityOrder.append(id); }
    m_bridge.write(QJsonDocument(QJsonObject{{"id", id}, {"method", method}, {"params", params}}).toJson(QJsonDocument::Compact) + '\n');
    emit changed();
    return id;
}
void HostController::afterQueuedCommands(std::function<void()> next) {
    // HOST-LANE-01: the bridge answers connection and background commands out of submission order, so
    // the last request settling no longer means the earlier ones did. Wait for every request sent so far.
    const int last = m_nextId - 1;
    if (!hasPendingUpTo(last)) { next(); return; }
    m_settled.append({ last, std::move(next) });
}
bool HostController::hasPendingUpTo(int last) const {
    for (auto it = m_pending.cbegin(); it != m_pending.cend(); ++it) if (it.key() <= last) return true;
    return false;
}
void HostController::runSettled() {
    // A continuation may queue more commands and more continuations; take only those that are due now.
    for (int index = 0; index < m_settled.size();) {
        if (hasPendingUpTo(m_settled.at(index).first)) { ++index; continue; }
        auto next = m_settled.takeAt(index).second;
        next();
        index = 0;
    }
}
bool HostController::pauseForChange() {
    if (!m_desiredRunning) return false;
    m_desiredRunning = false; m_resumePending = true; m_qr.clear(); m_pairExpires = 0;
    command("stop");
    return true;
}
void HostController::resumeAfterChange() {
    if (!m_resumePending) return;
    m_resumePending = false;
    // A previously used Relay resumes with its own credential; a new one needs activation.
    startHost();
    emit changed();
}
void HostController::clearRunningFacts() {
    // A paused Host has released its DeepSeek Desktop connection; its lifecycle reports again on the next start.
    m_backends.clear(); m_runtimeCount = 0; m_dshDesktop.clear();
    // 终端 Codex 与 DeepSeek 后端的准备属于这一次运行：停了就不再有“正在准备”。
    // Claude 插件登记属于 Host 核心本身，暂停连接不影响它。
    m_preparations.remove("codex"); m_preparations.remove("dsh");
    QVariantList devices;
    for (const auto &entry : m_devices) { auto device = entry.toMap(); device.insert("path", "offline"); devices.append(device); }
    m_devices = devices;
}
void HostController::receiveLine(const QJsonObject &line) {
    if (line.contains("id")) {
        int id = line.value("id").toInt();
        if (!m_pending.contains(id)) return;
        auto callback = m_pending.take(id); auto method = m_methods.take(id); m_requestParams.remove(id);
        if (!isBackgroundRequest(method)) m_busy = qMax(0, m_busy - 1);
        if (m_activity.remove(id)) m_activityOrder.removeAll(id);
        if (line.contains("error")) {
            if (method == "start") { m_desiredRunning = false; m_state = "error"; }
            if (method == "updateAgent" || method == "installAll") { if (m_agentInstallStage != "cancelled") m_agentInstallStage = "error"; detectAgents(); }
            setMessage(line.value("error").toString());
            if (method == "start" && line.value("error").toString().startsWith("Relay 认证失败：unauthorized ")) invalidateActivation();
        }
        else if (callback) callback(line.value("result"));
        runSettled();
    } else {
        const auto event = line.value("event").toString();
        if (event == "state") {
            m_state = line.value("state").toString();
            if (m_state == "error") m_desiredRunning = false;
            if (m_state == "connected") bindHostKey();
            if (m_state == "stopped" || m_state == "error") clearRunningFacts();
            if (line.contains("message")) setMessage(line.value("message").toString());
            // Older bundled bridges report only the original authentication message.
            if (m_state == "error" && (line.value("activationRequired").toBool() ||
                line.value("message").toString().startsWith("Relay 认证失败：unauthorized "))) invalidateActivation();
        }
        else if (event == "log") { appendLog(line.value("message").toString()); return; }
        else if (event == "providersChanged" && line.value("kind").toString() == m_providerKind) loadProviders(m_providerKind);
        else if (event == "agentInstall") {
            m_agentInstallKind = line.value("kind").toString();
            m_agentInstallStage = line.value("stage").toString();
            if (line.contains("version")) m_agentInstallVersion = line.value("version").toString();
            // 下载进度（同一次安装里由多个事件陆续上报）：终态时收起来。
            const auto download = line.value("download").toObject();
            if (m_agentInstallStage == "downloading" && !download.isEmpty()) {
                const auto label = m_agentInstallKind == "pi" ? "Pi" : m_agentInstallKind == "dsh" ? "DeepSeek Harness" : "Codex";
                setDownload(label, qint64(download.value("receivedBytes").toDouble()), qint64(download.value("totalBytes").toDouble()));
            } else if (m_agentInstallStage != "downloading") {
                clearDownload();
            }
        }
        else if (event == "agentInstalled") {
            const auto kind = line.value("kind").toString();
            if (QStringList{"pi", "codex", "dsh"}.contains(kind)) {
                m_settings.setValue(kind + "Entry", line.value("entry").toString()); m_settings.sync();
            }
        }
        else if (event == "status") {
            m_devices = line.value("devices").toArray().toVariantList(); refreshDeviceUpdateIndicators(); m_runtimeCount = line.value("runtimeCount").toInt();
            // The running service's own model; offline status events (rename/revoke while paused) carry none.
            QVariantList backends;
            for (const auto &domain : line.value("model").toObject().value("domains").toArray()) {
                if (domain.toObject().value("domain").toString() == "backends")
                    backends = domain.toObject().value("value").toObject().value("backends").toArray().toVariantList();
            }
            m_backends = backends;
        }
        // Codex 桌面版 app-server 的接入分档（ADR-0022）：分档真的变了才会到这条事件。
        else if (event == "codexDesktop") { m_codexDesktop = line.value("status").toObject().toVariantMap(); }
        // HOST-PREP-01/04/05：Agent 后端与插件登记在后台准备（Codex 可能要下配套包，Claude 要跑插件命令，
        // DeepSeek 要起本地服务）。它们只影响对应 Agent 何时可用，中继连接与手机早已就绪，
        // 所以这里既不进 busy 也不碰 m_state。结束（ready / idle）即移除，失败保留到下次准备。
        else if (event == "preparation") {
            const auto kind = line.value("kind").toString();
            const auto state = line.value("state").toString();
            if (kind.isEmpty()) return;
            if (state == "ready" || state == "idle") m_preparations.remove(kind);
            else {
                QVariantMap preparation{{ "state", state }};
                if (line.contains("message")) preparation.insert("message", line.value("message").toString());
                if (line.contains("download")) {
                    const auto download = line.value("download").toObject();
                    preparation.insert("receivedBytes", download.value("receivedBytes").toDouble());
                    preparation.insert("totalBytes", download.value("totalBytes").toDouble());
                }
                m_preparations.insert(kind, preparation);
            }
            static const QHash<QString, QString> names{{"codex", "Codex 终端接入"}, {"claude", "Claude Code 插件登记"}, {"dsh", "DeepSeek Harness 后端"}};
            const auto name = names.value(kind, kind);
            if (state == "ready") appendLog(name + "已就绪");
            else if (state == "error") appendLog(name + "失败：" + line.value("message").toString());
            emit changed();
            return;
        }
        // HOST-ACTIVITY-04: a DSH Server restart names the stage it is waiting on.
        else if (event == "dshServer") {
            static const QHash<QString, QString> stages{
                {"waiting", "正在等待另一个 DSH Server 启动完成"}, {"stopping", "正在停止 DSH Server"},
                {"starting", "正在启动 DSH Server"}, {"connecting", "正在连接 DSH Server"}, {"applying", "正在应用 DeepSeek 供应商配置"}};
            const auto text = stages.value(line.value("stage").toString());
            if (!text.isEmpty()) updateActivity("restartDshServer", text);
        }
        else if (event == "dshDesktop") { m_dshDesktop = line.value("status").toObject().toVariantMap(); }
        // The open may wait for the user to quit a Desktop Orbis did not open, so it reports beside the command queue.
        else if (event == "dshDesktopOpen") {
            m_dshDesktopOpen = line.value("state").toString("idle");
            if (line.contains("error")) setMessage(line.value("error").toString());
        }
        else if (event == "claudeStatus") {
            // 检测进行中时“未安装”只代表还没测完，界面不能把它当成结论。
            m_claudeDetecting = line.value("detecting").toBool(false);
            m_claudeInstalled = line.value("installed").toBool();
            m_claudeCompatible = line.value("compatible").toBool(m_claudeInstalled);
            m_claudeVersion = line.value("version").toString();
            m_claudeMinimumVersion = line.value("minimumVersion").toString();
            m_claudeVersionError = line.value("error").toString();
        }
        else if (event == "paired") { m_qr.clear(); m_pairExpires = 0; setMessage("手机配对成功，现在可以在手机上使用 Orbis"); emit paired(); emit notification("Orbis", "新手机已配对"); }
    }
    emit changed();
}
void HostController::api(const QString &endpoint, const QJsonObject &body, Callback done, std::function<void()> failed) {
    if (!validRelay(relayUrl())) { setMessage("请在设置中填写有效的 wss:// 中继地址"); return; }
    QUrl url(relayUrl() + endpoint); url.setScheme(url.scheme() == "wss" ? "https" : "http");
    QNetworkRequest request(url); request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    request.setTransferTimeout(30000);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
    auto *reply = m_network.post(request, QJsonDocument(body).toJson(QJsonDocument::Compact));
    const auto generation = m_activationGeneration;
    const auto requestedRelay = relayUrl(), requestedHost = m_hostId;
    const bool mailboxVerified = body.contains("challengeId");
    ++m_busy; emit changed();
    connect(reply, &QNetworkReply::finished, this, [this, reply, generation, requestedRelay, requestedHost, mailboxVerified, done = std::move(done), failed = std::move(failed)] {
        m_busy = qMax(0, m_busy - 1);
        if (generation != m_activationGeneration || requestedRelay != relayUrl() || requestedHost != m_hostId) {
            reply->deleteLater(); emit changed(); return;
        }
        auto result = QJsonDocument::fromJson(reply->readAll());
        int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        if (status >= 200 && status < 300 && result.isObject()) done(result.object());
        else if (failed) failed();
        else if (result.object().contains("error")) handleRegistrationError(result.object(), mailboxVerified);
        else setMessage("无法连接注册服务：" + reply->errorString());
        reply->deleteLater(); emit changed();
    });
}
void HostController::handleRegistrationError(const QJsonObject &result, bool mailboxVerified) {
    const auto code = result.value("error").toString();
    if (code == "host_already_registered") {
        m_registrationRefused = true;
        const auto recovery = result.value("recovery").toString();
        const auto reset = "联系管理员重置激活，电脑 ID：" + m_hostId;
        // HOST-ACT-14: the Relay consumes a code before refusing it; another attempt needs a new one.
        if (mailboxVerified) { m_challenge.clear(); m_challengeEmail.clear(); }
        m_recoverWithEmail = recovery != "administrator";
        if (!m_recoverWithEmail) setMessage("请" + reset);
        else if (mailboxVerified) {
            // A verified mailbox that still conflicts is not the registered one. A released Relay sends
            // no hint, so the Host may also have been activated without a mailbox: asking for the
            // "original mailbox" again would loop forever. Keep the mailbox entry for the right address.
            setMessage(recovery == "email" ? "这个邮箱不是这台电脑的激活邮箱。请改用原 QQ 邮箱，或" + reset
                : "这个邮箱无法恢复这台电脑的激活。如果当初没有用邮箱激活，或忘记了原邮箱，请" + reset);
        } else {
            m_verificationRequired = true;
            setMessage(recovery == "email" ? QString("请验证原 QQ 邮箱以恢复激活")
                : "请验证原 QQ 邮箱以恢复激活。如果当初没有用邮箱激活，请" + reset);
            refreshRegistrationPolicy();
        }
        maybeRecoverWithHostKey();
    } else {
        if (code == "email_verification_required") m_verificationRequired = true;
        setMessage(friendlyError(code));
    }
    emit changed();
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
    if (!m_bridgeReady || busy()) return;
    const auto normalized = email.trimmed().toLower();
    if (m_challenge.isEmpty() || normalized != m_challengeEmail) { setMessage("请先为这个 QQ 邮箱获取验证码"); return; }
    if (!QRegularExpression("^\\d{6}$").match(code.trimmed()).hasMatch()) { setMessage("请输入 6 位验证码"); return; }
    api("/v1/registration/activate", withHostKey({{"email", normalized}, {"hostId", m_hostId}, {"challengeId", m_challenge}, {"code", code.trimmed()}}), [this](const QJsonValue &value) { saveActivation(value, "QQ 邮箱验证成功，这台电脑已激活"); });
}
void HostController::activateWithoutEmail() {
    if (!m_bridgeReady || busy() || activated() || m_verificationRequired || !m_registrationAvailable) return;
    api("/v1/registration/activate", withHostKey({{"hostId", m_hostId}}), [this](const QJsonValue &value) { saveActivation(value, "这台电脑已激活，可以开始连接"); });
}
QJsonObject HostController::withHostKey(QJsonObject body) const {
    // HOST-ACT-15: lets a Relay record this computer's key; released Relays ignore the field.
    if (!m_hostPub.isEmpty()) body.insert("hostPub", m_hostPub);
    return body;
}
void HostController::maybeRecoverWithHostKey() {
    // HOST-ACT-15: a computer that still holds its Host key replaces a lost credential by itself. Bounded per
    // run, so two copies of one identity cannot keep replacing each other's credential.
    if (!m_hostKeyRecovery || !m_keyRecoveryArmed || m_keyRecoveries >= 3 || activated() || !m_bridgeReady || m_hostPub.isEmpty() ||
        m_hostId.isEmpty() || m_activationIO > 0 || m_relaySelectionPending || m_exiting || m_updating || !validRelay(relayUrl())) return;
    m_keyRecoveryArmed = false; ++m_keyRecoveries;
    const auto hostId = m_hostId; const auto generation = m_activationGeneration;
    const auto unavailable = [this] { appendLog("本机密钥无法恢复激活，可使用邮箱或作为新电脑激活"); };
    api("/v1/registration/recovery-challenge", {{"hostId", hostId}}, [this, hostId, generation, unavailable](const QJsonValue &value) {
        const auto challenge = value.toObject();
        const auto challengeId = challenge.value("challengeId").toString();
        command("hostRecoveryProof", {{"hostId", hostId}, {"challengeId", challengeId}, {"relayPub", challenge.value("relayPub").toString()}},
            [this, hostId, generation, challengeId, unavailable](const QJsonValue &proof) {
                if (generation != m_activationGeneration || hostId != m_hostId || activated()) return;
                api("/v1/registration/recover", {{"hostId", hostId}, {"challengeId", challengeId}, {"proof", proof.toObject().value("proof").toString()}},
                    [this](const QJsonValue &value) {
                        // A paused Host stays paused; only the credential is restored.
                        saveActivation(value, "已用这台电脑的密钥恢复激活", !m_deferStartup && m_settings.value("runHost", true).toBool());
                    }, unavailable);
            });
    }, unavailable);
}
void HostController::bindHostKey() {
    // HOST-ACT-15: records this computer's key with a Relay that supports recovery, once per credential.
    // Failures and released Relays leave the activation unchanged.
    if (!m_hostKeyRecovery || m_hostPub.isEmpty() || !activated() || !validRelay(relayUrl())) return;
    const auto binding = relayUrl() + '\n' + m_hostId + '\n' + m_credential;
    if (binding == m_keyBoundFor) return;
    m_keyBoundFor = binding;
    QUrl url(relayUrl() + "/v1/registration/host-key"); url.setScheme(url.scheme() == "wss" ? "https" : "http");
    QNetworkRequest request(url); request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    request.setRawHeader("Authorization", "Bearer " + m_credential.toUtf8());
    request.setTransferTimeout(15000);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
    auto *reply = m_network.post(request, QJsonDocument(QJsonObject{{"hostPub", m_hostPub}}).toJson(QJsonDocument::Compact));
    connect(reply, &QNetworkReply::finished, this, [this, reply, binding] {
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        // Unreachable or failing Relays are retried on the next connection; a refusal is final for this credential.
        if ((status == 0 || status >= 500) && binding == m_keyBoundFor) m_keyBoundFor.clear();
        if (status == 409) appendLog("Relay 记录的电脑密钥与本机不同，本机密钥无法用于恢复激活");
        reply->deleteLater();
    });
}
void HostController::replaceIdentity() {
    // HOST-ACT-16: the always-available path when a Relay will not restore this Host ID.
    if (!identityReplaceable() || busy() || m_desiredRunning) return;
    command("replaceIdentity", {}, [this](const QJsonValue &value) {
        const auto identity = value.toObject();
        m_hostId = identity.value("hostId").toString(); m_hostName = identity.value("hostName").toString();
        m_hostPub = identity.value("hostPub").toString(); m_devices.clear(); refreshDeviceUpdateIndicators();
        m_email.clear(); m_registrationRefused = false; m_recoverWithEmail = false;
        appendLog("已作为新电脑：原电脑身份与手机配对记录已归档");
        restoreActivation(relayUrl(), [this] { setMessage("已作为新电脑，请完成激活后重新添加手机"); });
    });
}
void HostController::saveActivation(const QJsonValue &value, const QString &successMessage, bool start) {
    auto obj = value.toObject();
    if (obj.value("hostId").toString() != m_hostId || !obj.value("credential").toString().startsWith("orbis_host_")) { setMessage("服务器返回了无效的激活凭据"); return; }
    obj.insert("relayUrl", relayUrl());
    const auto path = activationPath();
    const auto generation = m_activationGeneration;
    beginActivationIO(); emit changed();
    auto *watcher = new QFutureWatcher<QString>(this);
    connect(watcher, &QFutureWatcher<QString>::finished, this, [this, watcher, obj, successMessage, generation, start] {
        const auto error = watcher->result(); watcher->deleteLater(); endActivationIO();
        if (m_shutdown || generation != m_activationGeneration) { emit changed(); return; }
        if (!error.isEmpty()) { setMessage(error); emit changed(); return; }
        m_email = obj.value("email").toString(); m_credential = obj.value("credential").toString();
        m_challenge.clear(); m_challengeEmail.clear(); m_cooldown = 0; m_recoverWithEmail = false; m_registrationRefused = false;
        setMessage(successMessage); if (start) startHost(); emit changed();
    });
    watcher->setFuture(QtConcurrent::run(&m_activationPool, [path, obj] {
        QString error; CredentialStore::save(path, obj, &error); return error;
    }));
}
void HostController::beginActivationIO() {
    if (m_activationIO++ > 0) return;
#ifdef Q_OS_MACOS
    // HOST-ACTIVITY-05: a Keychain read normally returns at once. Still waiting after a moment almost
    // always means macOS is asking the user to allow it, so name that instead of "reading".
    const auto generation = ++m_activationIOGeneration;
    QTimer::singleShot(1500, this, [this, generation] {
        if (m_activationIO > 0 && generation == m_activationIOGeneration) { m_systemAuthorizationWait = true; emit changed(); }
    });
#endif
}
void HostController::endActivationIO() {
    m_activationIO = qMax(0, m_activationIO - 1);
    if (m_activationIO == 0) { m_systemAuthorizationWait = false; ++m_activationIOGeneration; }
}
void HostController::loadStoredActivation() {
    const auto path = activationPath();
    const auto generation = m_activationGeneration;
    const auto loader = s_credentialLoader ? s_credentialLoader : CredentialLoader([](const QString &file, QString *error) { return CredentialStore::load(file, error); });
    m_credentialsLoading = true; beginActivationIO();
    using Result = QPair<QJsonObject, QString>;
    auto *watcher = new QFutureWatcher<Result>(this);
    connect(watcher, &QFutureWatcher<Result>::finished, this, [this, watcher, generation] {
        const auto result = watcher->result(); watcher->deleteLater(); endActivationIO();
        m_credentialsLoading = false;
        const auto &stored = result.first;
        // An upgrade must retain an activated installation's endpoint even when the
        // compiled default changes. Fresh installs still use ORBIS_DEFAULT_RELAY.
        if (!m_settings.contains("relayUrl") && validRelay(stored.value("relayUrl").toString())) {
            m_settings.setValue("relayUrl", stored.value("relayUrl").toString());
        }
        // A restore or save that started meanwhile owns the newer activation.
        if (generation == m_activationGeneration
            && CredentialStore::normalizedRelay(stored.value("relayUrl").toString()) == CredentialStore::normalizedRelay(relayUrl())) {
            m_email = stored.value("email").toString();
            m_credential = stored.value("credential").toString();
            m_hostId = stored.value("hostId").toString();
        }
        if (!result.second.isEmpty()) setMessage(result.second);
        auto pending = std::move(m_afterStoredActivation); m_afterStoredActivation.clear();
        for (auto &next : pending) if (!m_shutdown) next();
        emit changed();
    });
    watcher->setFuture(QtConcurrent::run(&m_activationPool, [path, loader] {
        QString error; const auto value = loader(path, &error);
        return Result{value, error};
    }));
}
void HostController::afterStoredActivation(std::function<void()> next) {
    if (m_credentialsLoading) m_afterStoredActivation.append(std::move(next));
    else next();
}
void HostController::restoreActivation(const QString &relay, std::function<void()> done) {
    const auto generation = ++m_activationGeneration;
    const auto path = activationPath(), hostId = m_hostId;
    beginActivationIO(); emit changed();
    using Result = QPair<QJsonObject, QString>;
    auto *watcher = new QFutureWatcher<Result>(this);
    connect(watcher, &QFutureWatcher<Result>::finished, this, [this, watcher, relay, generation, done = std::move(done)] {
        const auto result = watcher->result(); watcher->deleteLater(); endActivationIO();
        if (m_shutdown || generation != m_activationGeneration) { emit changed(); return; }
        if (!result.second.isEmpty()) {
            // An unreadable credential store still leaves this Relay's activation and key recovery available now.
            resumeAfterChange(); setMessage(result.second); refreshRegistrationPolicy(); emit changed(); return;
        }
        m_settings.setValue("relayUrl", CredentialStore::normalizedRelay(relay)); m_settings.sync();
        m_email = result.first.value("email").toString(); m_credential = result.first.value("credential").toString();
        m_challenge.clear(); m_challengeEmail.clear(); m_cooldown = 0; m_qr.clear(); m_pairExpires = 0;
        m_recoverWithEmail = false; m_verificationRequired = true; m_registrationAvailable = false;
        m_registrationRefused = false; m_keyRecoveryArmed = true;
        refreshRegistrationPolicy(); done(); emit changed();
    });
    watcher->setFuture(QtConcurrent::run(&m_activationPool, [path, relay, hostId] {
        QString error; const auto value = CredentialStore::selectActivation(path, relay, hostId, &error);
        return Result{value, error};
    }));
}
void HostController::invalidateActivation() {
    if (m_credential.isEmpty()) return;
    const QJsonObject recovery{{"email", m_email}, {"hostId", m_hostId}, {"relayUrl", relayUrl()}};
    m_credential.clear(); m_qr.clear(); m_challenge.clear(); m_challengeEmail.clear(); m_cooldown = 0;
    m_verificationRequired = !m_email.isEmpty();
    m_keyRecoveryArmed = true;
    setMessage("激活凭据已失效，请重新激活");
    // Native key stores may wait on the OS; persist the rejected state off the UI thread.
    const auto generation = m_activationGeneration;
    beginActivationIO();
    auto *watcher = new QFutureWatcher<QString>(this);
    connect(watcher, &QFutureWatcher<QString>::finished, this, [this, watcher, generation] {
        const auto error = watcher->result(); watcher->deleteLater();
        endActivationIO();
        if (!m_shutdown && generation == m_activationGeneration) {
            if (!error.isEmpty()) setMessage("无法重置激活凭据：" + error);
            // HOST-ACT-17: policy may have arrived while secure storage was still busy. Retry the
            // armed recovery now; the helper keeps paused, changing and exiting Hosts in their state.
            maybeRecoverWithHostKey();
        }
        emit changed();
    });
    const auto path = activationPath();
    watcher->setFuture(QtConcurrent::run(&m_activationPool, [path, recovery] {
        QString error;
        CredentialStore::invalidateActivation(path, recovery, &error);
        return error;
    }));
    refreshRegistrationPolicy();
}
void HostController::refreshRegistrationPolicy() {
    if (!validRelay(relayUrl())) return;
    QUrl url(relayUrl() + "/v1/registration/status"); url.setScheme(url.scheme() == "wss" ? "https" : "http");
    QNetworkRequest request(url); request.setTransferTimeout(15000);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
    const auto requestedRelay = relayUrl();
    const auto generation = m_activationGeneration;
    auto *reply = m_network.get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply, requestedRelay, generation] {
        const auto status = QJsonDocument::fromJson(reply->readAll()).object();
        if (requestedRelay == relayUrl() && generation == m_activationGeneration) {
            if (reply->error() == QNetworkReply::NoError && status.value("enabled").isBool()) {
                // Re-verifying the original mailbox can rotate an existing registration,
                // even while new computers are allowed to activate without email.
                m_verificationRequired = status.value("qqEmailVerificationRequired").toBool(true) || m_recoverWithEmail || (!activated() && !m_email.isEmpty());
                m_registrationAvailable = status.value("enabled").toBool() &&
                    (!m_verificationRequired || status.value("mailConfigured").toBool(true));
                m_hostKeyRecovery = status.value("hostKeyRecovery").toBool(false);
            } else {
                m_verificationRequired = true; m_registrationAvailable = false; m_hostKeyRecovery = false;
            }
            maybeRecoverWithHostKey();
            if (activated() && m_state == "connected") bindHostKey();
            emit changed();
        }
        reply->deleteLater();
    });
}
QJsonObject HostController::agentSettings() const { return {{"piEntry", piEntry()}, {"codexEntry", codexEntry()}, {"dshEntry", dshEntry()}, {"dshWebUrl", dshWebUrl()}}; }
void HostController::startHost() {
    if (!activated() || !m_bridgeReady || m_desiredRunning || agentInstalling() || m_activationIO > 0 || m_relaySelectionPending) return;
    m_desiredRunning = true; m_resumePending = false; m_state = "connecting"; m_settings.setValue("runHost", true);
    auto params = agentSettings(); params.insert("relayUrl", relayUrl()); params.insert("credential", m_credential); params.insert("codexEnabled", codexEnabled());
    params.insert("dshEnabled", dshEnabled()); params.insert("piIntegrationEnabled", piIntegrationEnabled());
    params.insert("claudeIntegrationEnabled", claudeIntegrationEnabled());
    command("start", params);
}
void HostController::stopHost() { m_desiredRunning = false; m_resumePending = false; m_settings.setValue("runHost", false); m_qr.clear(); command("stop"); }
void HostController::pair() { command("pair", {}, [this](const QJsonValue &value) { m_qr = value.toObject().value("qr").toString(); m_pairExpires = qint64(value.toObject().value("expiresAt").toDouble()); emit changed(); }); }
void HostController::cancelPair() { m_qr.clear(); m_pairExpires = 0; command("cancelPair"); }
void HostController::revoke(const QString &deviceId) { command("revoke", {{"deviceId", deviceId}}, [this](const QJsonValue &) { setMessage("设备已撤销，连接立即失效"); }); }
void HostController::renameDevice(const QString &deviceId, const QString &label) { command("renameDevice", {{"deviceId", deviceId}, {"label", label}}); }
void HostController::detectAgents(bool checkLatest) {
    auto params = agentSettings(); params.insert("checkLatest", checkLatest);
    command("detect", params, [this](const QJsonValue &value) { m_agents = value.toArray().toVariantList(); emit changed(); });
}
void HostController::updateAgent(const QString &kind) {
    if (!m_bridgeReady || busy()) return;
    m_agentInstallKind = kind; m_agentInstallStage = "queued"; m_agentInstallVersion = "latest"; emit changed();
    // HOST-LIVE-01: installs need the Agent's files released, so a running Host pauses for them and resumes after.
    pauseForChange();
    command("updateAgent", {{"kind", kind}}, [this, kind](const QJsonValue &value) {
        const auto result = value.toObject();
        m_settings.setValue(kind + "Entry", result.value("entry").toString()); m_settings.sync();
        const auto warning = result.value("restartWarning").toString();
        m_agentInstallStage = warning.isEmpty() ? "done" : "restartFailed"; m_agentInstallVersion = result.value("version").toString();
        setMessage(warning.isEmpty() ? kind + " " + result.value("version").toString() + " 已更新到最新版本" +
            (result.value("restarted").toBool() ? "，后台已自动重启。请从 Host 重新打开网页。" : "") : warning); detectAgents();
    });
    if (m_resumePending) afterQueuedCommands([this] { resumeAfterChange(); });
}
void HostController::cancelInstall() {
    if (!agentInstalling() || m_agentInstallStage == "cancelling" || m_agentInstallStage == "restarting") return;
    m_agentInstallStage = "cancelling"; emit changed();
    command("cancelInstall");
}
void HostController::installAllAgents(const QString &action) {
    if (!m_bridgeReady || busy()) return;
    m_agentInstallStage = "queued"; emit changed();
    pauseForChange();
    command("installAll", {{"action", action}}, [this](const QJsonValue &value) {
        const auto result = value.toObject();
        const auto failures = result.value("failures").toArray().toVariantList();
        const auto warnings = result.value("warnings").toArray().toVariantList();
        QStringList details; for (const auto &failure : failures) details.append(failure.toString());
        for (const auto &warning : warnings) details.append(warning.toString());
        m_agentInstallStage = result.value("cancelled").toBool() ? "cancelled" : !failures.isEmpty() ? "error" : !warnings.isEmpty() ? "restartFailed" : "done";
        setMessage(QString("%1：成功 %2 项，失败 %3 项%4").arg(m_agentInstallStage == "cancelled" ? "批量操作已取消" : "批量操作完成").arg(result.value("succeeded").toInt()).arg(failures.size()).arg(details.isEmpty() ? "" : "\n" + details.join('\n')));
        detectAgents();
    });
    if (m_resumePending) afterQueuedCommands([this] { resumeAfterChange(); });
}
void HostController::activateInstallation(const QString &kind, const QString &id) {
    command("activateInstallation", {{"kind", kind}, {"id", id}}, [this](const QJsonValue &value) {
        setMessage("已切换到 Agent " + value.toObject().value("version").toString()); detectAgents();
    });
}
void HostController::piCommand(const QString &action) {
    command("piCommand", {{"action", action}}, [this, action](const QJsonValue &value) {
        m_agents = value.toArray().toVariantList(); emit changed();
        setMessage(action == "install" ? "已安装终端命令 pi，新开的终端窗口里即可使用" : "已移除终端命令 pi");
    });
}
void HostController::enableCodexTerminal() {
    command("enableCodexTerminal", {{"runtimeRoot", m_runtimeRoot}}, [this](const QJsonValue &value) {
        m_agents = value.toArray().toVariantList(); emit changed();
        setMessage("终端接入已修复。请重新打开终端。");
    });
}
void HostController::selectCodexEntry(const QString &entry) {
    command("selectCodexEntry", {{"entry", entry}}, [this](const QJsonValue &value) {
        m_settings.setValue("codexEntry", value.toObject().value("entry").toString()); m_settings.sync();
        setMessage("已切换到 Codex " + value.toObject().value("version").toString()); detectAgents();
    });
}
void HostController::setProviders(const QVariantList &providers) {
    if (m_providers == providers) return;
    m_providers = providers; emit providersChanged();
}
void HostController::setProviderPresets(const QVariantList &presets) {
    if (m_providerPresets == presets) return;
    m_providerPresets = presets; emit providerPresetsChanged();
}
void HostController::loadProviders(const QString &kind) {
    if (m_providerKind != kind) { setProviders({}); setProviderPresets({}); ++m_draftGeneration; }
    m_providerKind = kind; emit changed();
    command("provider.list", {{"kind", kind}}, [this, kind](const QJsonValue &value) {
        if (m_providerKind == kind) setProviders(value.toArray().toVariantList());
    });
    command("provider.presets", {{"kind", kind}}, [this, kind](const QJsonValue &value) {
        if (m_providerKind == kind) setProviderPresets(value.toArray().toVariantList());
    });
    if (kind == "pi") command("provider.piDefault", {}, [this](const QJsonValue &value) { m_piDefaultProvider = value.toString(); emit changed(); });
}
void HostController::reorderProviders(const QVariantList &ids) {
    const auto kind = m_providerKind;
    command("provider.reorder", {{"kind", kind}, {"ids", QJsonArray::fromVariantList(ids)}}, [this, kind](const QJsonValue &value) {
        if (kind == m_providerKind) setProviders(value.toArray().toVariantList());
    });
}
void HostController::editProvider(const QString &id) {
    const auto generation = ++m_draftGeneration;
    command("provider.draft", {{"kind", m_providerKind}, {"id", id}}, [this, generation](const QJsonValue &value) { if (generation == m_draftGeneration) emit providerDraftReady(value.toObject().toVariantMap()); });
}
void HostController::presetProvider(const QString &id) {
    const auto generation = ++m_draftGeneration;
    command("provider.draft", {{"kind", m_providerKind}, {"presetId", id == "custom" ? QString() : id}}, [this, generation](const QJsonValue &value) { if (generation == m_draftGeneration) emit providerDraftReady(value.toObject().toVariantMap()); });
}
void HostController::previewProvider(const QVariantMap &draft) {
    const auto generation = m_draftGeneration;
    command("provider.preview", QJsonObject::fromVariantMap(draft), [this, generation](const QJsonValue &value) { if (generation == m_draftGeneration) emit providerPreviewReady(value.toObject().toVariantMap()); });
}
void HostController::loadCodexPreferences() {
    command("provider.codexPreferences", {}, [this](const QJsonValue &value) { emit codexPreferencesReady(value.toObject().toVariantMap()); });
}
void HostController::saveCodexPreferences(const QVariantMap &preferences) {
    command("provider.saveCodexPreferences", QJsonObject::fromVariantMap(preferences), [this](const QJsonValue &) { emit codexPreferencesSaved(); setMessage("Codex 通用配置已保存"); });
}
void HostController::checkProvider(const QString &id) {
    if (checkingProviderIds().contains(id)) return;
    const auto kind = m_providerKind;
    command("provider.check", {{"kind", kind}, {"id", id}}, [this, kind](const QJsonValue &value) {
        if (kind != m_providerKind) return;
        const auto result = value.toObject();
        const bool failed = result.value("status").toString() == "failed";
        emit providerInfoReady("端点连通性", failed ? "端点无法连接或请求超时" : QString("端点可达，%1 ms，HTTP %2\n此检查不验证 API Key 或模型权限。").arg(result.value("latencyMs").toInt()).arg(result.value("httpStatus").toInt()));
    });
}
void HostController::querySubscription(const QString &id) {
    const auto kind = m_providerKind;
    command("provider.subscription", {{"kind", kind}, {"id", id}}, [this, kind, id](const QJsonValue &value) {
        if (kind != m_providerKind) return;
        bool current = false;
        for (const auto &item : m_providers) {
            const auto provider = item.toMap();
            if (provider.value("id").toString() == id && provider.value("enabled").toBool()) current = true;
        }
        if (!current) return;
        const auto quota = value.toObject();
        QStringList lines;
        for (const auto &item : quota.value("windows").toArray()) {
            const auto window = item.toObject();
            const auto label = window.value("name").toString() == "five_hour" ? QStringLiteral("5 小时配额") : QStringLiteral("周配额");
            QString line = label + "：" + (window.value("remainingPercent").isDouble()
                ? "剩余 " + QString::number(window.value("remainingPercent").toDouble(), 'f', 1) + "%" : "暂不可用");
            if (window.value("resetsAt").isDouble()) line += "\n重置时间：" + QDateTime::fromMSecsSinceEpoch(static_cast<qint64>(window.value("resetsAt").toDouble())).toString("yyyy-MM-dd HH:mm");
            lines.append(line);
        }
        lines.append("查询时间：" + QDateTime::fromMSecsSinceEpoch(static_cast<qint64>(quota.value("checkedAt").toDouble())).toString("yyyy-MM-dd HH:mm"));
        emit providerInfoReady("当前订阅配额", lines.join("\n\n"));
    });
}
void HostController::fetchProviderModels(const QVariantMap &draft) {
    if (providerModelsLoading()) return;
    const auto generation = m_draftGeneration;
    command("provider.models", QJsonObject::fromVariantMap(draft), [this, generation](const QJsonValue &value) { if (generation == m_draftGeneration) emit providerModelsReady(value.toArray().toVariantList()); });
}
void HostController::oauthAccount(const QString &operation, const QString &id) {
    command("provider.oauth", {{"operation", operation}, {"accountId", id}}, [this, operation](const QJsonValue &value) { emit oauthAccountResult(operation, value.toVariant()); });
}
void HostController::openProvider(const QString &id) {
    if (!m_bridgeReady || busy()) return;
    QJsonObject params{{"kind", m_providerKind}, {"id", id}};
    if (m_providerKind == "pi" || m_providerKind == "codex") {
        const auto cwd = selectWorkspace(m_providerKind);
        if (cwd.isEmpty()) return;
        params.insert("cwd", cwd);
    }
    command("provider.open", params, [this](const QJsonValue &) { setMessage("供应商已启用，已打开 Agent。Pi 请使用 /model 选择模型。"); });
}
void HostController::saveProvider(const QVariantMap &draft) {
    const auto kind = draft.value("kind").toString();
    command("provider.save", QJsonObject::fromVariantMap(draft), [this, kind](const QJsonValue &value) {
        if (kind != m_providerKind) return;
        setProviders(value.toArray().toVariantList()); emit providerSaved(); setMessage("供应商已保存；已启用配置会同步到 Agent");
    });
}
void HostController::switchProvider(const QString &id, bool enabled) {
    const auto kind = m_providerKind;
    command("provider.switch", {{"kind", kind}, {"id", id}, {"enabled", enabled}}, [this, kind](const QJsonValue &value) {
        if (kind != m_providerKind) return;
        setProviders(value.toArray().toVariantList());
        setMessage(kind == "pi" ? "Pi 显式供应商已更新；已有 Pi 请重新打开，再用 /model 选择模型。" : "供应商已切换。请重新打开会话；独立终端也需重启。");
    });
}
void HostController::removeProvider(const QString &id) {
    const auto kind = m_providerKind;
    command("provider.remove", {{"kind", kind}, {"id", id}}, [this, kind](const QJsonValue &value) { if (kind == m_providerKind) { setProviders(value.toArray().toVariantList()); setMessage("供应商已删除"); } });
}
void HostController::copyProvider(const QString &id) {
    const auto kind = m_providerKind;
    command("provider.copy", {{"kind", kind}, {"id", id}}, [this, kind](const QJsonValue &value) { if (kind == m_providerKind) { setProviders(value.toArray().toVariantList()); setMessage("供应商已复制，请编辑副本后启用"); } });
}
QString HostController::selectWorkspace(const QString &kind) {
    const auto cwd = QFileDialog::getExistingDirectory(nullptr,
        QString("选择 %1 工作区").arg(kind == "pi" ? "Pi" : kind == "claude" ? "Claude Code" : "Codex"),
        m_settings.value("lastWorkspace", QDir::homePath()).toString());
    if (!cwd.isEmpty()) m_settings.setValue("lastWorkspace", cwd);
    return cwd;
}
void HostController::restartDshServer() {
    if (!m_bridgeReady || busy()) return;
    pauseForChange();
    setMessage("正在重启 DSH Server…");
    command("restartDshServer", {}, [this](const QJsonValue &) {
        setMessage("DSH Server 已就绪，请从 Host 重新打开网页工作台");
    });
    if (m_resumePending) afterQueuedCommands([this] { resumeAfterChange(); });
}
void HostController::openAgent(const QString &kind) {
    if (kind == "pi" || kind == "claude") { openAgentTui(kind); return; }
    command("openAgent", {{"kind", kind}});
}
void HostController::openAgentTui(const QString &kind) {
    if (!m_bridgeReady || busy()) return;
    QJsonObject params{{"kind", kind}, {"mode", "tui"}};
    if (kind == "pi" || kind == "codex" || kind == "claude") {
        const auto cwd = selectWorkspace(kind);
        if (cwd.isEmpty()) return;
        params.insert("cwd", cwd);
    }
    command("openAgent", params, [this, kind](const QJsonValue &) {
        setMessage(kind == "dsh" ? "已打开 DeepSeek Harness 网页工作台" : QString("已打开 %1 终端界面。请在新窗口中继续操作。").arg(kind == "pi" ? "Pi" : kind == "claude" ? "Claude Code" : "Codex"));
    });
}
void HostController::setAutoStart(bool enabled) {
    if (enabled == autoStart()) return;
#if defined(Q_OS_WIN)
    QSettings startupRegistry("HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", QSettings::NativeFormat);
    if (enabled) startupRegistry.setValue("OrbisHost", '"' + QDir::toNativeSeparators(QCoreApplication::applicationFilePath()) + "\" --tray");
    else startupRegistry.remove("OrbisHost");
    startupRegistry.sync();
    if (startupRegistry.status() != QSettings::NoError) { setMessage("无法保存 Windows 登录启动设置"); return; }
#elif defined(Q_OS_MACOS)
    const auto plist = QStandardPaths::writableLocation(QStandardPaths::HomeLocation) + "/Library/LaunchAgents/com.orbis.host.plist";
    QString error;
    if (!writeLoginAgent(plist, QCoreApplication::applicationFilePath(), enabled, &error)) { setMessage(error); return; }
#endif
    m_settings.setValue("autoStart", enabled); m_settings.sync();
    emit changed();
    setMessage(enabled ? "已开启登录启动" : "已关闭登录启动");
}

void HostController::saveSettings(const QString &relay, bool startup, bool codex, const QString &name, bool dsh, const QString &dshUrl, bool piIntegration, bool claudeIntegration) {
    if (busy()) return;
    const auto normalized = CredentialStore::normalizedRelay(relay);
    if (!validRelay(normalized)) { setMessage("中继地址必须使用 wss://；本机测试可使用 ws://127.0.0.1"); return; }
    if (!dshUrl.trimmed().isEmpty()) {
        const QUrl web(dshUrl.trimmed());
        const auto query = QUrlQuery(web).queryItems();
        if (!web.isValid() || web.scheme() != "http" || !(web.host() == "127.0.0.1" || web.host() == "localhost" || web.host() == "::1")
            || !web.userInfo().isEmpty() || (!web.path().isEmpty() && web.path() != "/") || web.hasFragment()
            || query.size() != 1 || query.first().first != "token" || !QRegularExpression("^[A-Za-z0-9_-]{16,}$").match(query.first().second).hasMatch()) {
            setMessage("请填写本机 dsh web 启动时输出的完整 http://127.0.0.1:端口/?token=... 链接"); return;
        }
    }
    if (normalized != CredentialStore::normalizedRelay(relayUrl())) {
        // Drain the old runtime first: an authentication refusal from that connection
        // must finish persisting before the worker selects another Relay's active slot.
        pauseForChange(); m_relaySelectionPending = true; emit changed();
        afterQueuedCommands([this, normalized, startup, codex, name, dsh, dshUrl, piIntegration, claudeIntegration] {
            m_relaySelectionPending = false;
            restoreActivation(normalized, [this, normalized, startup, codex, name, dsh, dshUrl, piIntegration, claudeIntegration] {
                afterQueuedCommands([this, normalized, startup, codex, name, dsh, dshUrl, piIntegration, claudeIntegration] {
                    saveSettings(normalized, startup, codex, name, dsh, dshUrl, piIntegration, claudeIntegration);
                });
            });
        });
        return;
    }
    // Agent 入口由 Orbis 自己维护（安装、激活、共享记录），设置里不再提供路径字段。
    // Kept in the desktop API for older QML callers; the current switch applies independently.
    if (startup != autoStart()) { setAutoStart(startup); if (startup != autoStart()) return; }

    // HOST-LIVE-01: fields the running service was started with apply by pausing and resuming it;
    // terminal integrations and login startup keep applying live without touching the connection.
    const auto hostName = name.trimmed();
    const bool rename = !hostName.isEmpty() && hostName != m_hostName;
    if (normalized != relayUrl() || rename || codex != codexEnabled() || dsh != dshEnabled() || dshUrl.trimmed() != dshWebUrl()) pauseForChange();
    m_settings.setValue("relayUrl", normalized); m_settings.setValue("codexEnabled", codex);
    m_settings.setValue("dshEnabled", dsh); m_settings.setValue("dshWebUrl", dshUrl.trimmed());
#ifdef Q_OS_MACOS
    // 立即生效，不等下次启动 Host：用户关掉它往往是为了接着删除应用。
    if (piIntegration != piIntegrationEnabled()) command("piIntegration", {{"enabled", piIntegration}});
    m_settings.setValue("piIntegrationEnabled", piIntegration);
#endif
    // Applied immediately as well; the setting is only kept once Claude Code accepted the change.
    if (claudeIntegration != claudeIntegrationEnabled()) {
        command("claudeIntegration", {{"enabled", claudeIntegration}}, [this, claudeIntegration](const QJsonValue &) {
            m_settings.setValue("claudeIntegrationEnabled", claudeIntegration); m_settings.sync(); emit changed();
            setMessage(claudeIntegration ? "已为 Claude Code 安装 Orbis 插件；新开的 Claude Code 会连接 Orbis，已在运行的请执行 /reload-plugins"
                                         : "已从 Claude Code 卸载 Orbis 插件");
        });
    }
    m_settings.sync();
    if (rename) command("rename", {{"name", hostName}}, [this, hostName](const QJsonValue &) { m_hostName = hostName; emit changed(); });
    if (m_resumePending) afterQueuedCommands([this] { resumeAfterChange(); });
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
    for (const auto &value : m_agents) {
        auto agent = QJsonObject::fromVariantMap(value.toMap());
        for (const auto &key : {"path", "entry", "error", "installations", "copies"}) agent.remove(key);
        agents.append(agent);
    }
    QJsonObject result{{"version", version()}, {"state", m_state}, {"activated", activated()}, {"devices", m_devices.size()}, {"agents", agents}, {"codexDesktop", QJsonObject::fromVariantMap(m_codexDesktop)}, {"dshDesktop", QJsonObject::fromVariantMap(m_dshDesktop)}, {"logs", QJsonArray::fromStringList(m_logs.snapshot())}};
    return QString::fromUtf8(QJsonDocument(result).toJson());
}
void HostController::copyDiagnostics() { QApplication::clipboard()->setText(diagnostics()); setMessage("脱敏诊断信息已复制"); }
void HostController::exportDiagnostics() {
    const auto path = QFileDialog::getSaveFileName(nullptr, "导出诊断信息", QStandardPaths::writableLocation(QStandardPaths::DesktopLocation) + "/orbis-diagnostics.json", "JSON (*.json)");
    if (path.isEmpty()) return;
    QSaveFile file(path);
    if (file.open(QIODevice::WriteOnly) && file.write(diagnostics().toUtf8()) >= 0 && file.commit()) setMessage("诊断信息已导出"); else setMessage("无法写入诊断文件");
}
void HostController::checkUpdates() { checkUpdatesInternal(true); }
void HostController::checkUpdatesInternal(bool announce) {
    const QUrl siteUrl("https://orbising.com/v1/site");
    QNetworkRequest request(siteUrl); request.setRawHeader("User-Agent", "OrbisHost/" ORBIS_VERSION); request.setTransferTimeout(15000);
    auto *reply = m_network.get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply, announce] {
        const auto payload = reply->readAll();
        const auto status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const auto document = QJsonDocument::fromJson(payload);
        const auto result = document.object();
        if (reply->error() != QNetworkReply::NoError || (status != 0 && (status < 200 || status >= 300)) || !document.isObject()) {
            if (announce) setMessage("暂时无法获取公开版本信息，请在下载页查看发布状态");
        }
        else {
            m_androidLatestVersion = result.value("androidVersion").toString();
            m_androidLatestVersionCode = result.value("androidVersionCode").toInt();
            refreshDeviceUpdateIndicators();
            auto tag = result.value("version").toString(); if (tag.startsWith('v')) tag.remove(0, 1);
            QString installerUrl, checksumUrl;
#ifdef Q_OS_MACOS
            const auto releaseFiles = result.value("macos").toArray();
#if defined(Q_PROCESSOR_ARM_64)
            const QString suffix = "-macos-arm64.dmg";
#else
            const QString suffix = "-macos-x64.dmg";
#endif
            // macOS versions are independent of the Windows updater's version field.
            tag.clear();
            for (const auto &fileValue : releaseFiles) {
                const auto name = fileValue.toObject().value("name").toString();
                if (!name.startsWith("OrbisHost-") || !name.endsWith(suffix)) continue;
                const auto candidate = name.mid(10, name.size() - 10 - suffix.size());
                if (QVersionNumber::fromString(candidate) > QVersionNumber::fromString(tag)) tag = candidate;
            }
            const auto expectedName = QString("OrbisHost-%1%2").arg(tag, suffix);
#else
            const auto releaseFiles = result.value("windows").toArray();
            const auto expectedName = QString("OrbisHost-%1-windows-x64-setup.exe").arg(tag);
#endif
            for (const auto &fileValue : releaseFiles) {
                const auto file = fileValue.toObject();
                if (file.value("name").toString() != expectedName) continue;
                const QUrl base("https://orbising.com/");
                installerUrl = base.resolved(QUrl(file.value("url").toString())).toString();
                checksumUrl = base.resolved(QUrl(file.value("checksumUrl").toString())).toString();
                break;
            }
            if (QVersionNumber::fromString(tag) > QVersionNumber::fromString(version()) && !installerUrl.isEmpty() && !checksumUrl.isEmpty()) {
                m_updateVersion = tag; m_updateInstallerUrl = installerUrl; m_updateChecksumUrl = checksumUrl;
                if (announce) setMessage("发现新版本 " + tag + "，点击“更新 Host”下载安装");
            }
            else {
                m_updateVersion.clear(); m_updateInstallerUrl.clear(); m_updateChecksumUrl.clear();
                if (announce) setMessage("当前已是最新公开版本");
            }
            emit changed();
        }
        reply->deleteLater();
    });
}
void HostController::refreshDeviceUpdateIndicators() {
    const auto latestVersion = QVersionNumber::fromString(m_androidLatestVersion);
    QVariantList updated;
    updated.reserve(m_devices.size());
    for (const auto &entry : m_devices) {
        auto device = entry.toMap();
        const auto installedVersion = QVersionNumber::fromString(device.value("appVersion").toString());
        const auto installedCode = device.value("appVersionCode").toInt();
        const bool hasLatest = !latestVersion.isNull() && m_androidLatestVersionCode > 0;
        const bool hasInstalled = !installedVersion.isNull() && installedCode > 0;
        device.insert("latestAndroidVersion", m_androidLatestVersion);
        device.insert("androidUpdateAvailable", hasLatest && (hasInstalled
            ? m_androidLatestVersionCode > installedCode
            : !installedVersion.isNull() && QVersionNumber::compare(latestVersion, installedVersion) > 0));
        updated.append(device);
    }
    m_devices = updated;
}

void HostController::updateHost() {
    if (m_exiting || m_updating) return;
    if (m_updateInstallerUrl.isEmpty() || m_updateChecksumUrl.isEmpty()) { checkUpdates(); return; }
    emit updateConfirmationRequested();
}
void HostController::confirmHostUpdate() {
    if (m_exiting || m_updating || !hostUpdateAvailable()) return;
    m_updating = true;
    const auto generation = ++m_updateGeneration;
    const auto checksumUrl = m_updateChecksumUrl;
    const auto installerUrl = m_updateInstallerUrl;
    const auto updateVersion = m_updateVersion;
    setMessage("正在下载 Host 更新 " + m_updateVersion + "…");
    QNetworkRequest installerRequest{QUrl(m_updateInstallerUrl)};
    installerRequest.setRawHeader("User-Agent", "OrbisHost/" ORBIS_VERSION);
    installerRequest.setTransferTimeout(120000);
    auto *installerReply = m_network.get(installerRequest);
    m_updateReplies = {installerReply};
    connect(installerReply, &QNetworkReply::finished, this, [this, installerReply, generation, checksumUrl, installerUrl, updateVersion] {
        if (generation != m_updateGeneration) { installerReply->deleteLater(); return; }
        const auto installer = installerReply->readAll();
        const auto error = installerReply->error();
        const auto errorText = installerReply->errorString();
        const auto status = installerReply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        installerReply->deleteLater();
        if (error != QNetworkReply::NoError || (status != 0 && (status < 200 || status >= 300)) || installer.isEmpty()) {
            m_updating = false;
            setMessage("Host 更新下载失败：" + (errorText.isEmpty() ? QString("HTTP %1").arg(status) : errorText)); return;
        }
        QNetworkRequest checksumRequest{QUrl(checksumUrl)};
        checksumRequest.setRawHeader("User-Agent", "OrbisHost/" ORBIS_VERSION);
        checksumRequest.setTransferTimeout(15000);
        auto *checksumReply = m_network.get(checksumRequest);
        m_updateReplies = {checksumReply};
        connect(checksumReply, &QNetworkReply::finished, this, [this, checksumReply, installer, generation, installerUrl, updateVersion] {
            if (generation != m_updateGeneration) { checksumReply->deleteLater(); return; }
            const auto checksumText = QString::fromUtf8(checksumReply->readAll()).trimmed();
            const auto error = checksumReply->error();
            const auto errorText = checksumReply->errorString();
            const auto status = checksumReply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
            checksumReply->deleteLater();
            if (error != QNetworkReply::NoError || (status != 0 && (status < 200 || status >= 300))) {
                m_updating = false;
                setMessage("Host 更新校验文件下载失败：" + (errorText.isEmpty() ? QString("HTTP %1").arg(status) : errorText)); return;
            }
            const auto expected = checksumText.section(QRegularExpression("\\s+"), 0, 0).toLower();
            const auto directory = QDir(QStandardPaths::writableLocation(QStandardPaths::TempLocation)).filePath("orbis-update-" + QUuid::createUuid().toString(QUuid::WithoutBraces));
            const auto path = QDir(directory).filePath(
#ifdef Q_OS_MACOS
                QUrl(installerUrl).fileName()
#else
                QString("OrbisHost-%1-setup.exe").arg(updateVersion)
#endif
            );
            // Hashing and committing a large installer must not block confirmation or window input.
            auto *verified = new QFutureWatcher<QString>(this);
            connect(verified, &QFutureWatcher<QString>::finished, this, [this, verified, generation, path] {
                const auto error = verified->result(); verified->deleteLater();
                if (generation != m_updateGeneration) { QFile::remove(path); return; }
                m_updating = false;
                if (!error.isEmpty()) { setMessage(error); return; }
                beginExit(path);
            });
            verified->setFuture(QtConcurrent::run([installer, expected, directory, path]() -> QString {
                const auto actual = QCryptographicHash::hash(installer, QCryptographicHash::Sha256).toHex().toLower();
                if (expected.size() != 64 || expected != actual) return "Host 更新校验失败，已取消安装";
                QSaveFile file(path);
                if (!QDir().mkpath(directory) || !file.open(QIODevice::WriteOnly) || file.write(installer) != installer.size() || !file.commit())
                    return "无法保存 Host 更新安装包";
                return {};
            }));
        });
    });
}
void HostController::requestExit() {
    if (!m_exiting) emit exitConfirmationRequested();
}
void HostController::requestInstallerExit() {
    if (!m_exiting && !m_updating) emit installerConfirmationRequested();
    else emit exitCancelled();
}
void HostController::cancelExit() { if (!m_exiting) emit exitCancelled(); }
void HostController::confirmExit() {
    if (m_exiting) return;
    ++m_updateGeneration; m_updating = false;
    for (const auto &reply : m_updateReplies) if (reply) reply->abort();
    m_updateReplies.clear();
    beginExit();
}
void HostController::beginExit(const QString &installer) {
    if (m_exiting || m_exitWorker.state() != QProcess::NotRunning) return;
    m_exiting = true; m_shutdown = true; m_tick.stop();
    m_exitInstaller = installer; m_exitError.clear(); m_exitOutput.clear(); m_exitWorkerDone = false;
    setMessage("正在停止相关后台…");
    m_exitWorker.setProcessEnvironment(m_bridge.processEnvironment());
    m_exitWorker.setProgram(m_bridge.program());
    m_exitWorker.setArguments({m_runtimeRoot + "/packages/host/dist/desktop-shutdown.js"});
    m_exitDeadline.start(60000);
    m_exitWorker.start();
}
void HostController::failExit(const QString &message) {
    m_exitDeadline.stop(); m_exiting = false; m_shutdown = false; m_updating = false;
    m_exitInstaller.clear(); m_tick.start();
    // Reopen only the bridge after partial cleanup; the user explicitly resumes connections.
    if (m_bridge.state() == QProcess::NotRunning) { m_deferStartup = true; m_state = "stopped"; launchBridge(); }
    setMessage(message);
    emit exitFailed();
}
void HostController::finishExit() {
    if (!m_exitInstaller.isEmpty()) {
        if (!m_installLauncher(m_exitInstaller)) { failExit("无法打开更新安装包，请重试"); return; }
    }
    m_exitApproved = true;
    emit exitReady();
}
void HostController::openDownloads() { QDesktopServices::openUrl(QUrl("https://orbising.com/")); }
void HostController::openDataDirectory() { QDesktopServices::openUrl(QUrl::fromLocalFile(m_dataDir)); }
void HostController::clearMessage() { m_message.clear(); emit changed(); }
void HostController::setMessage(const QString &message) { m_message = message; appendLog(message); emit changed(); }
void HostController::setDownload(const QString &label, qint64 received, qint64 total) {
    m_downloadLabel = label; m_downloadReceived = qMax<qint64>(0, received); m_downloadTotal = qMax<qint64>(0, total);
    emit changed();
}
void HostController::clearDownload() {
    if (m_downloadReceived < 0) return;
    m_downloadReceived = -1; m_downloadTotal = 0; m_downloadLabel.clear();
    emit changed();
}
void HostController::appendLog(QString message) {
    if (message.isEmpty()) return;
    message.replace(QRegularExpression("orbis_host_[A-Za-z0-9_-]+"), "[credential]");
    message.replace(QRegularExpression("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"), "[email]");
    message.replace(QDir::homePath(), "[user]", Qt::CaseInsensitive);
    message.replace(QDir::toNativeSeparators(QDir::homePath()), "[user]", Qt::CaseInsensitive);
    if (!m_credential.isEmpty()) message.replace(m_credential, "[credential]");
    m_logs.append(QDateTime::currentDateTime().toString("HH:mm:ss") + "  " + message.left(1500));
}
void HostController::shutdown() {
    if (m_shutdown) return;
    m_shutdown = true; m_tick.stop();
    if (m_bridge.state() == QProcess::Running) {
        command("shutdown"); m_bridge.closeWriteChannel();
        if (!m_bridge.waitForFinished(45000)) { m_bridge.terminate(); if (!m_bridge.waitForFinished(2000)) { m_bridge.kill(); m_bridge.waitForFinished(1000); } }
    }
}
