import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Orbis.Host
import "ProviderFlow.js" as ProviderFlow

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
    property bool agentVersionsChecked: false
    readonly property bool canInstallAgents: host.state === "stopped" || host.state === "error"
    function agentName(kind) { return ({pi:"Pi", codex:"Codex", dsh:"DeepSeek Harness"})[kind] || kind }
    function installationStage() { return ({queued:"准备安装", resolving:"检查安装位置", downloading:"下载与安装依赖", verifying:"验证 CLI 和版本", activating:"保存新版本", restarting:"正在重启 Agent 后台", restartFailed:"已更新，后台需手动重启", cancelling:"正在取消并清理", cancelled:"已取消", error:"安装失败", done:"安装完成"})[host.agentInstallStage] || "" }
    function showAgentInstaller(agent) { installKind = agent.kind; installAgentData = agent; installDialog.open() }
    function showAgentBatch() { batchInstallDialog.open() }
    function closeAgentDialogs() { installDialog.close(); batchInstallDialog.close() }
    property bool providersOpen: false
    property bool providerFormDirty: false
    property bool loadingProviderDraft: false
    property string pendingPresetId: ""
    property string draggedProviderId: ""
    readonly property bool officialProvider: providerDraft.kind === "codex" && providerDraft.official === true
    readonly property var visibleProviders: host.providers.filter(function(p) { return ProviderFlow.matchesProvider(p, providerSearch.text) })
    function changePreset(id) { if (id === (providerDraft.presetId || "custom")) { presetExpanded.checked = false; return } if (providerFormDirty) { pendingPresetId = id; changePresetDialog.open() } else host.presetProvider(id) }
    function moveProvider(source, target) { var ids = ProviderFlow.reorderedIds(host.providers, source, target); if (ids !== null) host.reorderProviders(ids) }
    function acceptDiscoveredModels() {
        var selected = fetchedModels.filter(function(model) { return model.selected })
        if (!selected.length) return
        if (modelRequestConfig !== modelQueryConfig()) { providerFormError = "接口或模型行已修改，请重新获取模型列表。"; return }
        if (modelRequestIndex === -2) providerModel.text = selected[0].id
        else {
            var result = ProviderFlow.applyDiscoveredModels(providerDraft.kind, providerModels, selected, providerModel.text, modelRequestIndex)
            if (result.error) { providerFormError = result.error; return }
            providerModels = result.models
            explicitProviderModels = true
            if (providerDraft.kind === "dsh") providerModel.text = result.defaultModel
        }
        providerFormDirty = true
    }
    property var providerDraft: ({})
    property var providerModels: []
    property bool explicitProviderModels: false
    property string providerFormError: ""
    property bool providerTargetAdvanced: false
    property string deleteProviderId: ""
    property string removeProviderId: ""
    property var fetchedModels: []
    property string modelRequestConfig: ""
    property int modelRequestIndex: -1
    readonly property bool singleModelSelection: providerDraft.kind === "codex" || modelRequestIndex !== -1
    function modelQueryConfig() { return JSON.stringify([providerUrl.text, providerApiKey.text, providerApi.currentText, piHeaders.text, modelRequestIndex >= 0 ? providerModels : null]) }
    function requestProviderModels(index) {
        var draft = window.buildProviderDraft(true)
        if (draft !== null) {
            modelRequestIndex = providerDraft.kind === "codex" ? -2 : typeof index === "number" ? index : -1
            modelRequestConfig = modelQueryConfig()
            host.fetchProviderModels(draft)
        }
    }
    property var oauthAccounts: []
    property var oauthPending: ({})
    property var providerRoutingDraft: ({})
    function accountOptions(accounts) { return [{id:"",label:"使用本机 CLI 登录"},{id:"$default",label:"使用默认托管账号"}].concat(accounts.map(function(a) { return {id:a.id,label:(a.email || a.workspace) + (a.isDefault ? "（默认）" : "")} })) }
    function updateProviderModel(index, key, value) {
        if (index < 0 || index >= providerModels.length) return
        var previousId = providerModels[index].id
        providerModels[index][key] = value
        if (providerDraft.kind === "dsh" && key === "id" && (!providerModel.text || providerModel.text === previousId)) providerModel.text = value
        providerFormDirty = true
    }
    function addProviderModel() { providerModels = providerModels.concat([ProviderFlow.newModel(providerDraft.kind)]); explicitProviderModels = true; providerFormDirty = true }
    function deleteProviderModel(index) {
        var next = providerModels.slice(); var removed = next.splice(index, 1)[0]
        providerModels = next
        if (providerDraft.kind === "dsh" && removed && providerModel.text === removed.id) providerModel.text = next.length ? next[0].id : ""
        providerFormDirty = true
    }
    function loadProviderFields(draft) {
        providerKey.text = draft.fields.providerKey
        providerUrl.text = draft.fields.baseUrl; providerApiKey.text = draft.fields.apiKey
        providerModel.text = draft.fields.model || (window.providerDraft.kind === "codex" ? "gpt-5.6-sol" : "")
        providerApi.model = window.providerDraft.kind === "codex" ? ["openai-responses", "openai-completions", "anthropic-messages"] : ["", "openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "bedrock-converse-stream"]
        if (providerApi.find(draft.fields.api) < 0) providerApi.model = providerApi.model.concat([draft.fields.api])
        providerApi.currentIndex = Math.max(0, providerApi.find(draft.fields.api))
        piHeaders.text = JSON.stringify(draft.fields.headers || {}, null, 2)
        piCompat.text = JSON.stringify(draft.fields.compat || {}, null, 2)
        window.providerModels = window.providerDraft.kind === "codex" ? [] : draft.fields.models || []
        window.explicitProviderModels = draft.fields.models !== undefined
        if (draft.create && window.providerDraft.kind === "pi") window.providerModels = window.providerModels.map(function(model) { return !model.id ? Object.assign(ProviderFlow.newModel("pi"), model) : model })
        codexReasoning.currentIndex = Math.max(0, codexReasoning.find(draft.fields.reasoningEffort || "high"))
        providerJson.text = JSON.stringify(draft.config, null, 2)
        var advanced = draft.config || {}
        if (window.providerDraft.kind === "codex") {
            providerAuthJson.text = advanced.auth === null ? "null" : JSON.stringify(advanced.auth || {}, null, 2)
            providerConfigToml.text = typeof advanced.config === "string" ? advanced.config : ""
            var codexExtras = JSON.parse(JSON.stringify(advanced)); delete codexExtras.auth; delete codexExtras.config
            codexExtraJson.text = JSON.stringify(codexExtras, null, 2)
        } else if (window.providerDraft.kind === "dsh") {
            providerPatchYaml.text = typeof advanced.patch === "string" ? advanced.patch : ""
            providerEnvJson.text = JSON.stringify(advanced.env || {}, null, 2)
            var dshExtras = JSON.parse(JSON.stringify(advanced)); delete dshExtras.patch; delete dshExtras.env
            dshExtraJson.text = JSON.stringify(dshExtras, null, 2)
        }
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
    function parseAdvancedJson(text, fallback, label) {
        var value
        try { value = JSON.parse(text.trim() || fallback) }
        catch (error) { window.providerFormError = label + "必须是有效的 JSON"; return null }
        if (value === null || Array.isArray(value) || typeof value !== "object") { window.providerFormError = label + "必须是 JSON 对象"; return null }
        return value
    }
    function advancedConfigText() {
        if (window.providerDraft.kind === "codex") {
            var auth
            try { auth = JSON.parse(providerAuthJson.text.trim() || "null") }
            catch (error) { window.providerFormError = "auth.json 必须是有效的 JSON"; return null }
            if (auth !== null && (Array.isArray(auth) || typeof auth !== "object")) { window.providerFormError = "auth.json 必须是 JSON 对象或 null"; return null }
            var codexConfig = parseAdvancedJson(codexExtraJson.text, "{}", "其他字段")
            if (codexConfig === null) return null
            codexConfig.auth = auth; codexConfig.config = providerConfigToml.text
            return JSON.stringify(codexConfig)
        }
        if (window.providerDraft.kind === "dsh") {
            var env = parseAdvancedJson(providerEnvJson.text, "{}", "环境变量")
            if (env === null) return null
            var dshConfig = parseAdvancedJson(dshExtraJson.text, "{}", "其他字段")
            if (dshConfig === null) return null
            dshConfig.patch = providerPatchYaml.text; dshConfig.env = env
            return JSON.stringify(dshConfig)
        }
        return providerJson.text
    }
    function buildProviderDraft(basic) {
        var configText = basic ? providerJson.text : window.advancedConfigText()
        if (configText === null) return null
        var draft = {kind: window.providerDraft.kind, id: window.providerDraft.kind === "pi" ? providerKey.text.trim() : window.providerDraft.id, name: providerName.text, config: configText, create: !!window.providerDraft.create, addToLive: providerAddToLive.checked,
            metadata: {category: window.officialProvider ? "official" : providerCategory.text, notes: providerNotes.text, websiteUrl: providerWebsite.text, icon: providerIcon.text, sortIndex: Number(providerOrder.text || "0"), commonConfigEnabled: providerCommon.checked}}
        if (draft.kind === "codex") draft.metadata.authBinding = providerAccount.currentValue ? {source:"managed_account",authProvider:"codex_oauth",accountId:providerAccount.currentValue === "$default" ? "" : providerAccount.currentValue} : null
        if (basic) {
            draft.fields = {providerKey: providerKey.text.trim(), baseUrl: providerUrl.text.trim(), apiKey: providerApiKey.text, model: providerModel.text.trim(), api: providerApi.currentText}
            if (draft.kind === "codex") draft.fields.reasoningEffort = codexReasoning.currentText
            if (draft.kind === "pi" || (draft.kind === "dsh" && window.explicitProviderModels)) draft.fields.models = window.providerModels
            if (draft.kind === "pi" || draft.kind === "codex") {
                try {
                    draft.fields.headers = JSON.parse(piHeaders.text || "{}")
                    if (draft.kind === "pi") draft.fields.compat = JSON.parse(piCompat.text || "{}")
                } catch (error) { window.providerFormError = "请求头和兼容参数必须是有效的 JSON 对象"; return null }
                if (draft.fields.headers === null || Array.isArray(draft.fields.headers) || typeof draft.fields.headers !== "object") { window.providerFormError = "请求头必须是 JSON 对象"; return null }
                if (draft.kind === "pi") {
                    if (draft.fields.compat === null || Array.isArray(draft.fields.compat) || typeof draft.fields.compat !== "object") { window.providerFormError = "兼容参数必须是 JSON 对象"; return null }
                }
            }
            if (draft.kind === "codex" && !window.officialProvider) {
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
    function openProviders(kind) { page = 2; providersOpen = true; providerSearch.text = ""; host.loadProviders(kind) }
    function closeProviderEditor() { providerDialog.close() }
    function requestCloseProviderEditor() { if (providerFormDirty) discardProviderDialog.open(); else closeProviderEditor() }
    function setProviderEditorMode(nativeMode) {
        var preview = window.buildProviderDraft(nativeMode)
        if (preview !== null) { window.providerTargetAdvanced = nativeMode; host.previewProvider(preview) }
    }
    function saveProviderEditor() { var draft = buildProviderDraft(!advancedProvider.checked); if (draft !== null) host.saveProvider(draft) }
    function stateText() {
        return ({connected: "已连接", connecting: "正在连接", reconnecting: "正在重连", closed: "连接已断开", stopped: "已暂停", error: "需要处理"})[host.state] || "正在准备"
    }
    onClosing: function(close) { if (trayAvailable) { close.accepted = false; window.hide() } }

    component Field: TextField {
        property bool marksProviderDirty: true
        implicitHeight: 46
        leftPadding: 14; rightPadding: 14
        selectByMouse: true
        color: "#21314d"
        placeholderTextColor: "#98a4b8"
        background: NeuSurface { margin: 0; cornerRadius: 6; inset: true; surface: "#DDE3EF"; focused: parent.activeFocus }
        onTextEdited: if (marksProviderDirty && providerDialog.visible && !window.loadingProviderDraft) window.providerFormDirty = true
    }
    component Heading: Label { font.pixelSize: 20; font.weight: Font.DemiBold; color: "#172a49" }
    component Hint: Label { color: "#73819a"; wrapMode: Text.WordWrap; lineHeight: 1.4; font.pixelSize: 13 }
    component EngravedWordmark: Item {
        id: wordmark
        property alias text: face.text
        readonly property real relief: 1.8
        implicitWidth: face.implicitWidth + relief
        implicitHeight: face.implicitHeight + relief
        // An engraved glyph has a dark upper-left wall and a lit lower-right wall.
        // The darker face keeps the word readable against the same neumorphic panel.
        Label {
            id: darkWall
            x: 0; y: 0
            text: face.text
            color: "#71819A"
            opacity: 0.9
            font: face.font
        }
        Label {
            id: lightWall
            x: wordmark.relief; y: wordmark.relief
            text: face.text
            color: "#FFFFFF"
            opacity: 0.92
            font: face.font
        }
        Label {
            id: face
            x: wordmark.relief / 2; y: wordmark.relief / 2
            text: "Orbis"
            color: "#AAB8CB"
            font.pixelSize: 29
            font.weight: Font.DemiBold
            font.family: "Segoe UI"
        }
    }
    component DialogSurface: Rectangle { color: "#E6EBF4"; radius: 8; border.width: 1; border.color: "#C8D3E2" }
    component SoftDialog: Dialog {
        id: dialog
        palette.window: "#E6EBF4"
        background: DialogSurface {}
        header: Label {
            text: dialog.title; visible: text.length > 0
            padding: 18; bottomPadding: 16
            font.pixelSize: 17; font.weight: Font.DemiBold; color: "#21314d"
            wrapMode: Text.WordWrap
            background: Rectangle {
                color: "transparent"
                Rectangle { anchors.bottom: parent.bottom; anchors.left: parent.left; anchors.right: parent.right; anchors.margins: 1; height: 1; color: "#C8D3E2" }
            }
        }
        footer: SoftDialogButtons { visible: count > 0 }
    }
    component SoftDialogButtons: DialogButtonBox {
        spacing: 14; padding: 18; alignment: Qt.AlignRight
        background: Item {}
        delegate: ActionButton {}
    }
    component SoftDialogActions: Pane {
        id: dialogActions
        default property alias actions: actionRow.data
        spacing: 12; padding: 18
        background: Item {}
        contentItem: RowLayout { id: actionRow; spacing: dialogActions.spacing }
    }
    component SoftSwitch: Switch {
        id: softSwitch
        property bool marksProviderDirty: true
        readonly property string stateLabel: checked ? "开" : "关"
        Accessible.name: (text || "开关") + "，当前状态：" + stateLabel
        onToggled: if (marksProviderDirty && providerDialog.visible && !window.loadingProviderDraft) window.providerFormDirty = true
        spacing: 12
        implicitHeight: 40
        readonly property real knobSize: 34 // fills the groove height, as the reference does
        readonly property real knobRadius: 12 // large radius with a flat edge: the reference thumb is a rounded square, not a circle
        indicator: Item {
            implicitWidth: 80; implicitHeight: 36
            opacity: softSwitch.enabled ? 1 : 0.45
            x: softSwitch.leftPadding
            y: (softSwitch.height - height) / 2
            // Recessed groove: the surface keeps the panel colour, the relief comes from the clipped inner shadow.
            NeuSurface {
                anchors.fill: parent; margin: 0; cornerRadius: 13
                inset: true; depth: 5; focused: softSwitch.activeFocus
            }
            // The two engraved labels keep the available states visible even when the thumb moves.
            Label {
                text: "关"
                x: 9; width: 22; height: parent.height
                verticalAlignment: Text.AlignVCenter; horizontalAlignment: Text.AlignHCenter
                color: softSwitch.checked ? "#9aa7b9" : "#536681"
                font.pixelSize: 12; font.weight: softSwitch.checked ? Font.Normal : Font.DemiBold
            }
            Label {
                text: "开"
                x: parent.width - width - 9; width: 22; height: parent.height
                verticalAlignment: Text.AlignVCenter; horizontalAlignment: Text.AlignHCenter
                color: softSwitch.checked ? "#2459D3" : "#9aa7b9"
                font.pixelSize: 12; font.weight: softSwitch.checked ? Font.DemiBold : Font.Normal
            }
            // Raised knob. The item is inflated by the shadow margin so the blur has room inside its own image.
            Item {
                width: softSwitch.knobSize + 24; height: width
                x: (softSwitch.checked ? indicator.width - softSwitch.knobSize : 0) - 12
                y: (indicator.height - height) / 2
                Behavior on x { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
                NeuSurface { anchors.fill: parent; margin: 12; cornerRadius: softSwitch.knobRadius; surface: softSwitch.checked ? "#EEF4FF" : "#F7F9FD"; depth: softSwitch.checked ? 1.8 : 2.2; blur: 0.55 }
                Label {
                    anchors.centerIn: parent
                    text: softSwitch.stateLabel
                    color: softSwitch.checked ? "#2459D3" : "#536681"
                    font.pixelSize: 12; font.weight: Font.DemiBold
                }
            }
        }
        contentItem: Label { text: softSwitch.text; leftPadding: softSwitch.indicator.width + softSwitch.spacing; verticalAlignment: Text.AlignVCenter; color: softSwitch.enabled ? "#40516c" : "#8995a9" }
    }

    component SoftComboBox: ComboBox {
        id: softCombo
        onActivated: if (providerDialog.visible && !window.loadingProviderDraft) window.providerFormDirty = true
        implicitHeight: 46
        implicitWidth: 180
        leftPadding: 14; rightPadding: 42
        font.pixelSize: 14
        contentItem: TextField {
            text: softCombo.editable ? softCombo.editText : softCombo.displayText
            font: softCombo.font
            color: softCombo.enabled ? "#21314d" : "#8995a9"
            placeholderTextColor: "#98a4b8"
            verticalAlignment: Text.AlignVCenter
            readOnly: !softCombo.editable
            selectByMouse: true
            background: Item {}
            onTextEdited: if (softCombo.editable) softCombo.editText = text
        }
        indicator: Label {
            x: softCombo.width - width - 14; y: (softCombo.height - height) / 2
            width: 20; height: 24
            text: "⌄"
            color: softCombo.enabled ? "#50617b" : "#9aa6b8"
            font.pixelSize: 20; font.family: "Segoe UI Symbol"
            horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter
        }
        background: NeuSurface {
            anchors.fill: parent; margin: 0; cornerRadius: 8
            inset: true; focused: softCombo.activeFocus; surface: "#DDE3EF"
        }
        delegate: ItemDelegate {
            width: softCombo.width - 16; implicitHeight: 40
            highlighted: softCombo.highlightedIndex === index
            contentItem: Text {
                text: modelData && softCombo.textRole ? modelData[softCombo.textRole] : modelData
                color: softCombo.enabled ? "#21314d" : "#8995a9"
                font.pixelSize: 14; verticalAlignment: Text.AlignVCenter
                elide: Text.ElideRight
            }
            background: NeuSurface {
                anchors.fill: parent; margin: 0; cornerRadius: 6
                inset: parent.highlighted || parent.down; surface: "#E6EBF4"
            }
        }
        popup: Popup {
            y: softCombo.height - 1; width: softCombo.width
            padding: 8
            implicitHeight: Math.min(contentItem.implicitHeight + topPadding + bottomPadding, 320)
            contentItem: ListView {
                clip: true
                implicitHeight: Math.min(contentHeight, 304)
                model: softCombo.popup.visible ? softCombo.delegateModel : null
                currentIndex: softCombo.highlightedIndex
                highlightMoveDuration: 0
            }
            background: NeuSurface {
                anchors.fill: parent; anchors.margins: -12; margin: 12
                cornerRadius: 9; surface: "#E6EBF4"; depth: 1.4; blur: 0.9
            }
        }
    }
    component SoftCheckBox: CheckBox {
        id: softCheck
        property bool marksProviderDirty: true
        onToggled: if (marksProviderDirty && providerDialog.visible && !window.loadingProviderDraft) window.providerFormDirty = true
        spacing: 12
        implicitHeight: 38
        indicator: Item {
            implicitWidth: 24; implicitHeight: 24
            x: softCheck.leftPadding; y: (softCheck.height - height) / 2
            opacity: softCheck.enabled ? 1 : 0.5
            NeuSurface {
                anchors.fill: parent; margin: 0; cornerRadius: 7
                inset: !softCheck.checked; depth: softCheck.checked ? 1.3 : 1.0
                blur: 0.8; surface: softCheck.checked ? "#2459D3" : "#DDE3EF"
            }
            Label {
                anchors.fill: parent; visible: softCheck.checked
                text: "✓"; color: "white"; font.pixelSize: 16; font.bold: true
                horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter
            }
        }
        contentItem: Label {
            text: softCheck.text
            leftPadding: softCheck.indicator.width + softCheck.spacing
            verticalAlignment: Text.AlignVCenter
            color: softCheck.enabled ? "#40516c" : "#8995a9"
        }
    }
    component SoftTextArea: TextArea {
        onTextChanged: if (activeFocus && providerDialog.visible && !window.loadingProviderDraft) window.providerFormDirty = true
        implicitHeight: 96
        leftPadding: 14; rightPadding: 14; topPadding: 12; bottomPadding: 12
        selectByMouse: true
        color: "#21314d"
        placeholderTextColor: "#98a4b8"
        background: NeuSurface {
            anchors.fill: parent; margin: 0; cornerRadius: 8
            inset: true; focused: parent.activeFocus; surface: "#DDE3EF"
        }
    }
    component SoftToolButton: ToolButton {
        id: softTool
        implicitWidth: Math.max(42, contentItem.implicitWidth + 20)
        implicitHeight: 42
        hoverEnabled: true
        contentItem: Text {
            text: softTool.text
            font.pixelSize: 18
            horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter
            color: !softTool.enabled ? "#8995a9" : "#253651"
        }
        background: NeuSurface {
            anchors.fill: parent; anchors.margins: -8; margin: 8
            cornerRadius: 7; inset: softTool.down || !softTool.enabled
            focused: softTool.activeFocus; opacity: softTool.enabled ? 1 : 0.6
        }
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
                    EngravedWordmark { text: "Orbis" }
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
                        background: NeuSurface { anchors.fill: parent; anchors.margins: -12; margin: 12; cornerRadius: 6; inset: window.page === index || parent.down; visible: window.page === index || parent.hovered || parent.activeFocus; focused: parent.activeFocus }
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
                Layout.fillWidth: true; Layout.preferredHeight: 82; color: "#E6EBF4"
                Rectangle { anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom; height: 1; color: "#D8E0EC" }
                RowLayout {
                    anchors.fill: parent; anchors.leftMargin: 36; anchors.rightMargin: 36
                    ColumnLayout {
                        spacing: 7
                        Label { text: window.pageNames[window.page]; font.pixelSize: 27; font.weight: Font.DemiBold; color: "#172a49" }
                        Hint { text: ["让电脑上的 Agent，随时与你连接。", "管理这台电脑信任的手机。", "连接你正在使用的 coding agent。", "按照你的工作习惯设置 Orbis。", "了解连接状态，快速定位问题。"][window.page] }
                    }
                    Item { Layout.fillWidth: true }
                    Rectangle {
                        implicitWidth: statusLabel.implicitWidth + 26; implicitHeight: 30; radius: 6
                        color: host.state === "connected" ? "#e1f4ee" : "#e7ecf4"
                        Label { id: statusLabel; anchors.centerIn: parent; text: stateText(); color: host.state === "connected" ? "#278868" : "#677992"; font.pixelSize: 12 }
                    }
                }
            }
            Rectangle {
                visible: host.message.length > 0
                Layout.fillWidth: true; Layout.leftMargin: 36; Layout.rightMargin: 36; Layout.bottomMargin: 16
                implicitHeight: messageLabel.implicitHeight + 24; radius: 6; color: "#e8effd"
                RowLayout {
                    anchors.fill: parent; anchors.margins: 12
                    Label { id: messageLabel; text: host.message; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: "#365485"; font.pixelSize: 13 }
                    SoftToolButton { text: "×"; onClicked: host.clearMessage(); implicitWidth: 30; implicitHeight: 28; Accessible.name: "关闭提示" }
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
                    Item { Layout.preferredHeight: 22 }

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
                                        text: "打开 Pi"
                                        primary: true
                                        enabled: host.bridgeReady && !host.busy && host.agents.some(a => a.kind === "pi" && a.installed)
                                        Accessible.name: "打开 Pi 终端界面"
                                        onClicked: host.openAgentTui("pi")
                                    }
                                    ActionButton {
                                        objectName: "overviewOpenCodexTui"
                                        text: "打开 Codex"
                                        primary: true
                                        enabled: host.bridgeReady && !host.busy && host.agents.some(a => a.kind === "codex" && a.installed)
                                        Accessible.name: "打开 Codex 终端界面"
                                        onClicked: host.openAgentTui("codex")
                                    }
                                    ActionButton {
                                        objectName: "overviewOpenDsh"
                                        text: "打开 DeepSeek Harness"
                                        primary: true
                                        enabled: host.bridgeReady && !host.busy && host.agents.some(a => a.kind === "dsh" && a.installed)
                                        Accessible.name: "打开 DeepSeek Harness 网页工作台"
                                        onClicked: host.openAgent("dsh")
                                    }
                                    Item { Layout.fillWidth: true }
                                }
                                Hint { text: "Pi 和 Codex 会先让你选择工作区，DeepSeek 使用网页工作台。按钮不可用时，请到 Agent 页检测或安装。模型登录可在供应商配置或已打开的 agent 终端中完成。"; Layout.fillWidth: true; font.pixelSize: 11 }
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
                            ActionButton { text: "全部更新到最新（" + host.agents.filter(a => !a.installed || a.updateAvailable || a.installedButBroken).length + "）"; enabled: host.bridgeReady && !host.busy && host.agents.some(a => !a.installed || a.updateAvailable || a.installedButBroken); onClicked: window.showAgentBatch() }
                            Item { Layout.fillWidth: true }
                        }
                        RowLayout { visible: host.agentInstalling; Layout.fillWidth: true
                            BusyIndicator { running: visible; Layout.preferredWidth: 30; Layout.preferredHeight: 30 }
                            Hint { text: window.agentName(host.agentInstallKind) + " · " + window.installationStage() + " · " + host.agentInstallVersion; Layout.fillWidth: true }
                            ActionButton { text: "取消安装"; enabled: host.bridgeReady && host.agentInstallStage !== "cancelling" && host.agentInstallStage !== "restarting"; danger: true; onClicked: host.cancelInstall() }
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
                                    Hint { visible: !!modelData.error || !!modelData.latestError; text: modelData.error || modelData.latestError || ""; Layout.fillWidth: true; color: "#b46b19" }
                                    Hint { visible: !!modelData.compatibilityNote; text: modelData.compatibilityNote || ""; Layout.fillWidth: true }
                                    RowLayout {
                                        spacing: 10
                                        ActionButton { text: modelData.installedButBroken ? "修复到最新版本" : !modelData.installed ? "安装最新版本" : !modelData.latestVersion || modelData.updateAvailable ? "更新到最新版本" : "已是最新版本"; enabled: host.bridgeReady && !host.busy && (!modelData.installed || !modelData.latestVersion || modelData.updateAvailable || modelData.installedButBroken); onClicked: window.showAgentInstaller(modelData) }
                                        ActionButton { text: "供应商配置"; enabled: host.bridgeReady && !host.busy; onClicked: window.openProviders(modelData.kind) }
                                    }
                                }
                            }
                        }
                        Hint { text: "在供应商配置中添加 API 地址、密钥与模型，并在 Host 或 APP 启用。原生账号登录可在供应商配置（Codex 的「账号管理」）或已打开的 agent 终端中完成。安装更新前请先暂停 Host。"; Layout.fillWidth: true }
                        Hint { visible: host.busy && !host.agentInstalling; text: "正在检测 Agent，请稍候…"; Layout.fillWidth: true }
                    }

                    ColumnLayout {
                        visible: window.page === 2 && window.providersOpen; Layout.fillWidth: true; spacing: 16
                        RowLayout {
                            Layout.fillWidth: true
                            ActionButton { text: "‹ Agent"; onClicked: window.providersOpen = false }
                            Heading { text: ({pi: "Pi", codex: "Codex", dsh: "DeepSeek Harness"})[host.providerKind] + " · 供应商" }
                            Item { Layout.fillWidth: true }
                        }
                        Flow {
                            Layout.fillWidth: true; spacing: 14
                            ActionButton { text: "刷新"; enabled: !host.busy; onClicked: host.loadProviders(host.providerKind) }
                            ActionButton { text: "通用配置"; visible: host.providerKind === "codex"; enabled: !host.busy; onClicked: host.loadCodexPreferences() }
                            ActionButton { text: "账号管理"; visible: host.providerKind === "codex"; enabled: !host.busy; onClicked: { host.clearMessage(); host.oauthAccount("list"); oauthDialog.open() } }
                            ActionButton { text: "＋ 添加供应商"; primary: true; enabled: !host.busy; onClicked: host.editProvider("") }
                        }
                        RowLayout { Layout.fillWidth: true
                            Field { id: providerSearch; objectName: "providerSearch"; Layout.fillWidth: true; placeholderText: "搜索名称、标识、备注或网站"; Accessible.name: "搜索供应商" }
                            Hint { text: String(window.visibleProviders.length) + " / " + host.providers.length }
                        }
                        Hint { Layout.fillWidth: true; text: host.providerKind === "pi" ? "Pi 可同时启用多个供应商。刷新会同步 models.json 中的显式配置；移除保留卡片，不更改原生登录与默认模型。拖动卡片左侧手柄调整顺序。" : "保存未启用的配置不会切换当前供应商。点击“启用”后生效；已有会话和独立终端需重新打开。拖动左侧手柄调整顺序。" }
                        Card {
                            visible: host.providers.length === 0; Layout.fillWidth: true
                            ColumnLayout { anchors.fill: parent; spacing: 12
                                Heading { text: "添加第一个供应商" }
                                Hint { text: "支持自定义兼容 API，以及高级原生配置。已有本机配置会自动导入。"; Layout.fillWidth: true }
                            }
                        }
                        Hint { visible: host.providers.length > 0 && window.visibleProviders.length === 0; text: "没有匹配的供应商"; Layout.fillWidth: true }
                        Repeater {
                            model: window.visibleProviders
                            delegate: Card {
                                id: providerCard
                                required property var modelData
                                required property int index
                                Layout.fillWidth: true
                                contentHeight: providerCardContent.implicitHeight
                                Rectangle { anchors.fill: parent; color: "transparent"; border.color: "#2459D3"; border.width: 2; radius: 7; visible: providerDrop.containsDrag }
                                DropArea { id: providerDrop; anchors.fill: parent; keys: ["provider-card"]; enabled: !host.busy && providerSearch.text.trim().length === 0
                                    onDropped: function(drop) { window.moveProvider(window.draggedProviderId, providerCard.modelData.id); drop.acceptProposedAction() }
                                }
                                ColumnLayout { id: providerCardContent; anchors.fill: parent; spacing: 12
                                  RowLayout { Layout.fillWidth: true; spacing: 12
                                    Item { Layout.preferredWidth: 30; Layout.preferredHeight: 40
                                        Label { id: providerDrag; objectName: "providerDragHandle-" + modelData.id; anchors.centerIn: parent; text: "⠿"; font.pixelSize: 24; color: dragMouse.enabled ? "#627591" : "#a5afbf"
                                            Drag.active: dragMouse.drag.active; Drag.source: providerCard; Drag.keys: ["provider-card"]; Drag.hotSpot.x: width / 2; Drag.hotSpot.y: height / 2
                                            MouseArea { id: dragMouse; anchors.fill: parent; enabled: !host.busy && providerSearch.text.trim().length === 0; cursorShape: Qt.OpenHandCursor; drag.target: providerDrag
                                                onPressed: { window.draggedProviderId = modelData.id; providerDrag.anchors.centerIn = undefined }
                                                onReleased: { providerDrag.Drag.drop(); providerDrag.anchors.centerIn = providerDrag.parent; window.draggedProviderId = "" }
                                                onCanceled: { providerDrag.anchors.centerIn = providerDrag.parent; window.draggedProviderId = "" }
                                            }
                                        }
                                    }
                                    ColumnLayout { Layout.fillWidth: true
                                        Heading { text: modelData.name; font.pixelSize: 18; Layout.fillWidth: true; elide: Text.ElideRight }
                                        Hint { text: (modelData.enabled ? (modelData.mode === "additive" ? "已启用" : "当前使用") : "未启用") + (modelData.globalDefault ? " · Pi 全局默认" : ""); color: modelData.enabled ? "#278868" : "#73819a" }
                                        Hint { text: modelData.notes || ""; visible: text.length > 0; Layout.fillWidth: true }
                                    }
                                    ActionButton { text: modelData.enabled ? (modelData.mode === "additive" ? "移除" : "已在用") : "启用"; primary: !modelData.enabled; enabled: !host.busy && (!modelData.enabled || modelData.mode === "additive"); onClicked: { if (modelData.enabled) { window.removeProviderId = modelData.id; removeProviderDialog.open() } else host.switchProvider(modelData.id, true) } }
                                    ActionButton { text: "编辑"; enabled: !host.busy; onClicked: host.editProvider(modelData.id) }
                                    ActionButton { text: "复制"; enabled: !host.busy; onClicked: host.copyProvider(modelData.id) }
                                    ActionButton { text: "删除"; danger: true; enabled: !host.busy && (!modelData.enabled || modelData.mode === "additive"); onClicked: { window.deleteProviderId = modelData.id; deleteProviderDialog.open() } }
                                  }
                                  RowLayout { Layout.fillWidth: true; spacing: 10
                                    Hint { text: modelData.websiteUrl || modelData.id; Layout.fillWidth: true }
                                    ActionButton { text: host.checkingProviderIds.indexOf(modelData.id) >= 0 ? "检测中…" : "检测连通"; visible: modelData.category !== "official"; enabled: !host.busy && host.checkingProviderIds.indexOf(modelData.id) < 0; onClicked: host.checkProvider(modelData.id) }
                                    SoftToolButton { text: "↑"; enabled: !host.busy && providerSearch.text.trim().length === 0 && index > 0; onClicked: window.moveProvider(modelData.id, window.visibleProviders[index - 1].id); ToolTip.visible: hovered; ToolTip.text: "上移" }
                                    SoftToolButton { text: "↓"; enabled: !host.busy && providerSearch.text.trim().length === 0 && index + 1 < window.visibleProviders.length; onClicked: window.moveProvider(modelData.id, window.visibleProviders[index + 1].id); ToolTip.visible: hovered; ToolTip.text: "下移" }
                                  }
                                }
                            }
                        }
                        Hint { visible: host.busy; text: "正在处理供应商配置…"; Layout.fillWidth: true }
                    }

                    Card {
                        id: settingsPane
                        visible: window.page === 3; Layout.fillWidth: true
                        function load() { relayField.text = host.relayUrl; nameField.text = host.hostName; dshWebUrlField.text = host.dshWebUrl; startupSwitch.checked = host.autoStart; codexSwitch.checked = host.codexEnabled; dshSwitch.checked = host.dshEnabled }
                        ColumnLayout {
                            anchors.fill: parent; spacing: 15
                            Heading { text: "常规" }
                            Label { text: "电脑名称"; color: "#4b5d78" }
                            Field { id: nameField; Layout.fillWidth: true; maximumLength: 80 }
                            SoftSwitch { id: startupSwitch; text: "登录 Windows 后自动启动" }
                            SoftSwitch { id: codexSwitch; text: "启动 Host 时启用 Codex" }
                            SoftSwitch { id: dshSwitch; text: "启动 Host 时启用 DeepSeek Harness" }
                            RowLayout {
                                visible: host.agents.some(a => a.kind === "codex" && a.terminalNeedsElevation === true)
                                Layout.fillWidth: true; spacing: 12
                                Hint { text: "系统 PATH 里其他 codex 抢先于 Orbis，终端接入无法生效。修复需要一次管理员确认，完成后请重新打开终端。"; Layout.fillWidth: true; color: "#b46b19" }
                                ActionButton { text: "修复终端接入"; primary: true; enabled: host.bridgeReady && !host.busy; onClicked: host.enableCodexTerminal() }
                            }
                            Heading { text: "中继服务器"; Layout.topMargin: 10 }
                            Field { id: relayField; Layout.fillWidth: true; placeholderText: "wss://服务器地址/relay" }
                            Hint { text: "支持默认中继或自建中继。更换服务器后需按新服务器设置重新激活，并为手机重新配对。"; Layout.fillWidth: true }
                            Label { text: "DeepSeek Web 启动链接（可选）"; color: "#4b5d78" }
                            Field { id: dshWebUrlField; Layout.fillWidth: true; echoMode: TextInput.PasswordEchoOnEdit; placeholderText: "http://127.0.0.1:3080/?token=..."; Accessible.name: "DeepSeek Web 启动链接" }
                            ActionButton { text: "保存设置"; primary: true; enabled: host.bridgeReady && !host.busy; onClicked: host.saveSettings(relayField.text, startupSwitch.checked, codexSwitch.checked, nameField.text, dshSwitch.checked, dshWebUrlField.text) }
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
                                SoftTextArea { text: host.logs || "暂无日志"; readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap; color: "#50617b"; font.family: "Consolas"; font.pixelSize: 12; Layout.fillWidth: true }
                            }
                        }
                    }
                    Item { Layout.preferredHeight: 30 }
                }
            }
        }
    }
    SoftDialog {
        id: pairDialog
        title: "用手机扫描二维码"
        anchors.centerIn: parent
        width: 430
        modal: true
        footer: SoftDialogButtons { ActionButton { text: "关闭"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } onRejected: pairDialog.reject() }
        onRejected: host.cancelPair()
        ColumnLayout {
            width: parent.width; spacing: 16
            Image { source: host.qr; Layout.preferredWidth: 300; Layout.preferredHeight: 300; Layout.alignment: Qt.AlignHCenter }
            Label { text: "二维码将在 " + host.pairSeconds + " 秒后失效"; Layout.alignment: Qt.AlignHCenter; color: "#60728e" }
            Hint { text: "在 Orbis Android 中选择“扫码配对”。二维码仅可使用一次。"; Layout.fillWidth: true }
        }
    }
    SoftDialog {
        id: revokeDialog; title: "撤销这台手机的配对？"; anchors.centerIn: parent; modal: true; width: 410
        footer: SoftDialogButtons { ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } ActionButton { text: "撤销配对"; danger: true; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole } onAccepted: revokeDialog.accept(); onRejected: revokeDialog.reject() }
        Label { width: parent.width; text: "连接会立即失效。再次使用时，需要重新扫码配对。"; wrapMode: Text.WordWrap }
        onAccepted: host.revoke(window.revokeId)
    }
    SoftDialog {
        id: installDialog; title: (window.installAgentData.installed ? "更新 " : "安装 ") + window.agentName(window.installKind) + " 到最新版本"; anchors.centerIn: parent; modal: true; width: 540
        footer: SoftDialogButtons { ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } ActionButton { text: window.installAgentData.installed ? "更新到最新版本" : "安装最新版本"; enabled: window.canInstallAgents && !host.busy; primary: true; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole } onAccepted: installDialog.accept(); onRejected: installDialog.reject() }
        ColumnLayout { width: parent.width; spacing: 12
            Hint { text: "当前 " + (window.installAgentData.version || "未安装") + " · 最新 " + (window.installAgentData.latestVersion || "未知"); Layout.fillWidth: true }
            Hint { visible: !!window.installAgentData.compatibilityNote; text: window.installAgentData.compatibilityNote || ""; Layout.fillWidth: true }
            Hint { text: "Orbis 会自动下载、验证并使用最新兼容版本。安装前请先关闭使用该 Agent 的终端。"; Layout.fillWidth: true }
            Hint { visible: window.installKind === "dsh"; text: "更新成功后会自动重启 Orbis 启动的 DeepSeek 网页后台，中断网页连接及运行中的任务。完成后请从 Host 重新打开网页；手动接入的服务需自行重启。"; Layout.fillWidth: true }
            Hint { visible: !window.canInstallAgents; text: "请先在概览中暂停 Host，再开始安装。暂停会中断连接及运行中的会话。"; Layout.fillWidth: true; color: "#b46b19" }
        }
        onAccepted: host.updateAgent(window.installKind)
    }
    SoftDialog {
        id: batchInstallDialog; title: "全部更新到最新版本"; anchors.centerIn: parent; modal: true; width: 540
        footer: SoftDialogButtons { ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } ActionButton { text: "全部更新到最新版本"; primary: true; enabled: window.canInstallAgents && !host.busy; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole } onAccepted: batchInstallDialog.accept(); onRejected: batchInstallDialog.reject() }
        ColumnLayout { width: parent.width; spacing: 12
            Hint { text: "逐个下载、验证并使用每个 Agent 的最新兼容版本；一个失败后会继续其余项目。"; Layout.fillWidth: true }
            Hint { text: "DeepSeek 更新成功后会自动重启 Orbis 启动的网页后台，中断网页连接及运行中的任务。完成后请从 Host 重新打开网页；手动接入的服务需自行重启。"; Layout.fillWidth: true }
            Repeater { model: host.agents.filter(a => !a.installed || a.updateAvailable || a.installedButBroken); delegate: Hint { required property var modelData; text: window.agentName(modelData.kind) + " → 最新兼容版本"; Layout.fillWidth: true } }
            Hint { visible: !window.canInstallAgents; text: "请先在概览中暂停 Host；暂停会中断连接及运行中的会话。"; Layout.fillWidth: true; color: "#b46b19" }
        }
        onAccepted: host.installAllAgents("update")
    }
    SoftDialog {
        id: providerDialog; title: window.providerDraft.create ? "添加供应商" : "编辑供应商"
        anchors.centerIn: parent; modal: true; width: Math.min(900, window.width - 64); height: window.height - 64
        closePolicy: Popup.NoAutoClose
        onOpened: providerFormScroll.contentItem.contentY = 0
        contentItem: ScrollView {
            id: providerFormScroll; objectName: "providerFormScroll"
            clip: true
            contentWidth: availableWidth
            ColumnLayout { width: providerDialog.width - 48; spacing: 14
                ColumnLayout { visible: !!window.providerDraft.create && window.providerDraft.kind !== "dsh"; Layout.fillWidth: true; spacing: 10
                    RowLayout { Layout.fillWidth: true
                        Heading { text: "选择预设或自定义"; font.pixelSize: 17; Layout.fillWidth: true }
                        ActionButton { text: presetExpanded.checked ? "收起预设" : "更换预设"; onClicked: presetExpanded.checked = !presetExpanded.checked }
                    }
                    SoftSwitch { id: presetExpanded; marksProviderDirty: false; visible: false }
                    Hint { visible: !presetExpanded.checked; text: window.providerDraft.presetId === "custom" ? "当前：自定义" : "当前：" + window.providerDraft.name; Layout.fillWidth: true }
                    Field { id: presetSearch; marksProviderDirty: false; visible: presetExpanded.checked; Layout.fillWidth: true; placeholderText: "搜索供应商预设" }
                    ScrollView { id: presetPicker; visible: presetExpanded.checked; Layout.fillWidth: true; Layout.preferredHeight: 158; clip: true; contentWidth: availableWidth; ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
                        Flow { width: presetPicker.availableWidth; spacing: 10
                            ActionButton { text: "自定义"; primary: window.providerDraft.presetId === "custom"; enabled: !host.busy; onClicked: window.changePreset("custom") }
                            Repeater { model: host.providerPresets.filter(function(p) { return ProviderFlow.matchesProvider(p, presetSearch.text) })
                                delegate: ActionButton { required property var modelData; text: modelData.name; primary: window.providerDraft.presetId === modelData.id; enabled: !host.busy && !modelData.requiresOAuth; onClicked: window.changePreset(modelData.id); ToolTip.visible: hovered; ToolTip.text: modelData.requiresOAuth ? "此预设需要尚未接入的登录方式" : modelData.requiresProxy ? "需要已配置的 Codex 本地 API 转换" : (modelData.category || "自定义") }
                            }
                        }
                    }
                    Hint { text: "预设会填写接口、地址和模型；选择后补充密钥即可。更换预设前会确认未保存的修改。"; Layout.fillWidth: true }
                    Rectangle { Layout.fillWidth: true; height: 1; color: "#C8D3E2" }
                }
                Label { text: "名称"; color: "#4b5d78" }
                Field { id: providerName; objectName: "providerName"; Layout.fillWidth: true; maximumLength: 80; placeholderText: "例如：工作账号 / 自建 API" }
                Label { text: "供应商标识"; visible: window.providerDraft.kind === "pi" || providerDetails.checked; color: "#4b5d78" }
                Field { id: providerKey; visible: window.providerDraft.kind === "pi" || providerDetails.checked; Layout.fillWidth: true; maximumLength: 128; placeholderText: "custom"; enabled: window.providerDraft.kind !== "pi" || !!window.providerDraft.create }
                Hint { visible: window.providerDraft.kind === "pi"; text: window.providerDraft.create ? "标识对应 models.json 的节点；保存后不可修改。" : "标识固定；修改名称不会更改模型引用。"; Layout.fillWidth: true }
                Label { text: "ChatGPT 登录来源"; visible: window.officialProvider; color: "#4b5d78" }
                SoftComboBox { id: providerAccount; visible: window.officialProvider; Layout.fillWidth: true; textRole: "label"; valueRole: "id"; model: [] }
                RowLayout { visible: window.officialProvider; Layout.fillWidth: true
                    Hint { text: "官方登录不需要填写 API Key 或接口地址。可跟随本机 Codex 登录，或绑定托管账号。"; Layout.fillWidth: true }
                    ActionButton { text: "管理账号"; enabled: !host.busy; onClicked: { host.oauthAccount("list"); oauthDialog.open() } }
                }
                SoftSwitch { id: providerDetails; marksProviderDirty: false; text: "显示其他信息与高级标识" }
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
                RowLayout { visible: window.providerDraft.kind === "codex"; Layout.fillWidth: true
                    SoftSwitch { id: providerCommon; text: "使用 Codex 通用配置" }
                    Item { Layout.fillWidth: true }
                    ActionButton { text: "编辑通用配置"; enabled: !host.busy; onClicked: host.loadCodexPreferences() }
                }
                SoftSwitch { id: advancedProvider; marksProviderDirty: false; objectName: "providerNativeMode"; text: "编辑原生配置（保留全部字段）"; enabled: !host.busy && !window.providerDraft.nativeOnly; onToggled: {
                    var target = checked
                    checked = !target
                    window.setProviderEditorMode(target)
                } }
                Hint { visible: !!window.providerDraft.nativeOnly; text: "此配置使用原生专有字段或 YAML 标签，请在原生编辑器中修改。"; Layout.fillWidth: true }
                ColumnLayout { visible: !advancedProvider.checked; Layout.fillWidth: true; spacing: 12
                    Label { text: "API 地址"; visible: !window.officialProvider; color: "#4b5d78" }
                    Field { id: providerUrl; objectName: "providerUrl"; visible: !window.officialProvider; Layout.fillWidth: true; placeholderText: "例如 https://api.example.com/v1" }
                    Label { text: "API Key / 凭据"; visible: !window.officialProvider; color: "#4b5d78" }
                    Field { id: providerApiKey; objectName: "providerApiKey"; visible: !window.officialProvider; Layout.fillWidth: true; placeholderText: "API Key；已有环境变量认证会保留"; echoMode: TextInput.PasswordEchoOnEdit }
                    Label { text: "默认模型"; visible: window.providerDraft.kind !== "pi"; color: "#4b5d78" }
                    RowLayout { visible: window.providerDraft.kind !== "pi"; Layout.fillWidth: true; spacing: 12
                        Field { id: providerModel; objectName: "providerDefaultModel"; Layout.fillWidth: true; placeholderText: "填写模型 ID，或从模型列表选择" }
                        ActionButton { objectName: "fetchDefaultModel"; text: host.providerModelsLoading ? "获取中…" : "获取模型列表"; visible: window.providerDraft.kind === "codex" && !window.officialProvider; enabled: !host.busy && !host.providerModelsLoading && providerUrl.text.trim().length > 0; onClicked: window.requestProviderModels(-2) }
                    }
                    RowLayout { visible: window.providerDraft.kind === "codex"; Layout.fillWidth: true
                        Label { text: "思考档位"; color: "#4b5d78" }
                        SoftComboBox { id: codexReasoning; objectName: "codexReasoning"; Layout.fillWidth: true; model: ["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] }
                    }
                    Label { text: "接口格式"; visible: !window.officialProvider; color: "#4b5d78" }
                    SoftComboBox { id: providerApi; visible: !window.officialProvider; Layout.fillWidth: true; model: [] }
                    Hint { visible: window.providerDraft.kind === "codex" && !window.officialProvider && providerApi.currentText !== "openai-responses"; text: "此接口格式需要已有的 Codex 本地 API 转换配置；未配置时可以保存，不能直接启用。"; Layout.fillWidth: true }
                    SoftSwitch { id: providerProxyDetails; marksProviderDirty: false; text: "接口兼容与推理参数"; visible: window.providerDraft.kind === "codex" && !window.officialProvider }
                    ColumnLayout { visible: window.providerDraft.kind === "codex" && providerProxyDetails.checked; Layout.fillWidth: true; spacing: 8
                        SoftSwitch { id: providerFullUrl; text: "使用完整 API 端点地址" }
                        RowLayout { Layout.fillWidth: true
                            Label { text: "会话缓存路由"; color: "#4b5d78" }
                            SoftComboBox { id: providerCache; Layout.fillWidth: true; textRole: "label"; valueRole: "value"; model: [{label:"自动",value:"auto"},{label:"启用",value:"enabled"},{label:"禁用",value:"disabled"}] }
                        }
                        SoftSwitch { id: providerReasoningAuto; text: "自动识别推理参数" }
                        GridLayout { visible: !providerReasoningAuto.checked; columns: 2; Layout.fillWidth: true
                            SoftCheckBox { id: providerThinking; text: "支持思考开关" }
                            SoftCheckBox { id: providerEffort; text: "支持思考档位" }
                            Label { text: "思考开关参数"; color: "#4b5d78" }
                            SoftComboBox { id: providerThinkingParam; Layout.fillWidth: true; model: ["thinking", "enable_thinking", "reasoning_split", "none"] }
                            Label { text: "档位参数"; color: "#4b5d78" }
                            SoftComboBox { id: providerEffortParam; Layout.fillWidth: true; model: ["reasoning_effort", "reasoning.effort", "none"] }
                            Label { text: "档位映射"; color: "#4b5d78" }
                            SoftComboBox { id: providerEffortMode; Layout.fillWidth: true; model: ["passthrough", "deepseek", "low_high", "openrouter", "zen"] }
                        }
                        Label { text: "Chat 兼容参数（JSON）"; color: "#4b5d78" }
                        SoftTextArea { id: providerChatOptions; Layout.fillWidth: true; Layout.preferredHeight: 64; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas" }
                        Label { text: "请求覆盖（headers / body）"; color: "#4b5d78" }
                        SoftTextArea { id: providerRequestOverrides; Layout.fillWidth: true; Layout.preferredHeight: 90; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas" }
                    }
                    SoftSwitch { id: providerTransportDetails; marksProviderDirty: false; text: "请求头与兼容配置"; visible: !window.officialProvider && window.providerDraft.kind !== "dsh" }
                    Label { text: "请求头（JSON 对象）"; visible: providerTransportDetails.visible && providerTransportDetails.checked; color: "#4b5d78" }
                    SoftTextArea { id: piHeaders; visible: providerTransportDetails.visible && providerTransportDetails.checked; Layout.fillWidth: true; Layout.preferredHeight: 64; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas" }
                    ColumnLayout { visible: window.providerDraft.kind === "pi" || window.providerDraft.kind === "dsh"; Layout.fillWidth: true; spacing: 8
                        Label { text: "兼容参数（JSON 对象）"; visible: window.providerDraft.kind === "pi" && providerTransportDetails.checked; color: "#4b5d78" }
                        SoftTextArea { id: piCompat; visible: window.providerDraft.kind === "pi" && providerTransportDetails.checked; Layout.fillWidth: true; Layout.preferredHeight: 64; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas" }
                        RowLayout { Layout.fillWidth: true
                            Label { text: "模型目录"; color: "#4b5d78"; font.bold: true }
                            Item { Layout.fillWidth: true }
                            ActionButton { objectName: "fetchCatalogModels"; text: host.providerModelsLoading ? "获取中…" : "获取模型列表"; enabled: !host.busy && !host.providerModelsLoading && providerUrl.text.trim().length > 0; onClicked: window.requestProviderModels(-1) }
                            ActionButton { text: "＋ 添加模型"; enabled: !host.providerModelsLoading; onClicked: window.addProviderModel() }
                        }
                        Hint { Layout.fillWidth: true; text: "可手填模型 ID，或获取列表后选择。新模型会填入可修改的默认能力参数，请按供应商实际能力调整。" }
                        Repeater { model: window.providerModels
                            delegate: ColumnLayout {
                                required property var modelData
                                required property int index
                                Layout.fillWidth: true; spacing: 6
                                RowLayout { Layout.fillWidth: true
                                    Field { id: modelIdField; Layout.fillWidth: true; text: modelData.id || ""; placeholderText: "模型 ID"; onTextEdited: window.updateProviderModel(index, "id", text) }
                                    ActionButton { objectName: "selectCatalogModel-" + index; text: "从列表选择"; enabled: !host.busy && !host.providerModelsLoading && providerUrl.text.trim().length > 0; onClicked: window.requestProviderModels(index) }
                                    Field { Layout.fillWidth: true; text: modelData.name || modelIdField.text; placeholderText: "显示名称（默认同模型 ID）"; onTextEdited: window.updateProviderModel(index, "name", text) }
                                    ActionButton { text: providerModel.text === modelIdField.text && !!modelIdField.text ? "默认" : "设为默认"; visible: window.providerDraft.kind === "dsh"; enabled: !!modelIdField.text && providerModel.text !== modelIdField.text; onClicked: { providerModel.text = modelIdField.text; window.providerFormDirty = true } }
                                    ActionButton { text: "删除"; danger: true; enabled: !host.providerModelsLoading; onClicked: window.deleteProviderModel(index) }
                                }
                                RowLayout { Layout.fillWidth: true
                                    SoftCheckBox { text: "推理"; visible: window.providerDraft.kind === "pi"; checked: modelData.reasoning === true; onToggled: window.updateProviderModel(index, "reasoning", checked) }
                                    SoftCheckBox { text: "图像输入"; checked: Array.isArray(modelData.input) && modelData.input.indexOf("image") >= 0; onToggled: window.updateProviderModel(index, "input", checked ? ["text", "image"] : ["text"]) }
                                    Label { text: "上下文"; color: "#4b5d78" }
                                    Field { Layout.fillWidth: true; text: modelData.contextWindow === undefined ? "" : String(modelData.contextWindow); placeholderText: window.providerDraft.kind === "pi" ? "128000" : window.providerDraft.kind === "dsh" ? "262144" : "继承原生默认"; inputMethodHints: Qt.ImhDigitsOnly; onTextEdited: window.updateProviderModel(index, "contextWindow", text) }
                                    Label { text: "最大输出"; color: "#4b5d78" }
                                    Field { Layout.fillWidth: true; text: modelData.maxTokens === undefined ? "" : String(modelData.maxTokens); placeholderText: window.providerDraft.kind === "pi" ? "16384" : window.providerDraft.kind === "dsh" ? "32768" : "继承原生默认"; inputMethodHints: Qt.ImhDigitsOnly; onTextEdited: window.updateProviderModel(index, "maxTokens", text) }
                                }
                                SoftTextArea { visible: window.providerDraft.kind === "pi"; Layout.fillWidth: true; Layout.preferredHeight: 58; placeholderText: "思考档位映射（留空使用 Pi 默认值）"; text: modelData.thinkingLevelMap === undefined ? "" : JSON.stringify(modelData.thinkingLevelMap); selectByMouse: true; wrapMode: TextEdit.Wrap; onTextChanged: if (activeFocus) window.updateProviderModel(index, "thinkingLevelMap", text) }
                                Label { visible: window.providerDraft.kind === "dsh"; text: "推理档位映射（JSON；false 表示不支持，留空继承原生能力）"; color: "#4b5d78" }
                                SoftTextArea { visible: window.providerDraft.kind === "dsh"; Layout.fillWidth: true; Layout.preferredHeight: 58; placeholderText: "例如 {\"medium\":\"medium\",\"high\":\"high\"}"; text: modelData.reasoningEfforts === undefined ? "" : JSON.stringify(modelData.reasoningEfforts); selectByMouse: true; wrapMode: TextEdit.Wrap; onTextChanged: if (activeFocus) window.updateProviderModel(index, "reasoningEfforts", text) }
                            }
                        }
                    }
                }
                ColumnLayout { visible: advancedProvider.checked; Layout.fillWidth: true; spacing: 10
                    Hint { text: window.providerDraft.kind === "codex" ? "Codex 的 auth.json、config.toml 和其他字段分别编辑，保存时会还原为原生配置对象。" : window.providerDraft.kind === "dsh" ? "DSH 的 patch YAML、环境变量和其他字段分别编辑，保存时会还原为原生配置对象。" : "Pi：完整的 models.json.providers.<标识> 节点。"; Layout.fillWidth: true }
                    ColumnLayout { visible: window.providerDraft.kind === "codex"; Layout.fillWidth: true; spacing: 8
                        Label { text: "auth.json（JSON 对象或 null）"; color: "#4b5d78" }
                        SoftTextArea { id: providerAuthJson; Layout.fillWidth: true; Layout.preferredHeight: 100; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas" }
                        Label { text: "config.toml（原文）"; color: "#4b5d78" }
                        SoftTextArea { id: providerConfigToml; Layout.fillWidth: true; Layout.preferredHeight: 250; selectByMouse: true; wrapMode: TextEdit.NoWrap; font.family: "Consolas" }
                        Label { text: "其他字段（JSON 对象，可留空）"; color: "#4b5d78" }
                        SoftTextArea { id: codexExtraJson; Layout.fillWidth: true; Layout.preferredHeight: 100; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas" }
                    }
                    ColumnLayout { visible: window.providerDraft.kind === "dsh"; Layout.fillWidth: true; spacing: 8
                        Label { text: "cordis.patch.yml（原文）"; color: "#4b5d78" }
                        SoftTextArea { id: providerPatchYaml; Layout.fillWidth: true; Layout.preferredHeight: 220; selectByMouse: true; wrapMode: TextEdit.NoWrap; font.family: "Consolas" }
                        Label { text: "环境变量（JSON 对象）"; color: "#4b5d78" }
                        SoftTextArea { id: providerEnvJson; Layout.fillWidth: true; Layout.preferredHeight: 100; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas" }
                        Label { text: "其他字段（JSON 对象，可留空）"; color: "#4b5d78" }
                        SoftTextArea { id: dshExtraJson; Layout.fillWidth: true; Layout.preferredHeight: 100; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas" }
                    }
                    ColumnLayout { visible: window.providerDraft.kind === "pi"; Layout.fillWidth: true
                        Hint { text: "Pi：完整的 models.json.providers.<标识> 节点。"; Layout.fillWidth: true }
                        SoftTextArea { id: providerJson; Layout.fillWidth: true; Layout.preferredHeight: 230; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas"; color: "#21314d" }
                    }
                }
                Hint { visible: host.message.length > 0; text: host.message; Layout.fillWidth: true; color: "#a34d4d" }
                Hint { visible: window.providerFormError.length > 0; text: window.providerFormError; Layout.fillWidth: true; color: "#a34d4d" }
            }
        }
        footer: SoftDialogActions {
            spacing: 12
            Item { Layout.fillWidth: true }
            ActionButton { text: "取消"; enabled: !host.busy; onClicked: window.requestCloseProviderEditor() }
            ActionButton { text: host.busy ? "保存中…" : "保存"; primary: true; enabled: !host.busy && providerName.text.trim().length > 0; onClicked: {
                window.saveProviderEditor()
            } }
        }
        onClosed: { window.providerFormDirty = false; fetchedModelsDialog.close(); window.fetchedModels = []; window.modelRequestConfig = ""; providerApiKey.text = ""; providerJson.text = ""; providerAuthJson.text = ""; providerConfigToml.text = ""; providerPatchYaml.text = ""; providerEnvJson.text = ""; codexExtraJson.text = ""; dshExtraJson.text = ""; window.providerDraft = ({}) }
    }
    SoftDialog {
        id: changePresetDialog; title: "更换预设？"; anchors.centerIn: parent; modal: true; width: 430
        Label { width: parent.width; text: "更换预设会丢弃当前表单未保存的修改。"; wrapMode: Text.WordWrap }
        standardButtons: Dialog.Cancel | Dialog.Ok
        onAccepted: host.presetProvider(window.pendingPresetId)
    }
    SoftDialog {
        id: discardProviderDialog; title: "放弃修改？"; anchors.centerIn: parent; modal: true; width: 430
        Label { width: parent.width; text: "供应商配置尚未保存。关闭后将丢弃本次修改。"; wrapMode: Text.WordWrap }
        standardButtons: Dialog.Cancel | Dialog.Discard
        onDiscarded: { discardProviderDialog.close(); window.closeProviderEditor() }
    }
    SoftDialog {
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
    SoftDialog {
        id: oauthDeleteDialog; property string accountId: ""; title: "删除托管账号？"; anchors.centerIn: parent; modal: true; width: 420
        Label { width: parent.width; text: "删除 Host 保存的登录凭据。仍被供应商绑定的账号需要先解除绑定。"; wrapMode: Text.WordWrap }
        standardButtons: Dialog.Cancel | Dialog.Ok
        onAccepted: host.oauthAccount("remove", accountId)
    }
    Timer {
        interval: Math.max(5000, (window.oauthPending.interval || 8) * 1000); repeat: true; running: oauthDialog.visible && !!window.oauthPending.deviceCode
        onTriggered: { if (Date.now() >= window.oauthPending.expiresAt) { host.oauthAccount("cancel", window.oauthPending.deviceCode); window.oauthPending = ({}) } else if (!host.busy) host.oauthAccount("poll", window.oauthPending.deviceCode) }
    }
    SoftDialog {
        id: codexPreferencesDialog; title: "Codex 通用配置"; anchors.centerIn: parent; modal: true; width: 660; height: 480
        ColumnLayout { width: parent.width; spacing: 12
            Hint { text: "勾选“使用 Codex 通用配置”的供应商共用这些偏好；切换前会同步当前原生配置中的共享改动。MCP 配置继续保留。"; Layout.fillWidth: true }
            SoftTextArea { id: codexCommonText; Layout.fillWidth: true; Layout.preferredHeight: 230; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: "Consolas" }
            SoftSwitch { id: preserveCodexLogin; text: "切换第三方供应商时保留官方登录" }
            Hint { text: host.message; visible: text.length > 0; Layout.fillWidth: true; color: "#a34d4d" }
        }
        footer: SoftDialogActions {
            Item { Layout.fillWidth: true }
            ActionButton { text: "取消"; enabled: !host.busy; onClicked: codexPreferencesDialog.reject() }
            ActionButton { text: "保存"; primary: true; enabled: !host.busy; onClicked: host.saveCodexPreferences({ commonConfig: codexCommonText.text, preserveOfficialLogin: preserveCodexLogin.checked }) }
        }
    }
    SoftDialog {
        id: providerInfoDialog; anchors.centerIn: parent; modal: true; width: 590; height: 400
        property string infoText: ""
        contentItem: ScrollView { SoftTextArea { text: providerInfoDialog.infoText; readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap } }
        standardButtons: Dialog.Ok
    }
    SoftDialog {
        id: fetchedModelsDialog; objectName: "fetchedModelsDialog"; title: window.modelRequestIndex === -2 ? "选择默认模型" : "选择模型"; anchors.centerIn: parent; modal: true; width: 550; height: 490
        contentItem: ScrollView { clip: true; contentWidth: availableWidth
            ColumnLayout { width: fetchedModelsDialog.width - 40; spacing: 8
                Hint { text: window.singleModelSelection ? "选择一个模型，确认后回填当前模型栏。" : "所选模型会加入模型目录，保留已有模型的能力设置。"; Layout.fillWidth: true }
                Hint { text: "接口没有返回模型，可返回表单手动添加。"; visible: window.fetchedModels.length === 0; Layout.fillWidth: true }
                ButtonGroup { id: discoveredModelGroup }
                Repeater { model: window.fetchedModels
                    SoftCheckBox {
                        required property var modelData; required property int index
                        objectName: "discoveredModel-" + modelData.id; marksProviderDirty: false
                        text: modelData.name === modelData.id ? modelData.id : modelData.name + " · " + modelData.id
                        checked: modelData.selected; ButtonGroup.group: window.singleModelSelection ? discoveredModelGroup : null
                        onToggled: {
                            if (checked && window.singleModelSelection) window.fetchedModels.forEach(function(model, position) { model.selected = position === index })
                            else window.fetchedModels[index].selected = checked
                        }
                    }
                }
            }
        }
        standardButtons: Dialog.Cancel | Dialog.Ok
        onAccepted: window.acceptDiscoveredModels()
    }
    SoftDialog {
        id: removeProviderDialog; title: "从 Pi 移除供应商？"; anchors.centerIn: parent; modal: true; width: 440
        Label { width: parent.width; text: "仅移除 models.json 中的节点，卡片和最新配置仍保留。" + (host.piDefaultProvider === window.removeProviderId ? "\n这是 Pi 的全局默认供应商，移除后请在 Pi 中重新选择模型。" : ""); wrapMode: Text.WordWrap }
        standardButtons: Dialog.Cancel | Dialog.Ok
        onAccepted: host.switchProvider(window.removeProviderId, false)
    }
    SoftDialog {
        id: deleteProviderDialog; title: "删除供应商？"; anchors.centerIn: parent; modal: true; width: 410
        Label { width: parent.width; text: host.providerKind === "pi" ? "删除卡片和 models.json 中的对应供应商。" + (host.piDefaultProvider === window.deleteProviderId ? "\n这是 Pi 的全局默认供应商，删除后请在 Pi 中重新选择模型。" : "") : "删除这个未启用的供应商配置。"; wrapMode: Text.WordWrap }
        standardButtons: Dialog.Cancel | Dialog.Ok
        onAccepted: host.removeProvider(window.deleteProviderId)
    }
    SoftDialog {
        id: renameDialog; title: "设备名称"; anchors.centerIn: parent; modal: true; width: 410
        Field { id: deviceNameField; width: parent.width; maximumLength: 80; placeholderText: "例如：我的手机" }
        footer: SoftDialogButtons { ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } ActionButton { text: "保存名称"; primary: true; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole } onAccepted: renameDialog.accept(); onRejected: renameDialog.reject() }
        onAccepted: host.renameDevice(window.revokeId, deviceNameField.text)
    }
    Connections {
        target: host
        function onChanged() { if (host.qr.length > 0 && !pairDialog.visible) pairDialog.open(); if (host.qr.length === 0 && pairDialog.visible) pairDialog.close() }
        function onProviderDraftReady(draft) {
            window.loadingProviderDraft = true
            if (!providerDialog.visible) { presetSearch.text = ""; presetExpanded.checked = draft.create === true && (!draft.presetId || draft.presetId === "custom") }
            else presetExpanded.checked = false
            window.providerDraft = draft; host.clearMessage()
            window.providerFormError = ""
            providerName.text = draft.name
            providerAccount.model = window.accountOptions(draft.accounts || [])
            providerAccount.currentIndex = Math.max(0, providerAccount.indexOfValue(draft.authBinding ? (draft.authBinding.accountId || "$default") : ""))
            providerDetails.checked = false
            providerTransportDetails.checked = false
            providerCategory.text = draft.category || "custom"; providerNotes.text = draft.notes || ""; providerWebsite.text = draft.websiteUrl || ""; providerIcon.text = draft.icon || ""; providerOrder.text = String(draft.sortIndex === undefined ? host.providers.length : draft.sortIndex)
            providerCommon.checked = draft.commonConfigEnabled === true || (!!draft.create && draft.kind === "codex")
            providerAddToLive.checked = !!draft.create
            window.loadProviderFields(draft)
            advancedProvider.checked = draft.nativeOnly === true
            window.providerFormDirty = false
            window.loadingProviderDraft = false
            providerDialog.open()
        }
        function onProviderPreviewReady(draft) {
            if (!providerDialog.visible) return
            window.loadingProviderDraft = true
            window.loadProviderFields(draft)
            var current = window.providerDraft; current.official = draft.official === true; window.providerDraft = Object.assign({}, current)
            advancedProvider.checked = window.providerTargetAdvanced
            window.loadingProviderDraft = false
        }
        function onCodexPreferencesReady(preferences) { codexCommonText.text = preferences.commonConfig; preserveCodexLogin.checked = preferences.preserveOfficialLogin; host.clearMessage(); codexPreferencesDialog.open() }
        function onCodexPreferencesSaved() { codexPreferencesDialog.close() }
        function onProviderModelsReady(models) {
            if (!providerDialog.visible) return
            if (window.modelRequestConfig !== window.modelQueryConfig()) { window.providerFormError = "接口或凭据已修改，请重新获取模型列表。"; return }
            var selectedId = window.singleModelSelection ? (window.modelRequestIndex >= 0 ? window.providerModels[window.modelRequestIndex].id : providerModel.text) : ""
            window.fetchedModels = models.map(function(model) { return {id: model.id, name: model.name, selected: model.id === selectedId} }); fetchedModelsDialog.open()
        }
        function onOauthAccountResult(operation, value) {
            if (operation === "start") window.oauthPending = value
            else if (operation === "poll") { if (!value.pending) { window.oauthPending = ({}); host.oauthAccount("list") } }
            else if (operation !== "cancel") {
                window.oauthAccounts = value
                if (providerDialog.visible && window.officialProvider) {
                    var selectedAccount = providerAccount.currentValue
                    providerAccount.model = window.accountOptions(value)
                    providerAccount.currentIndex = Math.max(0, providerAccount.indexOfValue(selectedAccount))
                }
            }
        }
        function onProviderInfoReady(title, text) { providerInfoDialog.title = title; providerInfoDialog.infoText = text; providerInfoDialog.open() }
        function onProviderSaved() { providerDialog.close() }
    }
}
