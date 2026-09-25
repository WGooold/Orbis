import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Orbis.Host

ApplicationWindow {
    id: window
    visible: true
    width: 1180; height: 820
    minimumWidth: 1020; minimumHeight: 700
    title: "Orbis Host"
    color: "#E6EBF4"
    font.family: "Microsoft YaHei UI"
    font.pixelSize: 14
    property int page: 0
    property var pageNames: ["概览", "设备", "Agent", "设置", "诊断"]
    property string revokeId: ""
    property string installKind: ""
    property var installAgentData: ({})
    property string batchInstallAction: "update"
    property bool agentVersionsChecked: false
    readonly property bool canInstallAgents: host.state === "stopped" || host.state === "error"
    function agentName(kind) { return ({pi:"Pi", codex:"Codex", dsh:"DeepSeek Harness"})[kind] || kind }
    function installationStage() { return ({queued:"准备安装", resolving:"检查安装位置", downloading:"下载与安装依赖", verifying:"验证 CLI 和版本", activating:"保存新版本", cancelling:"正在取消并清理", cancelled:"已取消", error:"安装失败", done:"安装完成"})[host.agentInstallStage] || "" }
    function showAgentInstaller(agent) { installKind = agent.kind; installAgentData = agent; installVersion.text = agent.recommendedVersion || agent.latestVersion || "latest"; installLocation.currentIndex = agent.installationSource === "npm" ? 0 : 1; installDialog.open() }
    function showAgentHistory(agent) { installKind = agent.kind; installAgentData = agent; installationHistory.open() }
    function showAgentBatch(action) { batchInstallAction = action; batchInstallDialog.open() }
    function closeAgentDialogs() { installDialog.close(); installationHistory.close(); batchInstallDialog.close() }
    property bool providersOpen: false
    property var providerDraft: ({})
    property var piModels: []
    property var codexModels: []
    property string providerFormError: ""
    property bool providerTargetAdvanced: false
    property string deleteProviderId: ""
    property string removeProviderId: ""
    property string usageProviderId: ""
    property var fetchedModels: []
    property var oauthAccounts: []
    property var oauthPending: ({})
    property var routingDraft: ({})
    property var routingQueue: []
    property var providerRoutingDraft: ({})
    function routingName(id) { var match = host.providers.filter(function(p) { return p.id === id }); return match.length ? match[0].name : id }
    function moveRoute(index, offset) { var next = routingQueue.slice(); var target = index + offset; if (target < 0 || target >= next.length) return; var value = next.splice(index, 1)[0]; next.splice(target, 0, value); routingQueue = next }
    function proxyHealth(id) { var entries = host.proxyStatus.health || []; var match = entries.filter(function(p) { return p.id === id }); return match.length ? ({closed:"正常",open:"已熔断",half_open:"恢复探测"})[match[0].state] + (match[0].lastError ? " · " + match[0].lastError : "") : "尚无请求" }
    function accountOptions(accounts) { return [{id:"",label:"使用本机 CLI 登录"},{id:"$default",label:"使用默认托管账号"}].concat(accounts.map(function(a) { return {id:a.id,label:(a.email || a.workspace) + (a.isDefault ? "（默认）" : "")} })) }
    function usageText(usage) {
        if (!usage) return ""
        var parts = (usage.data || []).map(function(row) { return (row.planName ? row.planName + " · " : "") + (row.remaining === undefined ? (row.invalidMessage || "") : "剩余 " + Number(row.remaining).toLocaleString() + " " + (row.unit || "")) })
        if (usage.error) parts.push(usage.error + (parts.length ? "（保留上次结果）" : ""))
        return parts.join("\n")
    }
    function updatePiModel(index, key, value) { if (index >= 0 && index < piModels.length) piModels[index][key] = value }
    function addPiModel() { piModels = piModels.concat([{id: "", name: "", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192}]) }
    function deletePiModel(index) { var next = piModels.slice(); next.splice(index, 1); piModels = next }
    function updateCodexModel(index, key, value) { if (index >= 0 && index < codexModels.length) codexModels[index][key] = value }
    function deleteCodexModel(index) { var next = codexModels.slice(); next.splice(index, 1); codexModels = next }
    function loadProviderFields(draft) {
        providerKey.text = draft.fields.providerKey
        providerUrl.text = draft.fields.baseUrl; providerApiKey.text = draft.fields.apiKey; providerModel.text = draft.fields.model
        if (providerApi.find(draft.fields.api) < 0) providerApi.model = providerApi.model.concat([draft.fields.api])
        providerApi.currentIndex = Math.max(0, providerApi.find(draft.fields.api))
        piHeaders.text = JSON.stringify(draft.fields.headers || {}, null, 2)
        piCompat.text = JSON.stringify(draft.fields.compat || {}, null, 2)
        window.piModels = window.providerDraft.kind === "pi" ? draft.fields.models : []
        window.codexModels = draft.fields.catalog || []
        codexReasoning.currentIndex = Math.max(0, codexReasoning.find(draft.fields.reasoningEffort || ""))
        providerJson.text = JSON.stringify(draft.config, null, 2)
        var routing = draft.fields.routing || {}
        window.providerRoutingDraft = routing
        providerProxyDetails.checked = false
        providerFullUrl.checked = routing.isFullUrl === true
        providerCache.currentIndex = Math.max(0, providerCache.indexOfValue(routing.promptCacheRouting || "auto"))
        var reasoning = routing.codexChatReasoning || {}
        providerReasoningAuto.checked = Object.keys(reasoning).length === 0
        providerThinking.checked = reasoning.supportsThinking === true
        providerEffort.checked = reasoning.supportsEffort === true
        providerThinkingParam.currentIndex = Math.max(0, providerThinkingParam.find(reasoning.thinkingParam || "thinking"))
        providerEffortParam.currentIndex = Math.max(0, providerEffortParam.find(reasoning.effortParam || "reasoning_effort"))
        providerEffortMode.currentIndex = Math.max(0, providerEffortMode.find(reasoning.effortValueMode || "passthrough"))
        providerChatOptions.text = JSON.stringify(routing.chatOptions || {}, null, 2)
        providerRequestOverrides.text = JSON.stringify(routing.requestOverrides || {}, null, 2)
    }
    function buildProviderDraft(basic) {
        var draft = {kind: window.providerDraft.kind, id: window.providerDraft.kind === "pi" ? providerKey.text.trim() : window.providerDraft.id, name: providerName.text, config: providerJson.text, create: !!window.providerDraft.create, addToLive: providerAddToLive.checked,
            metadata: {category: providerCategory.text, notes: providerNotes.text, websiteUrl: providerWebsite.text, icon: providerIcon.text, sortIndex: Number(providerOrder.text || "0"), commonConfigEnabled: providerCommon.checked}}
        if (draft.kind === "codex") draft.metadata.authBinding = providerAccount.currentValue ? {source:"managed_account",authProvider:"codex_oauth",accountId:providerAccount.currentValue === "$default" ? "" : providerAccount.currentValue} : null
        if (basic) {
            draft.fields = {providerKey: providerKey.text.trim(), baseUrl: providerUrl.text.trim(), apiKey: providerApiKey.text, model: providerModel.text.trim(), api: providerApi.currentText}
            if (draft.kind === "codex") { draft.fields.catalog = window.codexModels; draft.fields.reasoningEffort = codexReasoning.currentText }
            if (draft.kind === "pi" || draft.kind === "codex") {
                try {
                    draft.fields.headers = JSON.parse(piHeaders.text || "{}")
                    if (draft.kind === "pi") draft.fields.compat = JSON.parse(piCompat.text || "{}")
                } catch (error) { window.providerFormError = "请求头和兼容参数必须是有效的 JSON 对象"; return null }
                if (draft.fields.headers === null || Array.isArray(draft.fields.headers) || typeof draft.fields.headers !== "object") { window.providerFormError = "请求头必须是 JSON 对象"; return null }
                if (draft.kind === "pi") {
                    if (draft.fields.compat === null || Array.isArray(draft.fields.compat) || typeof draft.fields.compat !== "object") { window.providerFormError = "兼容参数必须是 JSON 对象"; return null }
                    draft.fields.models = window.piModels
                }
            }
            if (draft.kind === "codex") {
                var routing = JSON.parse(JSON.stringify(window.providerRoutingDraft))
                routing.isFullUrl = providerFullUrl.checked
                routing.promptCacheRouting = providerCache.currentValue
                var reasoning = routing.codexChatReasoning || {}
                reasoning.supportsThinking = providerThinking.checked; reasoning.supportsEffort = providerEffort.checked
                reasoning.thinkingParam = providerThinkingParam.currentText; reasoning.effortParam = providerEffortParam.currentText; reasoning.effortValueMode = providerEffortMode.currentText
                routing.codexChatReasoning = providerReasoningAuto.checked ? {} : reasoning
                try { routing.chatOptions = JSON.parse(providerChatOptions.text || "{}"); routing.requestOverrides = JSON.parse(providerRequestOverrides.text || "{}") }
                catch (error) { window.providerFormError = "兼容参数和请求覆盖必须是有效的 JSON 对象"; return null }
                draft.fields.routing = routing
            }
        }
        window.providerFormError = ""
        return draft
    }
    onVisibleChanged: if (visible) host.refreshRegistrationPolicy()
    function selectPage(index) { page = index; if (index === 3) settingsPane.load(); if (index === 2 && host.bridgeReady && !host.busy && !agentVersionsChecked) { agentVersionsChecked = true; host.detectAgents(true) } }
    function openProviders(kind) { page = 2; providersOpen = true; host.loadProviders(kind) }
    function closeProviderEditor() { providerDialog.close() }
    function saveProviderEditor() { var draft = buildProviderDraft(!advancedProvider.checked); if (draft !== null) host.saveProvider(draft) }
    function stateText() {
        return ({connected: "已连接", connecting: "正在连接", reconnecting: "正在重连", closed: "连接已断开", stopped: "已暂停", error: "需要处理"})[host.state] || "正在准备"
    }
    onClosing: function(close) { if (trayAvailable) { close.accepted = false; window.hide() } }

    component Field: TextField {
        implicitHeight: 46
        leftPadding: 14; rightPadding: 14
        selectByMouse: true
        color: "#21314d"
        placeholderTextColor: "#98a4b8"
        background: NeuSurface { margin: 0; cornerRadius: 10; inset: true; surface: "#DDE3EF"; focused: parent.activeFocus }
    }
    component Heading: Label { font.pixelSize: 20; font.weight: Font.DemiBold; color: "#172a49" }
    component Hint: Label { color: "#73819a"; wrapMode: Text.WordWrap; lineHeight: 1.4; font.pixelSize: 13 }
    component SoftSwitch: Switch {
        id: softSwitch
        spacing: 14
        indicator: Item {
            implicitWidth: 56; implicitHeight: 32
            x: softSwitch.leftPadding
            y: (softSwitch.height - height) / 2
            NeuSurface { anchors.fill: parent; margin: 0; cornerRadius: 16; inset: true; surface: "#DDE3EF"; focused: softSwitch.activeFocus }
            NeuSurface { width: 34; height: 34; margin: 6; cornerRadius: 11; x: softSwitch.checked ? 26 : -4; y: -1; Rectangle { anchors.centerIn: parent; width: 6; height: 6; radius: 3; color: softSwitch.checked ? "#2459D3" : "#a6b2c6" } }
        }
        contentItem: Label { text: softSwitch.text; leftPadding: softSwitch.indicator.width + softSwitch.spacing; verticalAlignment: Text.AlignVCenter; color: "#40516c" }
    }

    RowLayout {
        anchors.fill: parent
        spacing: 0
        Rectangle {
            Layout.preferredWidth: 220; Layout.fillHeight: true
            color: "#E6EBF4"
            ColumnLayout {
                anchors.fill: parent; anchors.margins: 20; spacing: 10
                RowLayout {
                    Layout.topMargin: 18; Layout.bottomMargin: 3; spacing: 10
                    Image { source: "qrc:/src/assets/orbis.png"; Layout.preferredWidth: 40; Layout.preferredHeight: 40; smooth: true }
                    Label { text: "Orbis"; color: "#232A36"; font.pixelSize: 29; font.weight: Font.DemiBold; font.family: "Segoe UI" }
                }
                Label { text: "Easy Agents Everywhere"; color: "#8298ba"; font.pixelSize: 11; Layout.leftMargin: 4; Layout.bottomMargin: 36 }
                Repeater {
                    model: window.pageNames
                    delegate: Button {
                        required property string modelData
                        required property int index
                        Layout.fillWidth: true; implicitHeight: 48
                        onClicked: window.selectPage(index)
                        contentItem: RowLayout {
                            spacing: 15
                            Label { text: ["◈", "▣", "⌘", "⚙", "≡"][index]; color: window.page === index ? "#2459D3" : "#627591"; font.family: "Segoe UI Symbol"; font.pixelSize: 20; Layout.leftMargin: 13; Layout.preferredWidth: 22 }
                            Label { text: modelData; color: window.page === index ? "#2459D3" : "#50617b"; font.weight: window.page === index ? Font.DemiBold : Font.Normal; Layout.fillWidth: true }
                        }
                        background: NeuSurface { anchors.fill: parent; anchors.margins: -12; margin: 12; cornerRadius: 11; inset: window.page === index || parent.down; visible: window.page === index || parent.hovered || parent.activeFocus; focused: parent.activeFocus }
                    }
                }
                Item { Layout.fillHeight: true }
                Rectangle { Layout.fillWidth: true; height: 1; color: "#cbd4e3" }
                RowLayout {
                    Layout.topMargin: 14; spacing: 9
                    Rectangle { width: 7; height: 7; radius: 4; color: host.state === "connected" ? "#6dd7b5" : "#97a7bf" }
                    Label { text: stateText(); color: "#627591"; font.pixelSize: 12 }
                }
                Label { text: "Windows · v" + host.version; color: "#6f85a6"; font.pixelSize: 11; Layout.bottomMargin: 10 }
            }
        }
        ColumnLayout {
            Layout.fillWidth: true; Layout.fillHeight: true; spacing: 0
            Rectangle {
                Layout.fillWidth: true; height: 100; color: "#E6EBF4"
                RowLayout {
                    anchors.fill: parent; anchors.leftMargin: 36; anchors.rightMargin: 36
                    ColumnLayout {
                        spacing: 7
                        Label { text: window.pageNames[window.page]; font.pixelSize: 27; font.weight: Font.DemiBold; color: "#172a49" }
                        Hint { text: ["让电脑上的 Agent，随时与你连接。", "管理这台电脑信任的手机。", "连接你正在使用的 coding agent。", "按照你的工作习惯设置 Orbis。", "了解连接状态，快速定位问题。"][window.page] }
                    }
                    Item { Layout.fillWidth: true }
                    Rectangle {
                        implicitWidth: statusLabel.implicitWidth + 30; implicitHeight: 32; radius: 16
                        color: host.state === "connected" ? "#e1f4ee" : "#e7ecf4"
                        Label { id: statusLabel; anchors.centerIn: parent; text: stateText(); color: host.state === "connected" ? "#278868" : "#677992"; font.pixelSize: 12 }
                    }
                }
            }
            Rectangle {
                visible: host.message.length > 0
                Layout.fillWidth: true; Layout.leftMargin: 36; Layout.rightMargin: 36; Layout.bottomMargin: 16
                implicitHeight: messageLabel.implicitHeight + 24; radius: 10; color: "#e8effd"
                RowLayout {
                    anchors.fill: parent; anchors.margins: 12
                    Label { id: messageLabel; text: host.message; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: "#365485"; font.pixelSize: 13 }
                    ToolButton { text: "×"; onClicked: host.clearMessage(); implicitWidth: 30; implicitHeight: 28; Accessible.name: "关闭提示" }
                }
            }
            ScrollView {
                id: scroll
                Layout.fillWidth: true; Layout.fillHeight: true
                clip: true
                ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
                contentWidth: availableWidth
                ColumnLayout {
                    width: scroll.availableWidth - 72
                    x: 36; spacing: 20
                    Item { Layout.preferredHeight: 10 }

                    ColumnLayout {
                        visible: window.page === 0
                        Layout.fillWidth: true; spacing: 20
                        Card {
                            Layout.fillWidth: true
                            RowLayout {
                                anchors.fill: parent; spacing: 20
                                ColumnLayout {
                                    Layout.fillWidth: true; spacing: 9
                                    Hint { text: "这台电脑" }
                                    Heading { text: host.hostName || "正在准备你的 Host" }
                                    Hint { text: host.activated ? (host.email ? "已通过 " + host.email + " 激活" : "这台电脑已激活") : (host.verificationRequired ? "使用 QQ 邮箱激活，开始连接你的手机。" : "激活这台电脑，开始连接你的手机。") }
                                }
                                ActionButton { visible: host.activated; text: host.state === "connected" || host.state === "connecting" || host.state === "reconnecting" ? "暂停连接" : "开始连接"; enabled: !host.busy; onClicked: { if (host.state === "connected" || host.state === "connecting" || host.state === "reconnecting") host.stopHost(); else host.startHost() } }
                                ActionButton { visible: host.activated; text: "＋ 添加手机"; primary: true; enabled: host.state === "connected" && !host.busy; onClicked: host.pair() }
                            }
                        }
                        Card {
                            Layout.fillWidth: true
                            ColumnLayout {
                                anchors.fill: parent; spacing: 13
                                Heading { text: "打开 AI 工作台" }
                                Hint { text: "打开 Pi、Codex 或 DeepSeek Harness，直接开始对话。"; Layout.fillWidth: true }
                                RowLayout {
                                    Layout.fillWidth: true; spacing: 16
                                    ActionButton {
                                        objectName: "overviewOpenPiTui"
                                        text: "打开 Pi"; primary: true
                                        enabled: host.bridgeReady && !host.busy && host.agents.some(a => a.kind === "pi" && a.installed)
                                        Accessible.name: "打开 Pi 终端界面"
                                        onClicked: host.openAgentTui("pi")
                                    }
                                    ActionButton {
                                        objectName: "overviewOpenCodexTui"
                                        text: "打开 Codex"
                                        enabled: host.bridgeReady && !host.busy && host.agents.some(a => a.kind === "codex" && a.installed)
                                        Accessible.name: "打开 Codex 终端界面"
                                        onClicked: host.openAgentTui("codex")
                                    }
                                    ActionButton {
                                        objectName: "overviewOpenDsh"
                                        text: "打开 DeepSeek Harness"
                                        enabled: host.bridgeReady && !host.busy && host.agents.some(a => a.kind === "dsh" && a.installed)
                                        Accessible.name: "打开 DeepSeek Harness 网页工作台"
                                        onClicked: host.openAgent("dsh")
                                    }
                                    Item { Layout.fillWidth: true }
                                }
                                Hint { text: "默认打开在你的用户目录。按钮不可用时，请到 Agent 页检测或安装；模型登录也可在那里完成。"; Layout.fillWidth: true; font.pixelSize: 11 }
                                RowLayout {
                                    visible: !host.dshEnabled && host.agents.some(a => a.kind === "dsh" && a.installed)
                                    Layout.fillWidth: true; spacing: 16
                                    Hint { text: "手机端 DeepSeek 尚未启用，请在设置中开启接入后重新连接 Host。"; Layout.fillWidth: true }
                                    ActionButton { text: "前往设置"; onClicked: window.selectPage(3) }
                                }
                            }
                        }
                        RowLayout {
                            visible: !host.activated
                            Layout.fillWidth: true; spacing: 20
                            Card {
                                Layout.fillWidth: true; Layout.preferredWidth: 510
                                ColumnLayout {
                                    anchors.fill: parent; spacing: 15
                                    Heading { text: "连接，从这里开始" }
                                    Hint { text: host.verificationRequired ? "通过 QQ 邮箱验证码激活这台电脑。" : "当前服务器允许直接激活，无需邮箱验证码。"; Layout.fillWidth: true; Layout.bottomMargin: 9 }
                                    Label { visible: host.verificationRequired; text: "QQ 邮箱"; color: "#40516c"; font.pixelSize: 13 }
                                    Field { id: emailField; visible: host.verificationRequired; objectName: "registrationEmail"; placeholderText: "你的邮箱@qq.com"; Layout.fillWidth: true; inputMethodHints: Qt.ImhEmailCharactersOnly; enabled: !host.busy; Accessible.name: "QQ 邮箱" }
                                    Label { visible: host.verificationRequired; text: "邮箱验证码"; color: "#40516c"; font.pixelSize: 13 }
                                    RowLayout {
                                        visible: host.verificationRequired; Layout.fillWidth: true; spacing: 10
                                        Field { id: codeField; objectName: "verificationCode"; placeholderText: "6 位验证码"; Layout.fillWidth: true; maximumLength: 6; validator: RegularExpressionValidator { regularExpression: /[0-9]{0,6}/ } Accessible.name: "验证码" }
                                        ActionButton { text: host.cooldown > 0 ? host.cooldown + " 秒后重发" : "获取验证码"; enabled: host.bridgeReady && host.registrationAvailable && !host.busy && host.cooldown === 0; onClicked: host.requestCode(emailField.text) }
                                    }
                                    ActionButton { text: host.busy ? "正在处理…" : host.verificationRequired ? "注册并激活" : "直接激活"; primary: true; Layout.fillWidth: true; Layout.topMargin: 7; enabled: host.bridgeReady && host.registrationAvailable && !host.busy; onClicked: { if (host.verificationRequired) host.activate(emailField.text, codeField.text); else host.activateWithoutEmail() } }
                                    Hint { visible: host.verificationRequired; text: host.registrationAvailable ? "只验证邮箱所有权，无需提供 QQ 密码。" : "邮箱注册暂未开放，请等待邮件服务配置完成。"; Layout.fillWidth: true }
                                }
                            }
                            Card {
                                Layout.preferredWidth: 270; Layout.fillHeight: true
                                ColumnLayout {
                                    anchors.fill: parent; spacing: 17
                                    Label { text: "三步，随处开始"; font.pixelSize: 18; font.weight: Font.DemiBold; color: "#223757"; Layout.bottomMargin: 6 }
                                    Repeater {
                                        model: [{n: "01", title: "激活这台电脑", detail: host.verificationRequired ? "用 QQ 邮箱验证并注册。" : "按当前服务器设置直接激活。"}, {n: "02", title: "接入你的 Agent", detail: "复用本机已有的 Agent 安装。"}, {n: "03", title: "手机扫码连接", detail: "在 Orbis Android 中扫码配对。"}]
                                        delegate: ColumnLayout {
                                            required property var modelData
                                            Layout.fillWidth: true; spacing: 6
                                            Label { text: modelData.n + "   " + modelData.title; color: "#345cdb"; font.weight: Font.DemiBold; font.pixelSize: 14 }
                                            Hint { text: modelData.detail; Layout.fillWidth: true }
                                        }
                                    }
                                    Item { Layout.fillHeight: true; Layout.minimumHeight: 18 }
                                    Hint { text: "配对后端到端加密，手机与电脑安全连接。"; Layout.fillWidth: true }
                                }
                            }
                        }
                        RowLayout {
                            Layout.fillWidth: true; spacing: 16
                            Repeater {
                                model: [{label: "已配对设备", value: String(host.devices.length), detail: "每台设备均可独立撤销"}, {label: "在线会话", value: String(host.runtimeCount), detail: "由这台电脑上的 Host 提供"}, {label: "Agent 接入", value: String(host.agents.filter(a => a.installed).length), detail: "Pi / Codex / DeepSeek"}]
                                delegate: Card {
                                    required property var modelData
                                    Layout.fillWidth: true; Layout.preferredWidth: 1
                                    ColumnLayout {
                                        anchors.fill: parent; spacing: 10
                                        Hint { text: modelData.label }
                                        Label { text: modelData.value; color: "#203857"; font.pixelSize: 33; font.weight: Font.DemiBold }
                                        Hint { text: modelData.detail; Layout.fillWidth: true; font.pixelSize: 11 }
                                    }
                                }
                            }
                        }
                        Hint { text: "关闭窗口后，Orbis 会继续在系统托盘中运行。电脑需保持开机，才能从手机操作 Agent。"; Layout.fillWidth: true }
                    }

                    ColumnLayout {
                        visible: window.page === 1; Layout.fillWidth: true; spacing: 16
                        RowLayout { Layout.fillWidth: true; Heading { text: "已配对设备" } Item { Layout.fillWidth: true } ActionButton { text: "＋ 添加手机"; primary: true; enabled: host.state === "connected" && !host.busy; onClicked: host.pair() } }
                        Card {
                            visible: host.devices.length === 0; Layout.fillWidth: true
                            ColumnLayout { anchors.fill: parent; spacing: 16; Heading { text: "还没有连接的手机" } Hint { text: "激活并启动 Host 后，点击“添加手机”，使用 Orbis Android 扫描二维码。"; Layout.fillWidth: true } }
                        }
                        Repeater {
                            model: host.devices
                            delegate: Card {
                                required property var modelData
                                Layout.fillWidth: true
                                RowLayout {
                                    anchors.fill: parent; spacing: 20
                                    ColumnLayout {
                                        Layout.fillWidth: true; spacing: 8
                                        Heading { text: modelData.label || "手机 · " + modelData.deviceId.slice(0, 8); font.pixelSize: 17 }
                                        Hint { text: "连接方式：" + (({lan: "局域网直连", p2p: "P2P 直连", relay: "中继", offline: "离线"})[modelData.path || "offline"]) }
                                        Hint { text: modelData.lastSeen ? "最近连接：" + new Date(modelData.lastSeen).toLocaleString(Qt.locale(), "MM-dd hh:mm") : "配对时间：" + new Date(modelData.createdAt * 1000).toLocaleDateString(); font.pixelSize: 12 }
                                    }
                                    ActionButton { text: "重命名"; enabled: host.bridgeReady && !host.busy; onClicked: { window.revokeId = modelData.deviceId; deviceNameField.text = modelData.label || ""; renameDialog.open() } }
                                    ActionButton { text: "撤销配对"; danger: true; enabled: host.bridgeReady && !host.busy; onClicked: { window.revokeId = modelData.deviceId; revokeDialog.open() } }
                                }
                            }
                        }
                    }

                    ColumnLayout {
                        visible: window.page === 2 && !window.providersOpen; Layout.fillWidth: true; spacing: 16
                        RowLayout { Layout.fillWidth: true; Heading { text: "你的 Agent" } Item { Layout.fillWidth: true } ActionButton { text: "检查更新"; enabled: host.bridgeReady && !host.busy; onClicked: host.detectAgents(true) } }
                        RowLayout { Layout.fillWidth: true
                            ActionButton { text: "全部更新（" + host.agents.filter(a => a.updateAvailable).length + "）"; enabled: host.bridgeReady && !host.busy && host.agents.some(a => a.updateAvailable); onClicked: window.showAgentBatch("update") }
                            ActionButton { text: "安装缺失的 Agent"; enabled: host.bridgeReady && !host.busy && host.agents.some(a => !a.installed); onClicked: window.showAgentBatch("install") }
                            Item { Layout.fillWidth: true }
                        }
                        RowLayout { visible: host.agentInstalling; Layout.fillWidth: true
                            BusyIndicator { running: visible; Layout.preferredWidth: 30; Layout.preferredHeight: 30 }
                            Hint { text: window.agentName(host.agentInstallKind) + " · " + window.installationStage() + " · " + host.agentInstallVersion; Layout.fillWidth: true }
                            ActionButton { text: "取消安装"; enabled: host.bridgeReady && host.agentInstallStage !== "cancelling"; danger: true; onClicked: host.cancelInstall() }
                        }
                        Repeater {
                            model: host.agents
                            delegate: Card {
                                required property var modelData
                                Layout.fillWidth: true
                                ColumnLayout {
                                    anchors.fill: parent; spacing: 15
                                    RowLayout {
                                        Layout.fillWidth: true
                                        Heading { text: modelData.kind === "pi" ? "Pi" : modelData.kind === "dsh" ? "DeepSeek Harness" : "Codex" }
                                        Item { Layout.fillWidth: true }
                                        Hint { text: modelData.installed ? "可用" : modelData.installedButBroken ? "已安装 · 需要修复" : "尚未安装"; color: modelData.installed ? "#278868" : "#8b7790" }
                                    }
                                    Hint { text: "当前 " + (modelData.version || "—") + " · 最新 " + (modelData.latestVersion || "未知") + (modelData.updateAvailable ? " · 有可用更新" : ""); Layout.fillWidth: true; color: modelData.updateAvailable ? "#b46b19" : "#60728e" }
                                    Hint { visible: !!modelData.entry; text: "来源：" + (({managed:"Orbis 独立安装", npm:"npm", custom:"自定义 / 其他包管理器", unknown:"未知"})[modelData.installationSource] || "未知"); Layout.fillWidth: true }
                                    Hint { visible: !!modelData.error || !!modelData.latestError; text: modelData.error || modelData.latestError || ""; Layout.fillWidth: true; color: "#b46b19" }
                                    Hint { visible: !!modelData.compatibilityNote; text: modelData.compatibilityNote || ""; Layout.fillWidth: true }
                                    Hint { visible: !!modelData.path; text: modelData.path || ""; Layout.fillWidth: true; font.pixelSize: 12; elide: Text.ElideMiddle; maximumLineCount: 2 }
                                    RowLayout {
                                        spacing: 10
                                        ActionButton { text: modelData.kind === "pi" ? "打开 Pi 并接入" : modelData.kind === "dsh" ? "打开 DeepSeek Harness" : "打开 Codex 登录"; primary: true; visible: modelData.installed; enabled: !host.busy; onClicked: host.openAgent(modelData.kind) }
                                        ActionButton { text: modelData.installedButBroken ? "重新安装修复" : modelData.installed ? (modelData.updateAvailable ? "下载更新" : "安装版本") : "安装 Agent"; enabled: !host.busy; onClicked: window.showAgentInstaller(modelData) }
                                        ActionButton { text: "供应商配置"; enabled: host.bridgeReady && !host.busy; onClicked: window.openProviders(modelData.kind) }
                                        ActionButton { text: "安装记录"; enabled: !host.busy; onClicked: window.showAgentHistory(modelData) }
                                    }
                                    Hint { visible: (modelData.copies || []).length > 1; text: "检测到多处安装，Host 当前使用上方路径。可在安装记录中查看其他副本。"; Layout.fillWidth: true; color: "#b46b19" }
                                }
                            }
                        }
                        Hint { text: "在供应商配置中添加 API 地址、密钥与模型，并在 Host 或 APP 启用。原生账号登录仍可从 Agent 终端完成。安装更新前请先暂停 Host。"; Layout.fillWidth: true }
                        Hint { visible: host.busy && !host.agentInstalling; text: "正在检测 Agent，请稍候…"; Layout.fillWidth: true }
                    }

                    ColumnLayout {
                        visible: window.page === 2 && window.providersOpen; Layout.fillWidth: true; spacing: 16
                        RowLayout {
                            Layout.fillWidth: true
                            ActionButton { text: "‹ Agent"; onClicked: window.providersOpen = false }
                            Heading { text: ({pi: "Pi", codex: "Codex", dsh: "DeepSeek Harness"})[host.providerKind] + " · 供应商" }
                            Item { Layout.fillWidth: true }
                            ActionButton { text: "刷新 / 导入"; enabled: !host.busy; onClicked: host.loadProviders(host.providerKind) }
                            ActionButton { text: "通用配置"; visible: host.providerKind === "codex"; enabled: !host.busy; onClicked: host.loadCodexPreferences() }
                            ActionButton { text: "账号管理"; visible: host.providerKind === "codex"; enabled: !host.busy; onClicked: { host.clearMessage(); host.oauthAccount("list"); oauthDialog.open() } }
                            ActionButton { text: "从预设添加"; visible: host.providerKind !== "dsh"; enabled: !host.busy; onClicked: presetDialog.open() }
                            ActionButton { text: "＋ 添加供应商"; primary: true; enabled: !host.busy; onClicked: host.editProvider("") }
                        }
                        Hint { Layout.fillWidth: true; text: host.providerKind === "pi" ? "Pi 可同时启用多个供应商。刷新会同步 models.json 中的显式配置；停用保留卡片，不更改原生登录与默认模型。" : "启用时先保存当前配置，再写入目标配置。Host 中的后台 Agent 会重新加载；已有会话和独立终端需要重新打开。" }
                        RowLayout { visible: host.providerKind === "codex"; Layout.fillWidth: true
                            Label { Layout.fillWidth: true; wrapMode: Text.WordWrap; color: "#4b5d78"; text: host.proxyStatus.takeover ? "本地路由运行中 · " + host.proxyStatus.baseUrl + " · 请求 " + host.proxyStatus.totalRequests + " · 成功 " + host.proxyStatus.successfulRequests + " · 故障转移 " + host.proxyStatus.failoverCount : "本地路由未接管" }
                            ActionButton { text: "路由与故障转移"; enabled: !host.busy; onClicked: host.loadProxyStatus(true) }
                        }
                        Card {
                            visible: host.providers.length === 0; Layout.fillWidth: true
                            ColumnLayout { anchors.fill: parent; spacing: 12
                                Heading { text: "添加第一个供应商" }
                                Hint { text: "支持自定义兼容 API，以及高级原生配置。已有本机配置会自动导入。"; Layout.fillWidth: true }
                            }
                        }
                        Repeater {
                            model: host.providers
                            delegate: Card {
                                required property var modelData
                                Layout.fillWidth: true
                                ColumnLayout { anchors.fill: parent; spacing: 12
                                  RowLayout { Layout.fillWidth: true; spacing: 12
                                    ColumnLayout { Layout.fillWidth: true
                                        Heading { text: modelData.name; font.pixelSize: 18 }
                                        Hint { text: modelData.enabled ? (modelData.mode === "additive" ? "已启用" : "当前使用") : "未启用"; color: modelData.enabled ? "#278868" : "#73819a" }
                                        Hint { text: modelData.notes || ""; visible: text.length > 0; Layout.fillWidth: true }
                                        Hint { text: window.usageText(modelData.usage); visible: text.length > 0; Layout.fillWidth: true }
                                        Hint { visible: host.providerKind === "codex" && host.proxyStatus.takeover; text: window.proxyHealth(modelData.id); Layout.fillWidth: true }
                                    }
                                    ActionButton { text: modelData.enabled ? "移除" : "启用"; visible: !modelData.enabled || modelData.mode === "additive"; primary: !modelData.enabled; enabled: !host.busy; onClicked: { if (modelData.enabled) { window.removeProviderId = modelData.id; removeProviderDialog.open() } else host.switchProvider(modelData.id, true) } }
                                    ActionButton { text: "编辑"; enabled: !host.busy; onClicked: host.editProvider(modelData.id) }
                                    ActionButton { text: "复制"; enabled: !host.busy; onClicked: host.copyProvider(modelData.id) }
                                    ActionButton { text: "删除"; danger: true; enabled: !host.busy && (!modelData.enabled || modelData.mode === "additive"); onClicked: { window.deleteProviderId = modelData.id; deleteProviderDialog.open() } }
                                  }
                                  RowLayout { Layout.fillWidth: true; spacing: 10
                                    Hint { text: modelData.websiteUrl || modelData.id; Layout.fillWidth: true }
                                    ActionButton { text: "检测"; visible: modelData.category !== "official"; enabled: !host.busy; onClicked: host.checkProvider(modelData.id) }
                                    ToolButton { text: "↻"; visible: host.providerKind === "codex" && host.proxyStatus.takeover; enabled: !host.busy; onClicked: host.resetProxyHealth(modelData.id); ToolTip.visible: hovered; ToolTip.text: "重置熔断状态" }
                                    ActionButton { text: "用量设置"; enabled: !host.busy; onClicked: host.editProviderUsage(modelData.id) }
                                    ActionButton { text: "查询用量"; enabled: !host.busy; onClicked: host.queryProviderUsage(modelData.id) }
                                    ActionButton { text: "启用并打开"; enabled: !host.busy; onClicked: host.openProvider(modelData.id) }
                                  }
                                }
                            }
                        }
                        Hint { visible: host.busy; text: "正在处理供应商配置…"; Layout.fillWidth: true }
                    }

                    Card {
                        id: settingsPane
                        visible: window.page === 3; Layout.fillWidth: true
                        function load() { relayField.text = host.relayUrl; nameField.text = host.hostName; piPathField.text = host.piEntry; codexPathField.text = host.codexEntry; dshPathField.text = host.dshEntry; startupSwitch.checked = host.autoStart; codexSwitch.checked = host.codexEnabled; dshSwitch.checked = host.dshEnabled }
                        ColumnLayout {
                            anchors.fill: parent; spacing: 15
                            Heading { text: "常规" }
                            Label { text: "电脑名称"; color: "#4b5d78" }
                            Field { id: nameField; Layout.fillWidth: true; maximumLength: 80 }
                            SoftSwitch { id: startupSwitch; text: "登录 Windows 后自动启动" }
                            SoftSwitch { id: codexSwitch; text: "启动 Host 时启用 Codex" }
                            SoftSwitch { id: dshSwitch; text: "启动 Host 时启用 DeepSeek Harness" }
                            Heading { text: "中继服务器"; Layout.topMargin: 10 }
                            Field { id: relayField; Layout.fillWidth: true; placeholderText: "wss://服务器地址/relay" }
                            Hint { text: "支持默认中继或自建中继。更换服务器后需按新服务器设置重新激活，并为手机重新配对。"; Layout.fillWidth: true }
                            Heading { text: "Agent 路径"; Layout.topMargin: 10 }
                            Hint { text: "留空时自动检测。安装了多个版本时，可指定对应的 CLI JavaScript 入口文件。"; Layout.fillWidth: true }
                            Field { id: piPathField; Layout.fillWidth: true; placeholderText: "Pi：自动检测" }
                            Field { id: codexPathField; Layout.fillWidth: true; placeholderText: "Codex：自动检测" }
                            Field { id: dshPathField; Layout.fillWidth: true; placeholderText: "DeepSeek Harness：自动检测" }
                            ActionButton { text: "保存设置"; primary: true; enabled: host.bridgeReady && !host.busy; onClicked: host.saveSettings(relayField.text, startupSwitch.checked, codexSwitch.checked, piPathField.text, codexPathField.text, nameField.text, dshSwitch.checked, dshPathField.text) }
                            Hint { text: "修改设置前请先在概览中暂停连接。"; Layout.fillWidth: true }
                            Rectangle { Layout.fillWidth: true; height: 1; color: "#e5eaf2"; Layout.topMargin: 10 }
                            RowLayout { spacing: 10; ActionButton { text: "检查更新"; onClicked: host.checkUpdates() } ActionButton { text: "打开下载页"; onClicked: host.openDownloads() } Hint { text: "v" + host.version } }
                        }
                    }

                    ColumnLayout {
                        visible: window.page === 4; Layout.fillWidth: true; spacing: 16
                        Card {
                            Layout.fillWidth: true
                            ColumnLayout {
                                anchors.fill: parent; spacing: 16
                                Heading { text: "连接诊断" }
                                Hint { text: "检查中继是否可达，并重新检测本机 Agent。诊断导出会隐藏激活凭据、邮箱和用户目录。"; Layout.fillWidth: true }
                                RowLayout { spacing: 10; ActionButton { text: "运行检查"; primary: true; enabled: host.bridgeReady && !host.busy; onClicked: host.diagnose() } ActionButton { text: "复制诊断"; onClicked: host.copyDiagnostics() } ActionButton { text: "导出文件"; onClicked: host.exportDiagnostics() } ActionButton { text: "数据目录"; onClicked: host.openDataDirectory() } }
                            }
                        }
                        Card {
                            Layout.fillWidth: true
                            ColumnLayout {
                                anchors.fill: parent; spacing: 16
                                Heading { text: "本次运行日志" }
                                TextArea { text: host.logs || "暂无日志"; readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap; color: "#50617b"; font.family: "Consolas"; font.pixelSize: 12; Layout.fillWidth: true; background: Rectangle { radius: 8; color: "#f7f9fd" } padding: 15 }
                            }
                        }
                    }
                    Item { Layout.preferredHeight: 30 }
                }
            }
        }
    }
    Dialog {
        id: pairDialog
        title: "用手机扫描二维码"
        anchors.centerIn: parent
        width: 430
        modal: true
        background: NeuSurface { anchors.fill: parent; anchors.margins: -14; margin: 14; cornerRadius: 18 }
        footer: DialogButtonBox { ActionButton { text: "关闭"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } onRejected: pairDialog.reject() }
        onRejected: host.cancelPair()
        ColumnLayout {
            width: parent.width; spacing: 16
            Image { source: host.qr; Layout.preferredWidth: 300; Layout.preferredHeight: 300; Layout.alignment: Qt.AlignHCenter }
            Label { text: "二维码将在 " + host.pairSeconds + " 秒后失效"; Layout.alignment: Qt.AlignHCenter; color: "#60728e" }
            Hint { text: "在 Orbis Android 中选择“扫码配对”。二维码仅可使用一次。"; Layout.fillWidth: true }
        }
    }
    Dialog {
        id: revokeDialog; title: "撤销这台手机的配对？"; anchors.centerIn: parent; modal: true; width: 410
        background: NeuSurface { anchors.fill: parent; anchors.margins: -14; margin: 14; cornerRadius: 18 }
        footer: DialogButtonBox { ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } ActionButton { text: "撤销配对"; danger: true; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole } onAccepted: revokeDialog.accept(); onRejected: revokeDialog.reject() }
        Label { width: parent.width; text: "连接会立即失效。再次使用时，需要重新扫码配对。"; wrapMode: Text.WordWrap }
        onAccepted: host.revoke(window.revokeId)
    }
    Dialog {
        id: installDialog; title: "安装 / 更新 " + window.agentName(window.installKind); anchors.centerIn: parent; modal: true; width: 540
        background: NeuSurface { anchors.fill: parent; anchors.margins: -14; margin: 14; cornerRadius: 18 }
        footer: DialogButtonBox { ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } ActionButton { text: "开始安装"; enabled: window.canInstallAgents && !host.busy && (installLocation.currentIndex === 1 || window.installAgentData.installationSource === "npm"); primary: true; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole } onAccepted: installDialog.accept(); onRejected: installDialog.reject() }
        ColumnLayout { width: parent.width; spacing: 12
            Hint { text: "当前 " + (window.installAgentData.version || "未安装") + " · 最新 " + (window.installAgentData.latestVersion || "未知"); Layout.fillWidth: true }
            Hint { visible: !!window.installAgentData.compatibilityNote; text: window.installAgentData.compatibilityNote || ""; Layout.fillWidth: true }
            ComboBox { id: installLocation; model: ["更新当前 npm 安装", "Orbis 独立安装"]; Layout.fillWidth: true }
            Hint { text: installLocation.currentIndex === 0 ? "更新当前 npm 目录；终端中使用这份安装的 Agent 也会更新。请先关闭使用它的终端。" : "下载到独立目录，验证后设为 Host 使用的版本。旧版保留，可从安装记录切回。"; Layout.fillWidth: true }
            Hint { visible: installLocation.currentIndex === 0; text: window.installAgentData.entry || "没有可更新的 npm 安装，请选择独立安装。"; Layout.fillWidth: true }
            Hint { visible: !window.canInstallAgents; text: "请先在概览中暂停 Host，再开始安装。暂停会中断连接及运行中的会话。"; Layout.fillWidth: true; color: "#b46b19" }
            Field { id: installVersion; text: "latest"; placeholderText: "latest / 0.1.7-rc.1"; Layout.fillWidth: true }
        }
        onAccepted: host.installAgent(window.installKind, installVersion.text, installLocation.currentIndex === 0 ? "current" : "managed")
    }
    Dialog {
        id: batchInstallDialog; title: window.batchInstallAction === "update" ? "更新所有可更新的 Agent" : "安装缺失的 Agent"; anchors.centerIn: parent; modal: true; width: 540
        background: NeuSurface { anchors.fill: parent; anchors.margins: -14; margin: 14; cornerRadius: 18 }
        footer: DialogButtonBox { ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } ActionButton { text: "开始"; primary: true; enabled: window.canInstallAgents && !host.busy; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole } onAccepted: batchInstallDialog.accept(); onRejected: batchInstallDialog.reject() }
        ColumnLayout { width: parent.width; spacing: 12
            Hint { text: "逐个安装并验证，一个失败后会继续其余项目。npm 安装更新到原目录；独立安装保留旧版本。"; Layout.fillWidth: true }
            Repeater { model: host.agents.filter(a => window.batchInstallAction === "update" ? a.updateAvailable : !a.installed); delegate: Hint { required property var modelData; text: window.agentName(modelData.kind) + " → " + (modelData.recommendedVersion || modelData.latestVersion || "latest") + " · " + (modelData.installationSource === "npm" ? "原 npm 目录" : "独立安装"); Layout.fillWidth: true } }
            Hint { visible: !window.canInstallAgents; text: "请先在概览中暂停 Host；暂停会中断连接及运行中的会话。"; Layout.fillWidth: true; color: "#b46b19" }
        }
        onAccepted: host.installAllAgents(window.batchInstallAction)
    }
    Dialog {
        id: installationHistory; title: window.agentName(window.installKind) + " · 安装记录"; anchors.centerIn: parent; modal: true; width: 700; height: Math.min(window.height - 100, 570)
        background: NeuSurface { anchors.fill: parent; anchors.margins: -14; margin: 14; cornerRadius: 18 }
        footer: DialogButtonBox { ActionButton { text: "关闭"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } onRejected: installationHistory.reject() }
        contentItem: ScrollView { clip: true; contentWidth: availableWidth
            ColumnLayout { width: installationHistory.width - 48; spacing: 15
                Hint { text: "切回旧版前请先暂停 Host。切换会重新验证该版本能否运行。"; Layout.fillWidth: true }
                Repeater { model: window.installAgentData.installations || []; delegate: ColumnLayout { required property var modelData; Layout.fillWidth: true
                    RowLayout { Layout.fillWidth: true; Heading { text: modelData.version + (modelData.entry === window.installAgentData.entry ? " · 当前使用" : ""); font.pixelSize: 16 } Item { Layout.fillWidth: true } ActionButton { text: "使用此版本"; enabled: window.canInstallAgents && !host.busy && modelData.entry !== window.installAgentData.entry; onClicked: { host.activateInstallation(window.installKind, modelData.id); installationHistory.close() } } }
                    Hint { text: modelData.entry; Layout.fillWidth: true }
                } }
                Hint { visible: !(window.installAgentData.installations || []).length; text: "暂无 Orbis 独立安装记录。" }
                Heading { text: "本机 npm 安装"; font.pixelSize: 16 }
                Repeater { model: window.installAgentData.copies || []; delegate: Hint { required property var modelData; text: (modelData.version || "版本未知") + " · " + modelData.entry; Layout.fillWidth: true } }
            }
        }
    }
    Dialog {
        id: providerDialog; title: window.providerDraft.create ? "添加供应商" : "编辑供应商"
        anchors.centerIn: parent; modal: true; width: 760; height: Math.min(window.height - 70, 690)
        background: NeuSurface { anchors.fill: parent; anchors.margins: -14; margin: 14; cornerRadius: 18 }
        contentItem: ScrollView {
            clip: true
            contentWidth: availableWidth
            ColumnLayout { width: providerDialog.width - 48; spacing: 12
                Label { text: "名称"; color: "#4b5d78" }
                Field { id: providerName; Layout.fillWidth: true; maximumLength: 80; placeholderText: "例如：工作账号 / 自建 API" }
                Label { text: "供应商标识"; color: "#4b5d78" }
                Field { id: providerKey; Layout.fillWidth: true; maximumLength: 128; placeholderText: "custom"; enabled: window.providerDraft.kind !== "pi" || !!window.providerDraft.create }
                Label { text: "ChatGPT 登录来源"; visible: window.providerDraft.kind === "codex" && window.providerDraft.category === "official"; color: "#4b5d78" }
                ComboBox { id: providerAccount; visible: window.providerDraft.kind === "codex" && window.providerDraft.category === "official"; Layout.fillWidth: true; textRole: "label"; valueRole: "id"; model: [] }
                SoftSwitch { id: providerDetails; text: "显示备注、分类和排序设置" }
                ColumnLayout { visible: providerDetails.checked; Layout.fillWidth: true; spacing: 8
                    RowLayout { Layout.fillWidth: true
                        ColumnLayout { Layout.fillWidth: true
                            Label { text: "分类"; color: "#4b5d78" }
                            Field { id: providerCategory; Layout.fillWidth: true; placeholderText: "custom / official / aggregator" }
                        }
                        ColumnLayout { Layout.preferredWidth: 100
                            Label { text: "排序"; color: "#4b5d78" }
                            Field { id: providerOrder; Layout.fillWidth: true; validator: IntValidator {} }
                        }
                        ColumnLayout { Layout.preferredWidth: 130
                            Label { text: "图标"; color: "#4b5d78" }
                            Field { id: providerIcon; Layout.fillWidth: true; placeholderText: "图标名称" }
                        }
                    }
                    Field { id: providerWebsite; Layout.fillWidth: true; placeholderText: "供应商网站" }
                    Field { id: providerNotes; Layout.fillWidth: true; placeholderText: "备注"; maximumLength: 4000 }
                }
                SoftSwitch { id: providerAddToLive; text: window.providerDraft.kind === "pi" ? "保存后立即启用" : "没有当前供应商时自动启用"; visible: !!window.providerDraft.create }
                SoftSwitch { id: providerCommon; text: "使用 Codex 通用配置"; visible: window.providerDraft.kind === "codex" }
                SoftSwitch { id: advancedProvider; text: "高级配置（原生 JSON；保留全部字段）"; enabled: !host.busy; onToggled: {
                    var target = checked
                    checked = !target
                    var preview = window.buildProviderDraft(target)
                    if (preview !== null) { window.providerTargetAdvanced = target; host.previewProvider(preview) }
                } }
                ColumnLayout { visible: !advancedProvider.checked; Layout.fillWidth: true; spacing: 12
                    Field { id: providerUrl; Layout.fillWidth: true; placeholderText: "API 地址，例如 https://api.example.com/v1" }
                    Field { id: providerApiKey; Layout.fillWidth: true; placeholderText: "API Key"; echoMode: TextInput.Password }
                    Field { id: providerModel; visible: window.providerDraft.kind !== "pi"; Layout.fillWidth: true; placeholderText: "模型 ID（按供应商提供的名称填写）" }
                    RowLayout { visible: window.providerDraft.kind === "codex"; Layout.fillWidth: true
                        Label { text: "思考档位"; color: "#4b5d78" }
                        ComboBox { id: codexReasoning; Layout.fillWidth: true; model: ["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] }
                    }
                    ComboBox { id: providerApi; Layout.fillWidth: true; model: window.providerDraft.kind === "codex" ? ["openai-responses", "openai-completions", "anthropic-messages"] : ["", "openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "bedrock-converse-stream"] }
                    SoftSwitch { id: providerProxyDetails; text: "路由与推理参数"; visible: window.providerDraft.kind === "codex" }
                    ColumnLayout { visible: window.providerDraft.kind === "codex" && providerProxyDetails.checked; Layout.fillWidth: true; spacing: 8
                        SoftSwitch { id: providerFullUrl; text: "使用完整 API 端点地址" }
                        RowLayout { Layout.fillWidth: true
                            Label { text: "会话缓存路由"; color: "#4b5d78" }
                            ComboBox { id: providerCache; Layout.fillWidth: true; textRole: "label"; valueRole: "value"; model: [{label:"自动",value:"auto"},{label:"启用",value:"enabled"},{label:"禁用",value:"disabled"}] }
                        }
                        SoftSwitch { id: providerReasoningAuto; text: "自动识别推理参数" }
                        GridLayout { visible: !providerReasoningAuto.checked; columns: 2; Layout.fillWidth: true
                            CheckBox { id: providerThinking; text: "支持思考开关" }
                            CheckBox { id: providerEffort; text: "支持思考档位" }
                            Label { text: "思考开关参数"; color: "#4b5d78" }
                            ComboBox { id: providerThinkingParam; Layout.fillWidth: true; model: ["thinking", "enable_thinking", "reasoning_split", "none"] }
                            Label { text: "档位参数"; color: "#4b5d78" }
                            ComboBox { id: providerEffortParam; Layout.fillWidth: true; model: ["reasoning_effort", "reasoning.effort", "none"] }
                            Label { text: "档位映射"; color: "#4b5d78" }
                            ComboBox { id: providerEffortMode; Layout.fillWidth: true; model: ["passthrough", "deepseek", "low_high", "openrouter", "zen"] }
                        }
                        Label { text: "Chat 兼容参数（JSON）"; color: "#4b5d78" }
                        TextArea { id: providerChatOptions; Layout.fillWidth: true; Layout.preferredHeight: 64; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas"; background: Rectangle { color: "#DDE3EF"; radius: 8 } }
                        Label { text: "请求覆盖（headers / body）"; color: "#4b5d78" }
                        TextArea { id: providerRequestOverrides; Layout.fillWidth: true; Layout.preferredHeight: 90; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas"; background: Rectangle { color: "#DDE3EF"; radius: 8 } }
                    }
                    ActionButton { text: "获取模型列表"; enabled: !host.busy && providerUrl.text.trim().length > 0; onClicked: { var draft = window.buildProviderDraft(true); if (draft !== null) host.fetchProviderModels(draft) } }
                    Label { text: "请求头（JSON 对象）"; visible: window.providerDraft.kind !== "dsh"; color: "#4b5d78" }
                    TextArea { id: piHeaders; visible: window.providerDraft.kind !== "dsh"; Layout.fillWidth: true; Layout.preferredHeight: 64; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas"; background: Rectangle { color: "#DDE3EF"; radius: 8 } }
                    ColumnLayout { visible: window.providerDraft.kind === "codex"; Layout.fillWidth: true; spacing: 8
                        RowLayout { Layout.fillWidth: true
                            Label { text: "模型目录"; color: "#4b5d78"; font.bold: true }
                            Item { Layout.fillWidth: true }
                            ActionButton { text: "＋ 添加模型"; onClicked: window.codexModels = window.codexModels.concat([{model: ""}]) }
                        }
                        Repeater { model: window.codexModels
                            delegate: RowLayout {
                                required property var modelData; required property int index
                                Layout.fillWidth: true
                                Field { Layout.fillWidth: true; text: modelData.model || ""; placeholderText: "模型 ID"; onTextEdited: window.updateCodexModel(index, "model", text) }
                                Field { Layout.fillWidth: true; text: modelData.displayName || ""; placeholderText: "显示名称"; onTextEdited: window.updateCodexModel(index, "displayName", text) }
                                Field { Layout.preferredWidth: 120; text: modelData.contextWindow === undefined ? "" : String(modelData.contextWindow); placeholderText: "上下文窗口"; onTextEdited: window.updateCodexModel(index, "contextWindow", text) }
                                ActionButton { text: "删除"; danger: true; onClicked: window.deleteCodexModel(index) }
                            }
                        }
                    }
                    ColumnLayout { visible: window.providerDraft.kind === "pi"; Layout.fillWidth: true; spacing: 8
                        Label { text: "兼容参数（JSON 对象）"; color: "#4b5d78" }
                        TextArea { id: piCompat; Layout.fillWidth: true; Layout.preferredHeight: 64; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas"; background: Rectangle { color: "#DDE3EF"; radius: 8 } }
                        RowLayout { Layout.fillWidth: true
                            Label { text: "模型"; color: "#4b5d78"; font.bold: true }
                            Item { Layout.fillWidth: true }
                            ActionButton { text: "＋ 添加模型"; onClicked: window.addPiModel() }
                        }
                        Repeater { model: window.piModels
                            delegate: ColumnLayout {
                                required property var modelData
                                required property int index
                                Layout.fillWidth: true; spacing: 6
                                RowLayout { Layout.fillWidth: true
                                    Field { Layout.fillWidth: true; text: modelData.id || ""; placeholderText: "模型 ID"; onTextEdited: window.updatePiModel(index, "id", text) }
                                    Field { Layout.fillWidth: true; text: modelData.name || ""; placeholderText: "显示名称"; onTextEdited: window.updatePiModel(index, "name", text) }
                                    ActionButton { text: "删除"; danger: true; onClicked: window.deletePiModel(index) }
                                }
                                RowLayout { Layout.fillWidth: true
                                    CheckBox { text: "推理"; checked: modelData.reasoning === true; onToggled: window.updatePiModel(index, "reasoning", checked) }
                                    CheckBox { text: "图像输入"; checked: Array.isArray(modelData.input) && modelData.input.indexOf("image") >= 0; onToggled: window.updatePiModel(index, "input", checked ? ["text", "image"] : ["text"]) }
                                    Field { Layout.fillWidth: true; text: modelData.contextWindow === undefined ? "" : String(modelData.contextWindow); placeholderText: "上下文窗口"; inputMethodHints: Qt.ImhDigitsOnly; onTextEdited: window.updatePiModel(index, "contextWindow", text) }
                                    Field { Layout.fillWidth: true; text: modelData.maxTokens === undefined ? "" : String(modelData.maxTokens); placeholderText: "最大输出"; inputMethodHints: Qt.ImhDigitsOnly; onTextEdited: window.updatePiModel(index, "maxTokens", text) }
                                }
                                TextArea { Layout.fillWidth: true; Layout.preferredHeight: 58; placeholderText: "思考档位映射（JSON，可留空使用 Pi 默认值）"; text: modelData.thinkingLevelMap === undefined ? "" : JSON.stringify(modelData.thinkingLevelMap); selectByMouse: true; wrapMode: TextEdit.Wrap; onTextChanged: if (activeFocus) window.updatePiModel(index, "thinkingLevelMap", text); background: Rectangle { color: "#DDE3EF"; radius: 8 } }
                            }
                        }
                    }
                }
                ColumnLayout { visible: advancedProvider.checked; Layout.fillWidth: true
                    Hint { text: window.providerDraft.kind === "codex" ? "Codex：auth 为 auth.json 对象或 null，config 为 config.toml 文本。" : window.providerDraft.kind === "pi" ? "Pi：完整的 models.json.providers.<标识> 节点。" : "DSH：patch 为 cordis.patch.yml 文本，env 保存该配置所需的凭据环境变量。"; Layout.fillWidth: true }
                    TextArea { id: providerJson; Layout.fillWidth: true; Layout.preferredHeight: 230; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas"; color: "#21314d"; background: Rectangle { color: "#DDE3EF"; radius: 8 } padding: 12 }
                }
                Hint { visible: host.message.length > 0; text: host.message; Layout.fillWidth: true; color: "#a34d4d" }
                Hint { visible: window.providerFormError.length > 0; text: window.providerFormError; Layout.fillWidth: true; color: "#a34d4d" }
            }
        }
        footer: RowLayout {
            spacing: 12
            Item { Layout.fillWidth: true }
            ActionButton { text: "取消"; enabled: !host.busy; onClicked: providerDialog.reject() }
            ActionButton { text: host.busy ? "保存中…" : "保存"; primary: true; enabled: !host.busy && providerName.text.trim().length > 0; onClicked: {
                window.saveProviderEditor()
            } }
        }
        onClosed: { providerApiKey.text = ""; providerJson.text = ""; window.providerDraft = ({}) }
    }
    Dialog {
        id: presetDialog; title: "选择供应商预设"; anchors.centerIn: parent; modal: true; width: 530
        ColumnLayout { width: parent.width; spacing: 12
            ComboBox { id: providerPreset; model: host.providerPresets; textRole: "name"; valueRole: "id"; Layout.fillWidth: true; editable: true }
            Hint { text: "选择后可编辑端点、密钥及模型。"; Layout.fillWidth: true }
        }
        standardButtons: Dialog.Cancel | Dialog.Ok
        onAccepted: host.presetProvider(providerPreset.currentValue)
    }
    Dialog {
        id: oauthDialog; title: "Codex · ChatGPT 账号"; anchors.centerIn: parent; modal: true; width: 700; height: 560
        contentItem: ScrollView { clip: true; contentWidth: availableWidth
            ColumnLayout { width: oauthDialog.width - 44; spacing: 12
                Hint { text: "登录完成后，在官方供应商卡片中选择托管账号。切换前会刷新凭据，并同步本机 Codex 更新过的登录。"; Layout.fillWidth: true }
                RowLayout {
                    ActionButton { text: "添加账号"; primary: true; enabled: !host.busy && !window.oauthPending.deviceCode; onClicked: host.oauthAccount("start") }
                    ActionButton { text: "导入本机登录"; enabled: !host.busy; onClicked: host.oauthAccount("import") }
                    ActionButton { text: "刷新"; enabled: !host.busy; onClicked: host.oauthAccount("list") }
                }
                ColumnLayout { visible: !!window.oauthPending.deviceCode; Layout.fillWidth: true
                    Label { text: window.oauthPending.userCode || ""; font.pixelSize: 24; font.bold: true; color: "#21314d" }
                    Hint { text: "在浏览器登录并输入上方授权码。完成后会自动显示账号。"; Layout.fillWidth: true }
                    RowLayout {
                        ActionButton { text: "打开授权页"; onClicked: Qt.openUrlExternally(window.oauthPending.verificationUrl) }
                        ActionButton { text: "取消登录"; enabled: !host.busy; onClicked: { host.oauthAccount("cancel", window.oauthPending.deviceCode); window.oauthPending = ({}) } }
                    }
                }
                Repeater { model: window.oauthAccounts
                    delegate: ColumnLayout { required property var modelData; Layout.fillWidth: true
                        Label { text: (modelData.email || modelData.workspace) + (modelData.isDefault ? " · 默认账号" : ""); color: "#21314d"; font.bold: true }
                        Hint { text: modelData.workspace; Layout.fillWidth: true }
                        RowLayout {
                            ActionButton { text: "设为默认"; enabled: !host.busy && !modelData.isDefault; onClicked: host.oauthAccount("default", modelData.id) }
                            ActionButton { text: "重新登录"; enabled: !host.busy && !window.oauthPending.deviceCode; onClicked: host.oauthAccount("start", modelData.id) }
                            ActionButton { text: "删除账号"; danger: true; enabled: !host.busy; onClicked: { oauthDeleteDialog.accountId = modelData.id; oauthDeleteDialog.open() } }
                        }
                    }
                }
                Hint { text: host.message; visible: text.length > 0; Layout.fillWidth: true; color: "#a34d4d" }
            }
        }
        standardButtons: Dialog.Close
        onClosed: { if (window.oauthPending.deviceCode) host.oauthAccount("cancel", window.oauthPending.deviceCode); window.oauthPending = ({}) }
    }
    Dialog {
        id: oauthDeleteDialog; property string accountId: ""; title: "删除托管账号？"; anchors.centerIn: parent; modal: true; width: 420
        Label { width: parent.width; text: "删除 Host 保存的登录凭据。仍被供应商绑定的账号需要先解除绑定。"; wrapMode: Text.WordWrap }
        standardButtons: Dialog.Cancel | Dialog.Ok
        onAccepted: host.oauthAccount("remove", accountId)
    }
    Timer {
        interval: Math.max(5000, (window.oauthPending.interval || 8) * 1000); repeat: true; running: oauthDialog.visible && !!window.oauthPending.deviceCode
        onTriggered: { if (Date.now() >= window.oauthPending.expiresAt) { host.oauthAccount("cancel", window.oauthPending.deviceCode); window.oauthPending = ({}) } else if (!host.busy) host.oauthAccount("poll", window.oauthPending.deviceCode) }
    }
    Dialog {
        id: routingDialog; title: "Codex 本地路由"; anchors.centerIn: parent; modal: true
        width: Math.min(760, window.width - 40); height: Math.min(690, window.height - 40)
        contentItem: ScrollView { clip: true
            ColumnLayout { width: routingDialog.width - 48; spacing: 12
                SoftSwitch { id: routingEnabled; text: "接管 Codex 请求" }
                RowLayout { Layout.fillWidth: true
                    Label { text: "本地端口"; color: "#4b5d78" }
                    SpinBox { id: routingPort; from: 1024; to: 65535; editable: true; enabled: !host.proxyStatus.running }
                    Item { Layout.fillWidth: true }
                    SoftSwitch { id: routingFailover; text: "自动故障转移" }
                }
                Label { text: "故障转移队列"; font.bold: true; color: "#21314d" }
                Repeater { model: window.routingQueue
                    delegate: RowLayout { required property int index; required property string modelData; Layout.fillWidth: true
                        Label { text: String(index + 1) + ". " + window.routingName(modelData); Layout.fillWidth: true; elide: Text.ElideRight; color: "#21314d" }
                        ToolButton { text: "↑"; enabled: index > 0; onClicked: window.moveRoute(index, -1); ToolTip.visible: hovered; ToolTip.text: "上移" }
                        ToolButton { text: "↓"; enabled: index + 1 < window.routingQueue.length; onClicked: window.moveRoute(index, 1); ToolTip.visible: hovered; ToolTip.text: "下移" }
                        ToolButton { text: "×"; onClicked: { var next = window.routingQueue.slice(); next.splice(index, 1); window.routingQueue = next } ToolTip.visible: hovered; ToolTip.text: "移出队列" }
                    }
                }
                RowLayout { Layout.fillWidth: true
                    ComboBox { id: routingCandidate; Layout.fillWidth: true; model: host.providers.filter(function(p) { return p.category !== "official" && window.routingQueue.indexOf(p.id) < 0 }); textRole: "name"; valueRole: "id" }
                    ActionButton { text: "加入队列"; enabled: routingCandidate.currentIndex >= 0; onClicked: window.routingQueue = window.routingQueue.concat([routingCandidate.currentValue]) }
                }
                Label { text: "超时与重试"; font.bold: true; color: "#21314d" }
                GridLayout { columns: 2; Layout.fillWidth: true; columnSpacing: 20
                    Label { text: "最多重试次数"; Layout.fillWidth: true; color: "#4b5d78" } SpinBox { id: routingRetries; from: 0; to: 10; editable: true }
                    Label { text: "首字节超时（秒）"; color: "#4b5d78" } SpinBox { id: routingFirst; from: 1; to: 600; editable: true }
                    Label { text: "流空闲超时（秒）"; color: "#4b5d78" } SpinBox { id: routingIdle; from: 1; to: 3600; editable: true }
                    Label { text: "请求总超时（秒）"; color: "#4b5d78" } SpinBox { id: routingTimeout; from: 1; to: 3600; editable: true }
                }
                Label { text: "熔断与恢复"; font.bold: true; color: "#21314d" }
                GridLayout { columns: 2; Layout.fillWidth: true; columnSpacing: 20
                    Label { text: "连续失败阈值"; Layout.fillWidth: true; color: "#4b5d78" } SpinBox { id: routingFailures; from: 1; to: 100; editable: true }
                    Label { text: "恢复成功阈值"; color: "#4b5d78" } SpinBox { id: routingSuccesses; from: 1; to: 100; editable: true }
                    Label { text: "恢复等待（秒）"; color: "#4b5d78" } SpinBox { id: routingCooldown; from: 1; to: 3600; editable: true }
                    Label { text: "错误率阈值（%）"; color: "#4b5d78" } SpinBox { id: routingErrorRate; from: 1; to: 100; editable: true }
                    Label { text: "错误率最小样本"; color: "#4b5d78" } SpinBox { id: routingMinRequests; from: 1; to: 1000; editable: true }
                }
                Hint { visible: host.message.length > 0; text: host.message; Layout.fillWidth: true; color: "#a34d4d" }
            }
        }
        footer: RowLayout { spacing: 10; Item { Layout.fillWidth: true }
            ActionButton { text: "取消"; enabled: !host.busy; onClicked: routingDialog.reject() }
            ActionButton { text: "保存"; primary: true; enabled: !host.busy; onClicked: host.saveProxyPreferences({enabled:routingEnabled.checked, port:routingPort.value, autoFailoverEnabled:routingFailover.checked, queue:window.routingQueue, maxRetries:routingRetries.value, firstByteTimeout:routingFirst.value, idleTimeout:routingIdle.value, requestTimeout:routingTimeout.value, failureThreshold:routingFailures.value, successThreshold:routingSuccesses.value, timeoutSeconds:routingCooldown.value, errorRateThreshold:routingErrorRate.value / 100, minRequests:routingMinRequests.value}) }
        }
    }
    Dialog {
        id: codexPreferencesDialog; title: "Codex 通用配置"; anchors.centerIn: parent; modal: true; width: 660; height: 480
        ColumnLayout { width: parent.width; spacing: 12
            Hint { text: "勾选“使用 Codex 通用配置”的供应商共用这些偏好；切换前会同步当前原生配置中的共享改动。MCP 配置继续保留。"; Layout.fillWidth: true }
            TextArea { id: codexCommonText; Layout.fillWidth: true; Layout.preferredHeight: 230; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas"; background: Rectangle { color: "#DDE3EF"; radius: 8 } }
            SoftSwitch { id: preserveCodexLogin; text: "切换第三方供应商时保留官方登录" }
            Hint { text: host.message; visible: text.length > 0; Layout.fillWidth: true; color: "#a34d4d" }
        }
        footer: RowLayout {
            Item { Layout.fillWidth: true }
            ActionButton { text: "取消"; enabled: !host.busy; onClicked: codexPreferencesDialog.reject() }
            ActionButton { text: "保存"; primary: true; enabled: !host.busy; onClicked: host.saveCodexPreferences({ commonConfig: codexCommonText.text, preserveOfficialLogin: preserveCodexLogin.checked }) }
        }
    }
    Dialog {
        id: providerInfoDialog; anchors.centerIn: parent; modal: true; width: 590; height: 400
        property string infoText: ""
        contentItem: ScrollView { TextArea { text: providerInfoDialog.infoText; readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap } }
        standardButtons: Dialog.Ok
    }
    Dialog {
        id: fetchedModelsDialog; title: "选择模型"; anchors.centerIn: parent; modal: true; width: 550; height: 490
        contentItem: ScrollView { clip: true; contentWidth: availableWidth
            ColumnLayout { width: fetchedModelsDialog.width - 40
                Repeater { model: window.fetchedModels
                    CheckBox { required property var modelData; required property int index; text: modelData.name + " · " + modelData.id; onToggled: window.fetchedModels[index].selected = checked }
                }
            }
        }
        standardButtons: Dialog.Cancel | Dialog.Ok
        onAccepted: {
            var selected = window.fetchedModels.filter(function(model) { return model.selected })
            if (window.providerDraft.kind === "pi") {
                var current = window.piModels.filter(function(model) { return model.id.trim().length > 0 })
                selected.forEach(function(model) { if (!current.some(function(existing) { return existing.id === model.id })) current.push({id: model.id, name: model.name, input: ["text"]}) })
                window.piModels = current
            } else if (selected.length > 0) providerModel.text = selected[0].id
        }
    }
    Dialog {
        id: usageDialog; title: "用量查询配置"; anchors.centerIn: parent; modal: true; width: 680; height: 620
        contentItem: ScrollView { clip: true; contentWidth: availableWidth
            ColumnLayout { width: usageDialog.width - 42; spacing: 10
                SoftSwitch { id: usageEnabled; text: "启用用量查询" }
                RowLayout { Layout.fillWidth: true
                    ComboBox { id: usageTemplateType; Layout.fillWidth: true; textRole: "name"; valueRole: "id"; model: [{id:"custom",name:"自定义脚本"},{id:"general",name:"通用余额"},{id:"newapi",name:"New API"},{id:"balance",name:"官方余额（DeepSeek 等）"}] }
                    ActionButton { text: "载入模板"; enabled: !host.busy; onClicked: host.loadUsageTemplate(window.usageProviderId, usageTemplateType.currentValue, usageBaseUrl.text) }
                }
                Hint { text: "脚本返回 { request: { url, method, headers }, extractor: response => ({ remaining, unit }) }。支持 {{apiKey}}、{{baseUrl}}、{{accessToken}}、{{userId}} 变量。"; Layout.fillWidth: true }
                TextArea { id: usageCode; Layout.fillWidth: true; Layout.preferredHeight: 180; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas"; background: Rectangle { color: "#DDE3EF"; radius: 8 } }
                Field { id: usageBaseUrl; placeholderText: "查询地址覆盖（留空跟随供应商）"; Layout.fillWidth: true }
                Field { id: usageApiKey; placeholderText: "API Key 覆盖（留空跟随供应商）"; echoMode: TextInput.Password; Layout.fillWidth: true }
                RowLayout { Layout.fillWidth: true
                    Field { id: usageAccessToken; placeholderText: "访问令牌（可选）"; echoMode: TextInput.Password; Layout.fillWidth: true }
                    Field { id: usageUserId; placeholderText: "用户 ID（可选）"; Layout.fillWidth: true }
                    Field { id: usageTimeout; placeholderText: "超时秒数"; text: "10"; Layout.preferredWidth: 100; validator: IntValidator { bottom: 2; top: 30 } }
                }
                Label { text: "自动查询间隔（分钟，0 表示关闭）"; color: "#4b5d78" }
                Field { id: usageInterval; text: "5"; Layout.fillWidth: true; validator: IntValidator { bottom: 0; top: 1440 } }
                Hint { text: usageTemplateType.currentValue === "custom" ? "自定义模板可以使用独立查询端点。" : usageTemplateType.currentValue === "balance" ? "官方余额查询使用内置接口；自定义代码请选择其他模板。" : "查询端点须与供应商或覆盖地址属于同一主机。"; Layout.fillWidth: true }
                Hint { text: host.message; visible: text.length > 0; Layout.fillWidth: true; color: "#a34d4d" }
            }
        }
        footer: RowLayout {
            Item { Layout.fillWidth: true }
            ActionButton { text: "取消"; enabled: !host.busy; onClicked: usageDialog.reject() }
            ActionButton { text: "保存"; primary: true; enabled: !host.busy; onClicked: host.saveProviderUsage(window.usageProviderId, { enabled: usageEnabled.checked, language: "javascript", code: usageCode.text, timeout: Number(usageTimeout.text), apiKey: usageApiKey.text, baseUrl: usageBaseUrl.text, accessToken: usageAccessToken.text, userId: usageUserId.text, templateType: usageTemplateType.currentValue, autoQueryInterval: Number(usageInterval.text) }) }
        }
        onClosed: { usageApiKey.text = ""; usageAccessToken.text = ""; usageCode.text = "" }
    }
    Dialog {
        id: removeProviderDialog; title: "从 Pi 移除供应商？"; anchors.centerIn: parent; modal: true; width: 440
        Label { width: parent.width; text: "仅移除 models.json 中的节点，卡片和最新配置仍保留。" + (host.piDefaultProvider === window.removeProviderId ? "\n这是 Pi 的全局默认供应商，移除后请在 Pi 中重新选择模型。" : ""); wrapMode: Text.WordWrap }
        standardButtons: Dialog.Cancel | Dialog.Ok
        onAccepted: host.switchProvider(window.removeProviderId, false)
    }
    Dialog {
        id: deleteProviderDialog; title: "删除供应商？"; anchors.centerIn: parent; modal: true; width: 410
        Label { width: parent.width; text: host.providerKind === "pi" ? "删除卡片和 models.json 中的对应供应商。" + (host.piDefaultProvider === window.deleteProviderId ? "\n这是 Pi 的全局默认供应商，删除后请在 Pi 中重新选择模型。" : "") : "删除这个未启用的供应商配置。"; wrapMode: Text.WordWrap }
        standardButtons: Dialog.Cancel | Dialog.Ok
        onAccepted: host.removeProvider(window.deleteProviderId)
    }
    Dialog {
        id: renameDialog; title: "设备名称"; anchors.centerIn: parent; modal: true; width: 410
        background: NeuSurface { anchors.fill: parent; anchors.margins: -14; margin: 14; cornerRadius: 18 }
        Field { id: deviceNameField; width: parent.width; maximumLength: 80; placeholderText: "例如：我的手机" }
        footer: DialogButtonBox { ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } ActionButton { text: "保存名称"; primary: true; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole } onAccepted: renameDialog.accept(); onRejected: renameDialog.reject() }
        onAccepted: host.renameDevice(window.revokeId, deviceNameField.text)
    }
    Connections {
        target: host
        function onChanged() { if (host.qr.length > 0 && !pairDialog.visible) pairDialog.open(); if (host.qr.length === 0 && pairDialog.visible) pairDialog.close() }
        function onProviderDraftReady(draft) {
            window.providerDraft = draft; host.clearMessage()
            window.providerFormError = ""
            providerName.text = draft.name
            providerAccount.model = window.accountOptions(draft.accounts || [])
            providerAccount.currentIndex = Math.max(0, providerAccount.indexOfValue(draft.authBinding ? (draft.authBinding.accountId || "$default") : ""))
            providerDetails.checked = false
            providerCategory.text = draft.category || "custom"; providerNotes.text = draft.notes || ""; providerWebsite.text = draft.websiteUrl || ""; providerIcon.text = draft.icon || ""; providerOrder.text = String(draft.sortIndex || 0)
            providerCommon.checked = draft.commonConfigEnabled === true || (!!draft.create && draft.kind === "codex")
            providerAddToLive.checked = !!draft.create
            window.loadProviderFields(draft)
            advancedProvider.checked = !draft.create
            if (draft.category === "official") advancedProvider.checked = true
            providerDialog.open()
        }
        function onProviderPreviewReady(draft) { window.loadProviderFields(draft); advancedProvider.checked = window.providerTargetAdvanced }
        function onCodexPreferencesReady(preferences) { codexCommonText.text = preferences.commonConfig; preserveCodexLogin.checked = preferences.preserveOfficialLogin; host.clearMessage(); codexPreferencesDialog.open() }
        function onCodexPreferencesSaved() { codexPreferencesDialog.close() }
        function onProxyPreferencesReady(p) {
            window.routingDraft = p; window.routingQueue = p.queue.slice(); host.clearMessage()
            routingEnabled.checked = p.enabled; routingPort.value = p.port; routingFailover.checked = p.autoFailoverEnabled
            routingRetries.value = p.maxRetries; routingFirst.value = p.firstByteTimeout; routingIdle.value = p.idleTimeout; routingTimeout.value = p.requestTimeout
            routingFailures.value = p.failureThreshold; routingSuccesses.value = p.successThreshold; routingCooldown.value = p.timeoutSeconds; routingErrorRate.value = Math.round(p.errorRateThreshold * 100); routingMinRequests.value = p.minRequests
            routingDialog.open()
        }
        function onProxyPreferencesSaved() { routingDialog.close() }
        function onProviderModelsReady(models) { window.fetchedModels = models.map(function(model) { return {id: model.id, name: model.name, selected: false} }); fetchedModelsDialog.open() }
        function onProviderUsageReady(id, script) {
            window.usageProviderId = id; usageEnabled.checked = script.enabled === true; usageTemplateType.currentIndex = Math.max(0, usageTemplateType.indexOfValue(script.templateType || "custom")); usageInterval.text = String(script.autoQueryInterval === undefined ? 5 : script.autoQueryInterval)
            usageCode.text = script.code || "({\n  request: { url: '{{baseUrl}}/usage', method: 'GET', headers: { Authorization: 'Bearer {{apiKey}}' } },\n  extractor: response => ({ remaining: response.remaining, unit: 'USD' })\n})"
            usageBaseUrl.text = script.baseUrl || ""; usageApiKey.text = script.apiKey || ""; usageAccessToken.text = script.accessToken || ""; usageUserId.text = script.userId || ""; usageTimeout.text = String(script.timeout || 10)
            host.clearMessage(); usageDialog.open()
        }
        function onProviderUsageSaved() { usageDialog.close() }
        function onUsageTemplateReady(value) { usageCode.text = value.code; if (value.baseUrl) usageBaseUrl.text = value.baseUrl }
        function onOauthAccountResult(operation, value) {
            if (operation === "start") window.oauthPending = value
            else if (operation === "poll") { if (!value.pending) { window.oauthPending = ({}); host.oauthAccount("list") } }
            else if (operation !== "cancel") window.oauthAccounts = value
        }
        function onProviderInfoReady(title, text) { providerInfoDialog.title = title; providerInfoDialog.infoText = text; providerInfoDialog.open() }
        function onProviderSaved() { providerDialog.close() }
    }
}
