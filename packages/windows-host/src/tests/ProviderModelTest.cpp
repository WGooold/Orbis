#include <QFile>
#include <QQmlComponent>
#include <QQmlEngine>
#include <QJsonDocument>
#include <QtTest>
#include <memory>

class ProviderModelTest : public QObject {
    Q_OBJECT
private slots:
    void overviewAgentActionsPreserveUnknownInstallationState() {
        QFile file(QStringLiteral(ORBIS_MAIN_QML));
        QVERIFY(file.open(QIODevice::ReadOnly));
        const QString source = QString::fromUtf8(file.readAll());
        auto function = [&](const QString &name) {
            const int start = source.indexOf("    function " + name + "(");
            if (start < 0) return QString();
            const int open = source.indexOf('{', start);
            if (open < 0) return QString();
            int depth = 0;
            for (int index = open; index < source.size(); ++index) {
                if (source.at(index) == '{') ++depth;
                else if (source.at(index) == '}' && --depth == 0) return source.mid(start, index - start + 1);
            }
            return QString();
        };
        const QString actionText = function("overviewAgentActionText");
        const QString actionEnabled = function("overviewAgentActionEnabled");
        const QString actionPrimary = function("overviewAgentActionPrimary");
        QVERIFY(!actionText.isEmpty()); QVERIFY(!actionEnabled.isEmpty()); QVERIFY(!actionPrimary.isEmpty());
        QQmlEngine engine;
        QQmlComponent component(&engine);
        const QString qml = QStringLiteral(R"(
import QtQuick
Item {
    id: window
    property var host: ({bridgeReady: true, busy: false})
    property bool connectionError: false
    property string nextStep: "install"
    function agentPhoneState(agent, sessions) { return agent.installed === undefined ? "等待检测" : "未安装" }
    %1
    %2
    %3
    function report() {
        var unknown = {kind: "codex", installable: true}
        var missing = {kind: "codex", installed: false}
        var installed = {kind: "codex", installed: true, broken: false}
        var openclaw = {kind: "openclaw", installed: true}
        return JSON.stringify({
            unknown: {text: overviewAgentActionText(unknown, true), enabled: overviewAgentActionEnabled(unknown, true), primary: overviewAgentActionPrimary(unknown, true)},
            missing: {text: overviewAgentActionText(missing, true), enabled: overviewAgentActionEnabled(missing, true), primary: overviewAgentActionPrimary(missing, true)},
            installed: {text: overviewAgentActionText(installed, true), enabled: overviewAgentActionEnabled(installed, true), primary: overviewAgentActionPrimary(installed, true)},
            openclaw: {text: overviewAgentActionText(openclaw, false), enabled: overviewAgentActionEnabled(openclaw, false)}
        })
    }
}
)").arg(actionText, actionEnabled, actionPrimary);
        component.setData(qml.toUtf8(), QUrl());
        QVERIFY2(component.isReady(), qPrintable(component.errorString()));
        std::unique_ptr<QObject> view(component.create());
        QVERIFY2(view != nullptr, qPrintable(component.errorString()));
        QVariant result;
        QVERIFY(QMetaObject::invokeMethod(view.get(), "report", Q_RETURN_ARG(QVariant, result)));
        const auto report = QJsonDocument::fromJson(result.toString().toUtf8()).object();
        QCOMPARE(report.value("unknown").toObject().value("text").toString(), QString("等待检测"));
        QCOMPARE(report.value("unknown").toObject().value("enabled").toBool(), false);
        QCOMPARE(report.value("unknown").toObject().value("primary").toBool(), false);
        QCOMPARE(report.value("missing").toObject().value("text").toString(), QString("安装"));
        QCOMPARE(report.value("missing").toObject().value("enabled").toBool(), true);
        QCOMPARE(report.value("missing").toObject().value("primary").toBool(), true);
        QCOMPARE(report.value("installed").toObject().value("text").toString(), QString("打开"));
        QCOMPARE(report.value("installed").toObject().value("enabled").toBool(), true);
        QCOMPARE(report.value("installed").toObject().value("primary").toBool(), false);
        QCOMPARE(report.value("openclaw").toObject().value("text").toString(), QString("配置"));
        QCOMPARE(report.value("openclaw").toObject().value("enabled").toBool(), true);
    }

    void existingModelEditsSurviveSerialization() {
        QFile file(QStringLiteral(ORBIS_MAIN_QML));
        QVERIFY(file.open(QIODevice::ReadOnly));
        const QString source = QString::fromUtf8(file.readAll());
        const int start = source.indexOf("    function updateProviderModel(");
        const int end = source.indexOf("    function addProviderModel(", start);
        QVERIFY(start >= 0 && end > start);
        const QString update = source.mid(start, end - start);
        // Use the actual initialization expression and edit function from Main.qml.
        const QString marker = "window.providerModels = ";
        const int initStart = source.indexOf(marker, source.indexOf("function loadProviderFields(")) + marker.size();
        const QString initialize = source.mid(initStart, source.indexOf('\n', initStart) - initStart).trimmed();
        QQmlEngine engine;
        QQmlComponent component(&engine);
        const QString qml = QStringLiteral(R"(
import QtQuick
Item {
    id: window
    property var draft
    property var providerDraft: ({kind: "dsh"})
    property var providerModels: []
    property bool explicitProviderModels: false
    property bool providerFormDirty: false
    property var providerModel: ({text: "existing"})
    function initialize() { window.providerModels = %1 }
    %2
    function editDisabled() { updateProviderModel(0, "reasoningEfforts", false) }
    function editCustom() { updateProviderModel(0, "reasoningEfforts", {off: null, high: "high"}) }
    function editInherited() { updateProviderModel(0, "reasoningEfforts", undefined) }
    function editName() { updateProviderModel(0, "name", "Edited") }
    function serialize() { return JSON.stringify({fields: {models: providerModels}}) }
}
)").arg(initialize, update);
        component.setData(qml.toUtf8(), QUrl());
        QVERIFY2(component.isReady(), qPrintable(component.errorString()));
        // HostController emits QVariantMap/QVariantList; this is not a JS literal.
        const QVariantMap model{{"id", "existing"}, {"reasoningEfforts", false}, {"future", "preserved"}};
        const QVariantMap draft{{"fields", QVariantMap{{"models", QVariantList{model}}}}};
        std::unique_ptr<QObject> view(component.createWithInitialProperties({{"draft", draft}}));
        QVERIFY2(view != nullptr, qPrintable(component.errorString()));
        QVERIFY(QMetaObject::invokeMethod(view.get(), "initialize"));
        auto serialized = [&]() {
            QVariant result;
            QMetaObject::invokeMethod(view.get(), "serialize", Q_RETURN_ARG(QVariant, result));
            return QJsonDocument::fromJson(result.toString().toUtf8()).object().value("fields").toObject().value("models").toArray().first().toObject();
        };
        QVERIFY(QMetaObject::invokeMethod(view.get(), "editCustom"));
        QCOMPARE(serialized().value("reasoningEfforts").toObject().value("high").toString(), QString("high"));
        QVERIFY(QMetaObject::invokeMethod(view.get(), "editDisabled"));
        QCOMPARE(serialized().value("reasoningEfforts"), QJsonValue(false));
        QVERIFY(QMetaObject::invokeMethod(view.get(), "editInherited"));
        QVERIFY(!serialized().contains("reasoningEfforts"));
        QVERIFY(QMetaObject::invokeMethod(view.get(), "editName"));
        QCOMPARE(serialized().value("name").toString(), QString("Edited"));
        QCOMPARE(serialized().value("future").toString(), QString("preserved"));
    }
};
QTEST_MAIN(ProviderModelTest)
#include "ProviderModelTest.moc"
