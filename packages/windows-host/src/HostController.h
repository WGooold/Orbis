#pragma once
#include <QObject>
#include <QJsonObject>
#include <QJsonValue>
#include <QProcess>
#include <QSettings>
#include <QNetworkAccessManager>
#include <QTimer>
#include <QVariantList>
#include <QHash>
#include <functional>

class HostController : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString state READ state NOTIFY changed)
    Q_PROPERTY(QString message READ message NOTIFY changed)
    Q_PROPERTY(QString email READ email NOTIFY changed)
    Q_PROPERTY(QString hostName READ hostName NOTIFY changed)
    Q_PROPERTY(QString relayUrl READ relayUrl NOTIFY changed)
    Q_PROPERTY(QString hostId READ hostId NOTIFY changed)
    Q_PROPERTY(QString qr READ qr NOTIFY changed)
    Q_PROPERTY(QString logs READ logs NOTIFY changed)
    Q_PROPERTY(QString version READ version CONSTANT)
    Q_PROPERTY(QString piEntry READ piEntry NOTIFY changed)
    Q_PROPERTY(QString codexEntry READ codexEntry NOTIFY changed)
    Q_PROPERTY(bool activated READ activated NOTIFY changed)
    Q_PROPERTY(bool verificationRequired READ verificationRequired NOTIFY changed)
    Q_PROPERTY(bool registrationAvailable READ registrationAvailable NOTIFY changed)
    Q_PROPERTY(bool busy READ busy NOTIFY changed)
    Q_PROPERTY(bool bridgeReady READ bridgeReady NOTIFY changed)
    Q_PROPERTY(bool autoStart READ autoStart NOTIFY changed)
    Q_PROPERTY(bool codexEnabled READ codexEnabled NOTIFY changed)
    Q_PROPERTY(int cooldown READ cooldown NOTIFY changed)
    Q_PROPERTY(int pairSeconds READ pairSeconds NOTIFY changed)
    Q_PROPERTY(int runtimeCount READ runtimeCount NOTIFY changed)
    Q_PROPERTY(QVariantList devices READ devices NOTIFY changed)
    Q_PROPERTY(QVariantList agents READ agents NOTIFY changed)
public:
    HostController(QString runtimeRoot, QString dataDir, QString hostStateDir, QObject *parent = nullptr);
    ~HostController() override;
    QString state() const { return m_state; }
    QString message() const { return m_message; }
    QString email() const { return m_email; }
    QString hostName() const { return m_hostName; }
    QString relayUrl() const { return m_settings.value("relayUrl", ORBIS_DEFAULT_RELAY).toString(); }
    QString hostId() const { return m_hostId; }
    QString qr() const { return m_qr; }
    QString logs() const { return m_logs.join('\n'); }
    QString version() const { return ORBIS_VERSION; }
    QString piEntry() const { return m_settings.value("piEntry").toString(); }
    QString codexEntry() const { return m_settings.value("codexEntry").toString(); }
    bool activated() const { return !m_credential.isEmpty(); }
    bool verificationRequired() const { return m_verificationRequired; }
    bool registrationAvailable() const { return m_registrationAvailable; }
    bool busy() const { return m_busy > 0; }
    bool bridgeReady() const { return m_bridgeReady; }
    bool autoStart() const { return m_settings.value("autoStart", false).toBool(); }
    bool codexEnabled() const { return m_settings.value("codexEnabled", true).toBool(); }
    int cooldown() const { return m_cooldown; }
    int pairSeconds() const;
    int runtimeCount() const { return m_runtimeCount; }
    QVariantList devices() const { return m_devices; }
    QVariantList agents() const { return m_agents; }
    Q_INVOKABLE void requestCode(const QString &email);
    Q_INVOKABLE void activate(const QString &email, const QString &code);
    Q_INVOKABLE void activateWithoutEmail();
    Q_INVOKABLE void refreshRegistrationPolicy();
    Q_INVOKABLE void startHost();
    Q_INVOKABLE void stopHost();
    Q_INVOKABLE void pair();
    Q_INVOKABLE void cancelPair();
    Q_INVOKABLE void revoke(const QString &deviceId);
    Q_INVOKABLE void renameDevice(const QString &deviceId, const QString &label);
    Q_INVOKABLE void detectAgents();
    Q_INVOKABLE void installAgent(const QString &kind);
    Q_INVOKABLE void openAgent(const QString &kind);
    Q_INVOKABLE void saveSettings(const QString &relay, bool startup, bool codex, const QString &piPath, const QString &codexPath, const QString &name);
    Q_INVOKABLE void diagnose();
    Q_INVOKABLE void exportDiagnostics();
    Q_INVOKABLE void copyDiagnostics();
    Q_INVOKABLE void checkUpdates();
    Q_INVOKABLE void openDownloads();
    Q_INVOKABLE void openDataDirectory();
    Q_INVOKABLE void clearMessage();
    void shutdown();
signals:
    void changed();
    void paired();
    void notification(const QString &title, const QString &body);
private:
    using Callback = std::function<void(const QJsonValue &)>;
    void launchBridge();
    void command(const QString &method, const QJsonObject &params = {}, Callback done = {});
    void receiveLine(const QJsonObject &line);
    void api(const QString &endpoint, const QJsonObject &body, Callback done);
    void saveActivation(const QJsonValue &value, const QString &successMessage);
    void setMessage(const QString &message);
    void appendLog(QString message);
    QJsonObject agentSettings() const;
    QString diagnostics() const;
    QString m_runtimeRoot, m_dataDir, m_hostStateDir;
    QSettings m_settings;
    QProcess m_bridge;
    QNetworkAccessManager m_network;
    QTimer m_tick;
    QByteArray m_stdout;
    QHash<int, Callback> m_pending;
    QHash<int, QString> m_methods;
    QString m_state = "stopped", m_message, m_email, m_hostName, m_hostId, m_credential, m_qr, m_challenge, m_challengeEmail;
    QStringList m_logs;
    QVariantList m_devices, m_agents;
    int m_nextId = 1, m_busy = 0, m_cooldown = 0, m_runtimeCount = 0, m_crashes = 0;
    int m_policyTicks = 0;
    qint64 m_pairExpires = 0;
    bool m_bridgeReady = false, m_shutdown = false, m_desiredRunning = false;
    bool m_verificationRequired = true, m_registrationAvailable = false;
};
