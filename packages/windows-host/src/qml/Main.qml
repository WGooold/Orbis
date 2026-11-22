import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Orbis.Host
import "ProviderFlow.js" as ProviderFlow
import "Motion.js" as Motion

ApplicationWindow {
    id: window
    visible: true
    width: 1180; height: 820
    minimumWidth: 1020; minimumHeight: 700
    title: "Orbis Host"
    color: Theme.surfaceBase
        font.pixelSize: Theme.body
    palette.windowText: Theme.ink
    palette.text: Theme.ink
    palette.buttonText: Theme.ink
    palette.base: Theme.surfaceBase
    palette.highlight: Theme.accentSoft
    palette.highlightedText: Theme.ink
    readonly property bool motionEnabled: typeof orbisMotionEnabled === "undefined" || orbisMotionEnabled
    onMotionEnabledChanged: if (!motionEnabled) { pageArrival.stop(); pageContent.entryProgress = 1; themeFade.stop(); themeOverlay.visible = false; themeSnapshot = null }
    readonly property string appearanceThemeId: Theme.themeId
    property var themeSnapshot
    function applyAppearance(material, mode) {
        if (!motionEnabled || !window.visible) { Theme.preferences.material = material; Theme.preferences.mode = mode; return }
        themeFade.stop(); themeOverlay.visible = false
        mainLayout.grabToImage(function(result) {
            themeSnapshot = result; themeOverlay.source = result.url
            themeOverlay.opacity = 1; themeOverlay.visible = true
            Theme.preferences.material = material; Theme.preferences.mode = mode
            themeFade.restart()
        })
    }
    property int page: 0
    property var pageNames: ["概览", "设备", "Agent", "设置", "诊断"]
    property string revokeId: ""
    property string installKind: ""
    property var installAgentData: ({})
    // “发现可用更新”提示条只在本轮运行里露一次：关掉后仍可从侧边栏圆点和各页面按钮进入。
    property bool updateNoticeDismissed: false
    // HOST-GUIDE-01: the overview carries one next step; only that step's controls take the accent.
    readonly property bool hostOnline: host.state === "connected"
    readonly property bool hostLinking: host.resumePending || host.state === "connecting" || host.state === "reconnecting"
    readonly property int onlineDevices: host.devices.filter(function(device) { return device.path === "lan" || device.path === "relay" }).length
    readonly property var overviewAgents: {
        function agent(kind) { return host.agents.find(a => a.kind === kind) }
        const pi = agent("pi"), codex = agent("codex"), dsh = agent("dsh"), hermes = host.hermesCli
        return [
            {kind: "pi", name: "Pi", installed: pi?.installed, broken: pi?.installedButBroken === true, cliIssue: pi?.cliIssue, data: pi},
            {kind: "codex", name: "Codex", installed: codex?.installed, broken: codex?.installedButBroken === true, cliIssue: codex?.cliIssue, data: codex},
            {kind: "codexDesktop", name: "Codex 桌面版", installed: codex?.desktopInstalled, broken: false},
            // A version still being read is not a verdict: only a finished probe can mark Claude broken.
            {kind: "claude", name: "Claude Code", installed: host.claudeDetecting ? undefined : host.claudeInstalled, broken: host.claudeInstalled && !host.claudeCompatible && !host.claudeDetecting, cliIssue: host.claudeCliIssue},
            {kind: "dsh", name: "DeepSeek Harness", installed: dsh?.installed, broken: dsh?.installedButBroken === true, cliIssue: dsh?.cliIssue, data: dsh},
            // DSH-DESKTOP-09: only a Desktop Orbis opened can be attached, so its single action is always opening it from here.
            {kind: "dshDesktop", name: "DeepSeek 桌面版", installed: dsh?.desktopInstalled,
             broken: window.dshDesktopBlocked(), opensToFix: true}
        ].concat(window.agentEnabled("openclaw") ? [{kind: "openclaw", name: "OpenClaw", installed: window.openClawReady, broken: false}] : [])
         .concat(window.agentEnabled("hermes")
            ? [{kind: "hermes", name: "Hermes Agent", installed: hermes.installed === true || window.backendFor("hermes")?.ready === true,
                broken: hermes.cliIssue === "unrunnable", cliIssue: hermes.cliIssue, passive: true}]
            : [])
         .concat((host.agentEnablement.agents || []).filter(function(agent) {
            return agent.enabled && ["pi", "codex", "codexDesktop", "claude", "dsh", "dshDesktop", "openclaw", "hermes"].indexOf(agent.kind) < 0
         }).map(function(agent) {
            return {kind: agent.kind, name: agent.label, installed: window.backendFor(agent.kind)?.ready === true, broken: false, passive: true}
         })).filter(row => window.agentEnabled(row.kind)).sort((a, b) => window.agentRows.findIndex(row => row.kind === a.kind) - window.agentRows.findIndex(row => row.kind === b.kind))
    }
    function agentEnabled(kind) {
        const row = (host.agentEnablement.agents || []).find(function(agent) { return agent.kind === kind })
        return row !== undefined && row.enabled === true
    }
    readonly property bool openClawReady: window.backendFor("openclaw")?.ready === true && host.desiredRunning
    readonly property string openClawStateText: host.openClaw.invalid ? "配置无效"
        : !host.openClaw.url ? "待配置" : host.resumePending ? "正在重新连接"
        : window.openClawReady ? "已连接" : host.desiredRunning ? "Gateway 未就绪" : "Host 未连接"
    readonly property int setupStep: ["activate", "connect", "pair", "enable", "install"].indexOf(nextStep)
    readonly property bool setupComplete: host.activated && host.devices.length > 0 && overviewAgents.some(agent => agent.installed && !agent.broken)
    readonly property bool connectionError: host.state === "error" && !host.resumePending
    readonly property string publicPath: !hostOnline ? "" : host.devices.some(device => device.path === "lan") ? "局域网" : onlineDevices > 0 ? "中继" : ""
    // HOST-ACTIVITY-05: while the saved activation is still being read, "not activated" is not known yet.
    readonly property string nextStep: !host.activated ? (host.credentialsLoading ? "" : "activate")
        : !hostOnline ? "connect"
        : host.devices.length === 0 ? "pair"
        : agentRows.length && enabledAgentCount === 0 ? "enable"
        : overviewAgents.some(agent => agent.data && (agent.installed === false || agent.broken)) && !overviewAgents.some(agent => agent.installed && !agent.broken) ? "install" : "open"
    function backendFor(kind) { return host.backends.find(function(backend) { return backend.kind === kind }) }
    /** Whether a phone can use this Agent through the running Host right now. */
    function agentReachable(agent) {
        if (!agent.installed || agent.broken || !window.hostOnline) return false
        // 该 Agent 的后端在后台准备时手机还用不了它；其余 Agent 不受影响。
        if (window.preparing(agent.kind)) return false
        var backend = window.backendFor(agent.kind)
        if (agent.kind === "openclaw") return window.openClawReady
        if (agent.kind === "codexDesktop" && window.codexDesktopState() !== "attached") return false
        return backend === undefined || backend.launchable === true || backend.ready === true
    }
    function agentCliDetecting(kind) {
        return kind === "claude" ? host.claudeDetecting : kind === "hermes" ? host.hermesCli.detecting === true : window.activityKinds.indexOf("agents") >= 0
    }
    function agentCliHint(agent) {
        // HOST-CLI-DISCOVERY-01: no recovery hint before detection settles, or for a healthy CLI with an offline Host.
        if (!host.bridgeReady || window.agentCliDetecting(agent.kind)) return ""
        if (agent.cliIssue === "missing") return "未在终端或常见安装位置找到 " + agent.name + "。如果已安装，点击圆点填写 CLI 路径；否则请先安装。"
        if (agent.cliIssue === "unrunnable") return agent.name + " 的 CLI 入口已失效或无法运行。请检查原命令，或点击圆点指定可用路径。"
        if (agent.cliIssue === "unsupported") return agent.name + " 能运行，但此版本不支持终端接入。请更新原安装，或点击圆点指定兼容版本。"
        return ""
    }
    function showAgentEntry(agent) {
        agentEntryDialog.kind = agent.kind
        agentEntryDialog.error = ""
        agentEntryPath.text = host.agentEntryOverrides[agent.kind] || ""
        agentEntryDialog.open()
    }
    function agentPhoneState(agent, sessions) {
        if (agent.kind === "codexDesktop" && window.codexDesktopNeedsAttention) return window.codexDesktopLabel()
        if (agent.kind === "openclaw" && !window.agentReachable(agent)) return window.openClawStateText
        if (agent.passive && !window.agentReachable(agent)) return "未接入"
        // 检测在跑时列表里是旧结论：不标记就会把“还没测完”读成“不能用了”。Claude 有自己的检测。
        if (!host.bridgeReady || window.agentCliDetecting(agent.kind)) return "检测中"
        if (agent.cliIssue === "unrunnable") return "入口不可用"
        if (agent.installed === false) return "未安装"
        if (agent.installed !== true) return "等待检测"
        if (agent.kind === "dshDesktop" && host.dshDesktopOpen === "waiting") return "等待退出"
        if (agent.broken) return agent.kind === "claude" ? "需升级" : agent.kind === "dshDesktop" ? window.dshDesktopShortState() : "需要修复"
        if (window.hostLinking) return "正在连接"
        if (!window.hostOnline) return "连接后手机可用"
        // 后台准备（Codex 终端服务端首次安装或 CLI 升级后约一百多 MB；Claude 插件登记；DeepSeek 后端）不挡连接。
        if (agent.kind === "codex" && window.codexTerminalPreparing) return window.codexTerminalProgressText()
        if (window.preparing(agent.kind)) return "正在准备"
        if (!window.agentReachable(agent)) return "手机暂不可用"
        return sessions > 0 ? "手机上 " + sessions + " 个会话" : "手机可用"
    }
    // Unknown installation is not an install verdict: keep the action descriptive but disabled until detection settles.
    function overviewAgentActionText(agent, installable) {
        if (agent.kind === "openclaw") return "配置"
        if (agent.installed === false) return installable ? (agent.broken ? "修复" : "安装") : "打开"
        if (agent.installed === true && agent.broken && installable && agent.opensToFix !== true) return "修复"
        if (agent.installed === true) return "打开"
        return window.agentPhoneState(agent, 0)
    }
    function overviewAgentActionEnabled(agent, installable) {
        return host.bridgeReady && !host.busy && (agent.installed === true || (agent.installed === false && installable))
    }
    function overviewAgentActionPrimary(agent, installable) {
        if (window.connectionError) return false
        if (agent.installed === true && (!agent.broken || agent.opensToFix === true) && window.nextStep === "open") return true
        const needsInstallOrRepair = agent.installed === false ||
            agent.installed === true && agent.broken && agent.opensToFix !== true
        return needsInstallOrRepair && installable && window.nextStep === "install"
    }
    readonly property var codexTerminalState: host.codexTerminal || ({})
    // 进行中的操作来自 host.activity（桥命令逐个登记），是所有按钮变灰的统一原因。
    // 命令现在会并行（HOST-LANE-01），所以按钮读 activityKinds 判断自己的那一项是否在跑。
    readonly property var activity: host.activity || ({})
    readonly property string activityKind: window.activity.kind || ""
    readonly property string activityText: window.activity.text || ""
    readonly property var activityKinds: host.activityKinds || []
    function preparationOf(kind) { return (host.preparations || ({}))[kind] || ({}) }
    function preparing(kind) { return window.preparationOf(kind).state === "preparing" }
    readonly property bool codexTerminalPreparing: window.codexTerminalState.state === "preparing"
    function codexTerminalProgressText() {
        var received = Number(window.codexTerminalState.receivedBytes || 0)
        var total = Number(window.codexTerminalState.totalBytes || 0)
        return total > 0 ? "准备中 " + Math.floor(Math.min(1, received / total) * 100) + "%" : "正在准备"
    }
    /** Claude 检测未完成时不能用“未安装”当结论；这与 Host 侧的 detecting 对齐。 */
    function claudeStateText() {
        if (host.claudeDetecting) return "检测中"
        if (!host.claudeInstalled) return "尚未安装"
        if (host.claudeCompatible) return "可用"
        return host.claudeVersion ? "需升级" : "版本未确认"
    }
    function openOverviewAgent(kind) {
        if (kind === "openclaw") window.goAgent(kind)
        else if (kind === "pi" || kind === "codex" || kind === "claude") host.openAgentTui(kind)
        else host.openAgent(kind)
    }
    function agentName(kind) { return ({pi:"Pi", codex:"Codex", claude:"Claude Code", dsh:"DeepSeek", hermes:"Hermes Agent"})[kind] || kind }
    // Codex 桌面版接入卡只是把 Host 下发的分档换成人话；文案本身全部来自 Host，
    // 两个客户端不各自拼，免得同一件事在电脑和手机上说法不一。
    function codexDesktopState() { return (host.codexDesktop && host.codexDesktop.state) ? host.codexDesktop.state : "" }
    readonly property bool codexDesktopNeedsAttention: host.bridgeReady && ["error", "closed"].indexOf(window.codexDesktopState()) !== -1
    function codexDesktopLabel() { return ({attached:"已接入", closed:"未接入", notInstalled:"未安装", unsupported:"不可用", error:"接入失败"})[window.codexDesktopState()] || (!host.bridgeReady ? "未知" : window.hostOnline ? "正在检测" : "未连接") }
    function codexDesktopColor() { return ({attached:Theme.success, closed:Theme.warning, error:Theme.danger, notInstalled:Theme.inkMuted, unsupported:Theme.inkMuted})[window.codexDesktopState()] || Theme.inkMuted }
    function piAgent() { return host.agents.find(a => a.kind === "pi") || {} }
    function codexDesktopReason() { return (host.codexDesktop && host.codexDesktop.reason) ? host.codexDesktop.reason : "" }
    // DeepSeek 桌面版（ADR-0076）：分档与原因都来自 Host；概览只给短状态，下一步始终是从这里打开。
    function dshDesktopState() { return (host.dshDesktop && host.dshDesktop.state) ? host.dshDesktop.state : "" }
    function dshDesktopBlocked() { return ["running", "incompatible", "error"].indexOf(window.dshDesktopState()) >= 0 }
    function dshDesktopShortState() { return ({running:"需由 Orbis 打开", incompatible:"版本不兼容", error:"接入失败"})[window.dshDesktopState()] || "" }
    function dshDesktopLabel() { return ({attached:"已接入", closed:"未接入", running:"未接入", notInstalled:"未安装", unsupported:"不可用", incompatible:"版本不兼容", error:"接入失败"})[window.dshDesktopState()] || (!host.bridgeReady ? "未知" : window.hostOnline ? "正在检测" : "未连接") }
    function dshDesktopColor() { return ({attached:Theme.success, closed:Theme.warning, running:Theme.warning, incompatible:Theme.danger, error:Theme.danger})[window.dshDesktopState()] || Theme.inkMuted }
    function dshDesktopReason() { return (host.dshDesktop && host.dshDesktop.reason) ? host.dshDesktop.reason : "" }
    function installationStage() {
        if (host.agentInstallKind === "claude" && host.agentInstallStage === "downloading") return "正在更新到最新版本"
        return ({queued:"准备安装", resolving:"检查安装位置", downloading:"下载与安装依赖", verifying:"验证 CLI 和版本", activating:"保存新版本", restarting:"正在重启 Agent 后台", restartFailed:"已更新，后台需手动重启", cancelling:"正在取消并清理", cancelled:"已取消", error:"安装失败", done:"安装完成"})[host.agentInstallStage] || ""
    }
    function showAgentInstaller(agent) { installKind = agent.kind; installAgentData = agent; installDialog.open() }
    function batchAgentTargets() {
        var targets = host.agents.filter(a => window.agentEnabled(a.kind) && (!a.installed || a.updateAvailable || a.installedButBroken))
        if (window.agentEnabled("claude") && host.claudeInstalled && !host.claudeDetecting && (host.claudeUpdateAvailable || !host.claudeCompatible)) targets.push({kind: "claude"})
        return targets
    }
    function showAgentBatch() { batchInstallDialog.open() }
    function closeAgentDialogs() { installDialog.close(); batchInstallDialog.close() }
    property bool providersOpen: false
    property string selectedAgent: "codex"
    property var selectedAgents: []
    property string agentSelectionAnchor: ""
    property string previewProviderId: ""
    property var agentFeedback: ({})
    readonly property var agentRows: host.agentEnablement.agents || []
    readonly property int enabledAgentCount: agentRows.filter(row => row.enabled).length
    readonly property var selectedAgentRow: agentRows.find(row => row.kind === selectedAgent) || agentRows[0] || null
    readonly property string detailKind: selectedAgentRow ? selectedAgentRow.kind : ""
    readonly property string detailProviderGroup: providerGroup(detailKind)
    readonly property bool detailPowered: selectedAgentRow !== null && selectedAgentRow.enabled === true
    readonly property var detailChange: host.agentChanges[detailKind] || null
    readonly property var detailSessions: host.activeAgentSessions[detailKind] || ({})
    readonly property var detailFacts: window.overviewAgents.find(row => row.kind === detailKind) || null
    readonly property bool canEditAgent: host.agentChoicesAvailable
    readonly property string inlineListOwner: page === 2 && detailPowered && !providersOpen ? detailProviderGroup : ""
    onInlineListOwnerChanged: if (inlineListOwner) host.refreshAgentProviders(inlineListOwner)
    function providerGroup(kind) {
        // Codex is shared. DeepSeek Desktop exposes a separate native, read-only catalog (ADR-0076).
        return kind === "codexDesktop" ? "codex" : ["codex", "claude", "pi", "dsh"].includes(kind) ? kind : ""
    }
    function choiceFor(kind) { return host.agentChanges[kind] || null }
    function agentVisualOn(row) {
        if (!row) return false
        const change = choiceFor(row.kind)
        return change ? change.previous : row.enabled === true
    }
    function agentFeedbackText() {
        const kinds = agentFeedback.kinds || []
        const label = kinds.length > 1 ? kinds.length + " 个 Agent" : agentRows.find(row => row.kind === kinds[0])?.label || "Agent"
        switch (agentFeedback.status) {
        case "disabled": return "已停用 " + label
        case "externalOn": return label + " 已在其他设备启用"
        case "externalOff": return label + " 已在其他设备停用"
        case "conflict": return "其他设备已更改，未应用"
        case "failed": return "未确认，等待电脑同步"
        default: return ""
        }
    }
    function flipAgent(kind) {
        const row = agentRows.find(item => item.kind === kind), change = choiceFor(kind)
        if (canEditAgent && row && (!change || change.withdrawable)) host.setAgentEnabled(kind, !(change ? change.target : row.enabled))
    }
    function chooseAgent(kind, modifiers) {
        const ids = agentRows.map(row => row.kind)
        if (!ids.includes(kind)) return
        if (modifiers & Qt.ShiftModifier) {
            const a = Math.max(0, ids.indexOf(agentSelectionAnchor || detailKind)), b = ids.indexOf(kind)
            selectedAgents = ids.slice(Math.min(a, b), Math.max(a, b) + 1)
        } else if (modifiers & (Qt.ControlModifier | Qt.MetaModifier)) {
            const values = selectedAgents.length ? selectedAgents : [detailKind]
            selectedAgents = kind === detailKind && !selectedAgents.length ? [kind] : values.includes(kind) ? values.filter(id => id !== kind) : values.concat(kind)
            agentSelectionAnchor = kind
        } else { selectedAgents = []; agentSelectionAnchor = kind }
        selectedAgent = kind; providersOpen = false; previewProviderId = ""
    }
    function goAgent(kind) {
        selectPage(2)
        if (kind) chooseAgent(kind, 0)
        else { providersOpen = false; selectedAgents = [] }
        if (scroll.contentItem) scroll.contentItem.contentY = 0
    }
    function agentStatus(row) {
        const change = choiceFor(row.kind)
        if (change) return {text: change.queued ? "已排队" : "待确认", color: Theme.accent, sync: !change.queued}
        if (!row.enabled) return {text: "未启用", color: Theme.inkFaint, idle: true}
        const agent = window.overviewAgents.find(candidate => candidate.kind === row.kind)
        const backend = window.backendFor(row.kind)
        const prep = window.preparationOf(row.kind)
        if (host.agentInstalling && host.agentInstallKind === row.kind) return {text: window.installationStage(), color: Theme.warning, sync: true}
        if (prep.state === "error") return {text: "接入失败", color: Theme.danger, detail: prep.message || ""}
        if (row.kind === "openclaw" && (host.openClaw.invalid || !host.openClaw.url)) return {text: "待配置", color: Theme.warning}
        if (!host.desiredRunning && !host.resumePending && host.state === "stopped") return {text: "恢复后生效", color: Theme.inkFaint, idle: true}
        if (window.connectionError) return {text: "等待 Host 连接", color: Theme.warning, idle: true}
        if (prep.state === "preparing" || window.hostLinking) return {text: "准备中", color: Theme.warning, sync: true}
        if (row.kind === "codexDesktop" && window.codexDesktopState() === "error") return {text: "接入失败", color: Theme.danger, detail: window.codexDesktopReason()}
        if (row.kind === "dshDesktop" && window.dshDesktopBlocked()) return {text: window.dshDesktopShortState(), color: Theme.warning}
        if (agent && !agent.passive && agent.installed === false && !window.agentCliDetecting(row.kind)) return {text: "未安装", color: Theme.warning, idle: true}
        if (agent && agent.broken) return {text: "需要修复", color: Theme.warning, detail: window.agentCliHint(agent)}
        if (backend && backend.ready && window.hostOnline) return {text: host.activeAgentSessions[row.kind]?.total > 0 ? "运行中" : "可用", color: Theme.success, idle: !(host.activeAgentSessions[row.kind]?.total > 0)}
        if (backend && backend.launchable) return {text: "可启动", color: Theme.inkMuted, idle: true}
        return {text: "等待接入", color: Theme.inkMuted, idle: true}
    }
    function askProvider(row) {
        if (!detailPowered || !detailProviderGroup || host.providerKind !== detailProviderGroup || host.busy || detailChange || !row) return
        if (row.enabled) {
            if (row.mode === "additive") { window.removeProviderId = row.id; removeProviderDialog.open() }
        } else if (row.mode === "additive") host.switchProvider(row.id, true)
        else { agentProviderConfirm.profile = row; agentProviderConfirm.group = detailProviderGroup; agentProviderConfirm.open() }
    }
    property bool providerFormDirty: false
    property bool loadingProviderDraft: false
    property string pendingPresetId: ""
    property string draggedProviderId: ""
    readonly property bool officialProvider: ["codex", "claude"].indexOf(providerDraft.kind) >= 0 && providerDraft.official === true
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
        if (providerDraft.kind === "dsh") explicitProviderModels = true
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
        providerApi.model = window.providerDraft.kind === "claude" ? ["anthropic-messages"] : window.providerDraft.kind === "codex" ? ["openai-responses", "openai-completions", "anthropic-messages"] : ["", "openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "bedrock-converse-stream"]
        if (providerApi.find(draft.fields.api) < 0) providerApi.model = providerApi.model.concat([draft.fields.api])
        providerApi.currentIndex = Math.max(0, providerApi.find(draft.fields.api))
        var claude = draft.fields.claude || {}
        claudeCredential.currentIndex = claude.apiKeyField === "ANTHROPIC_API_KEY" ? 1 : 0
        claudeHaiku.text = claude.haiku || ""; claudeSonnet.text = claude.sonnet || ""; claudeOpus.text = claude.opus || ""
        piHeaders.text = JSON.stringify(draft.fields.headers || {}, null, 2)
        piCompat.text = JSON.stringify(draft.fields.compat || {}, null, 2)
        // Qt QVariant-backed rows do not retain nested in-place edits when serialized.
        // Keep an independent JS draft, just like rows created by addProviderModel().
        window.providerModels = window.providerDraft.kind === "codex" ? [] : JSON.parse(JSON.stringify(draft.fields.models || []))
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
            if (draft.kind === "claude") draft.fields.claude = {apiKeyField: claudeCredential.currentText, haiku: claudeHaiku.text.trim(), sonnet: claudeSonnet.text.trim(), opus: claudeOpus.text.trim()}
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
    function selectPage(index) { if (page !== index) { page = index; if (window.motionEnabled) { pageContent.entryProgress = 0; pageArrival.restart() } } if (index === 3) settingsPane.load() }
    function openProviders(kind) {
        if (detailProviderGroup !== kind || !detailPowered) { selectPage(2); chooseAgent(window.agentEnabled(kind) ? kind : kind === "codex" ? "codexDesktop" : kind, 0) }
        if (!detailPowered || detailProviderGroup !== kind) return
        selectPage(2); providersOpen = true; providerSearch.text = ""; host.loadProviders(kind)
    }
    function closeProviderEditor() { providerDialog.close() }
    function requestCloseProviderEditor() { if (providerFormDirty) discardProviderDialog.open(); else closeProviderEditor() }
    function setProviderEditorMode(nativeMode) {
        var preview = window.buildProviderDraft(nativeMode)
        if (preview !== null) { window.providerTargetAdvanced = nativeMode; host.previewProvider(preview) }
    }
    function saveProviderEditor() { var draft = buildProviderDraft(!advancedProvider.checked); if (draft !== null) host.saveProvider(draft) }
    function stateText() {
        // 钥匙串读取可能在等系统授权框：窗口要能先出来，并说出它在等什么。
        if (host.awaitingSystemAuthorization) return "正在等待系统授权"
        // 内核还没就绪时不要说“已暂停”：用户会以为 Host 自己停了。内核已退出则不是“正在启动”。
        if (!host.bridgeReady) return host.state === "error" ? "需要处理" : "正在启动 Host 核心"
        if (host.credentialsLoading) return "正在读取激活信息"
        if (host.resumePending) return "完成后自动恢复"
        if (!host.activated && host.bridgeReady) return "未激活"
        return ({connected: "已连接", connecting: "连接中", reconnecting: "重连中", closed: "已断开", stopped: "已暂停", error: "需要处理"})[host.state] || "正在准备"
    }
    function agentUpdatesAvailable() { return (window.agentEnabled("claude") && host.claudeInstalled && host.claudeUpdateAvailable) || host.agents.some(function(agent) { return window.agentEnabled(agent.kind) && agent.installed && agent.updateAvailable }) }
    function androidUpdatesAvailable() { return host.devices.some(function(device) { return device.androidUpdateAvailable }) }
    function pageHasUpdate(index) {
        if (index === 1) return window.androidUpdatesAvailable()
        if (index === 2) return window.agentUpdatesAvailable()
        if (index === 3) return host.hostUpdateAvailable
        return false
    }
    function availableUpdatesText() {
        var updates = []
        if (host.hostUpdateAvailable) updates.push("Orbis Host " + host.hostUpdateVersion)
        if (host.claudeInstalled && host.claudeUpdateAvailable) updates.push("Claude Code " + host.claudeLatestVersion)
        host.agents.filter(function(agent) { return agent.installed && agent.updateAvailable }).forEach(function(agent) {
            updates.push(window.agentName(agent.kind) + " " + (agent.recommendedVersion || agent.latestVersion))
        })
        host.devices.filter(function(device) { return device.androidUpdateAvailable }).forEach(function(device) {
            updates.push((device.label || "Android 设备") + " " + device.appVersion + " → " + device.latestAndroidVersion)
        })
        return updates.join("、")
    }
    onClosing: function(close) {
        // HOST-EXIT-05: the verified final close must bypass hide-to-tray and confirmation.
        if (host.exitApproved) { close.accepted = true; return }
        close.accepted = false
        if (trayAvailable && !host.exiting) window.hide()
        else host.requestExit()
    }

    component Field: TextField {
        property bool marksProviderDirty: true
        implicitHeight: Theme.fieldHeight
        leftPadding: 16; rightPadding: 16
        selectByMouse: true
        color: Theme.ink
        placeholderTextColor: Theme.inkMuted
        background: Surface { anchors.fill: parent; anchors.margins: -8; margin: 8; inset: true; focused: parent.activeFocus; disabled: !parent.enabled }
        onTextEdited: if (marksProviderDirty && providerDialog.visible && !window.loadingProviderDraft) window.providerFormDirty = true
    }
    component Heading: MotionText { font.pixelSize: Theme.body; font.weight: Font.DemiBold; color: Theme.ink }
    function formatBytes(value) {
        if (!(value > 0)) return "0 MB"
        var mb = value / 1048576
        return mb >= 100 ? Math.round(mb) + " MB" : mb.toFixed(1) + " MB"
    }
    /** 下载已用秒数：npm 不给在途字节，单个大包期间百分比不动，靠它证明“还在下”。 */
    property int downloadSeconds: 0
    Timer { interval: 1000; repeat: true; running: host.downloadReceived >= 0 || window.codexTerminalPreparing; onTriggered: window.downloadSeconds = host.downloadReceived >= 0 || window.codexTerminalPreparing ? window.downloadSeconds + 1 : 0 }
    Connections { target: host; function onChanged() { if (host.downloadReceived < 0 && !window.codexTerminalPreparing) window.downloadSeconds = 0 } }
    /** 下载进度条：知道总大小就给百分比，不知道就只报已下字节 + 一段来回走的色块。 */
    component DownloadBar: ColumnLayout {
        property string label: ""
        property real received: 0
        property real total: 0
        readonly property real ratio: total > 0 ? Math.max(0, Math.min(1, received / total)) : 0
        spacing: 6
        RowLayout {
            Layout.fillWidth: true; spacing: 8
            Label { text: label; color: Theme.ink; font.pixelSize: Theme.caption; elide: Text.ElideRight; Layout.fillWidth: true }
            Label {
                text: total > 0
                    ? window.formatBytes(received) + " / " + window.formatBytes(total) + "（" + Math.floor(ratio * 100) + "%）"
                    : "已下载 " + window.formatBytes(received)
                color: Theme.inkMuted; font.pixelSize: Theme.caption
            }
            Label { text: "已用 " + window.downloadSeconds + " 秒"; color: Theme.inkMuted; font.pixelSize: Theme.caption }
        }
        Rectangle {
            id: track
            Layout.fillWidth: true; Layout.preferredHeight: 6; radius: 3; color: Theme.surfaceBase
            Rectangle { visible: total > 0; width: track.width * ratio; height: track.height; radius: 3; color: Theme.accent; Behavior on width { NumberAnimation { duration: window.motionEnabled ? Theme.durState : 0; easing.type: Easing.OutCubic } } }
            Rectangle {
                visible: total <= 0
                width: track.width * 0.3; height: track.height; radius: 3; color: Theme.accent
                SequentialAnimation on x {
                    running: visible && window.motionEnabled
                    loops: Animation.Infinite
                    NumberAnimation { from: 0; to: track.width * 0.7; duration: Theme.durLoop; easing.type: Easing.Linear }
                    NumberAnimation { from: track.width * 0.7; to: 0; duration: Theme.durLoop; easing.type: Easing.Linear }
                }
            }
        }
    }
    component Hint: MotionText { color: Theme.inkMuted; wrapMode: Text.WordWrap; lineHeight: 1.4; font.pixelSize: Theme.label }
    // HOST-GUIDE-01: the computer and the phones as two ends of one link. The link's shape is the
    // connection state: solid when connected, travelling while connecting, dashed while paused.
    component NodeDisc: Item {
        property string symbol: ""
        property bool lit: false
        implicitWidth: 52; implicitHeight: 52
        Accessible.ignored: true
        Surface { anchors.fill: parent; anchors.margins: -10; margin: 10; cornerRadius: 26; shadowScale: 0.6 }
        SymbolIcon { anchors.centerIn: parent; width: Theme.iconMd; height: Theme.iconMd; name: parent.symbol; color: parent.lit ? Theme.accent : Theme.inkFaint; Behavior on color { enabled: window.motionEnabled; ColorAnimation { duration: Theme.durState } } }
    }
    component ConnectionLine: Item {
        id: link
        readonly property color tone: window.hostOnline ? Theme.success : window.hostLinking ? Theme.warning : host.state === "error" ? Theme.danger : Theme.inkFaint
        implicitHeight: 12
        Accessible.ignored: true
        Rectangle { visible: window.hostOnline; anchors.verticalCenter: parent.verticalCenter; width: parent.width; height: 2; radius: 1; color: link.tone }
        Row {
            visible: !window.hostOnline; clip: true
            anchors.verticalCenter: parent.verticalCenter; width: parent.width; spacing: 6
            Repeater { model: Math.max(0, Math.ceil(link.width / 12)); Rectangle { width: 6; height: 2; radius: 1; color: link.tone } }
        }
        Rectangle {
            id: traveller
            visible: window.hostLinking && window.motionEnabled
            width: 8; height: 8; radius: 4; color: link.tone
            anchors.verticalCenter: parent.verticalCenter
            SequentialAnimation on x {
                running: traveller.visible; loops: Animation.Infinite
                NumberAnimation { from: 0; to: Math.max(0, link.width - 8); duration: Theme.durLoop; easing.type: Easing.InOutSine }
                NumberAnimation { from: Math.max(0, link.width - 8); to: 0; duration: Theme.durLoop; easing.type: Easing.InOutSine }
            }
        }
    }
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
            Accessible.ignored: true
            x: 0; y: 0
            text: face.text
            color: Theme.shade
            opacity: 0.6
            font: face.font
        }
        Label {
            id: lightWall
            Accessible.ignored: true
            x: wordmark.relief; y: wordmark.relief
            text: face.text
            color: Theme.highlight
            opacity: 0.92
            font: face.font
        }
        Label {
            id: face
            x: wordmark.relief / 2; y: wordmark.relief / 2
            text: "Orbis"
            color: Theme.inkMuted
            font.pixelSize: Theme.title
            font.weight: Font.DemiBold

        }
    }
    component DialogSurface: Surface {
        anchors.fill: parent; anchors.margins: -16; margin: 16
        cornerRadius: Theme.radiusXl; shadowScale: 1
        surface: Theme.surfaceBase
    }
    component SoftDialog: Dialog {
        id: dialog
        readonly property int orbisSurfaceLevel: 0
        padding: 16
        palette.window: Theme.surfaceBase
        palette.windowText: Theme.ink
        background: DialogSurface { floatsOverModal: dialog.modal }
        header: Label {
            text: dialog.title; visible: text.length > 0
            padding: 16; bottomPadding: 16
            font.pixelSize: Theme.title; font.weight: Font.DemiBold; color: Theme.ink
            wrapMode: Text.WordWrap
        }
        Overlay.modal: Rectangle { color: Qt.alpha(Theme.scrim, 0.34) }
        enter: Transition {
            ParallelAnimation {
                NumberAnimation { property: "opacity"; from: 0; to: 1; duration: window.motionEnabled ? Theme.durPanel : 0; easing.type: Easing.OutCubic }
                NumberAnimation { property: "scale"; from: 0.96; to: 1; duration: window.motionEnabled ? Theme.durPanel : 0; easing.type: Easing.OutCubic }
            }
        }
        exit: Transition {
            ParallelAnimation {
                NumberAnimation { property: "opacity"; from: 1; to: 0; duration: window.motionEnabled ? Theme.durExit : 0; easing.type: Easing.InCubic }
                NumberAnimation { property: "scale"; from: 1; to: 0.96; duration: window.motionEnabled ? Theme.durExit : 0; easing.type: Easing.InCubic }
            }
        }
        footer: SoftDialogButtons { visible: count > 0 }
    }
    component SoftDialogButtons: DialogButtonBox {
        readonly property int orbisSurfaceLevel: 0
        spacing: 8; padding: 16; alignment: Qt.AlignRight
        background: Item {}
        delegate: ActionButton {}
    }
    component SoftDialogActions: Pane {
        id: dialogActions
        readonly property int orbisSurfaceLevel: 0
        default property alias actions: actionRow.data
        spacing: 8; padding: 16
        background: Item {}
        contentItem: RowLayout { id: actionRow; spacing: dialogActions.spacing }
    }
    component SoftSwitch: Switch {
        id: softSwitch
        property bool marksProviderDirty: true
        property string agentKind: ""
        readonly property string stateLabel: checked ? "开" : "关"
        Accessible.name: (text || "开关") + "，当前状态：" + stateLabel
        onToggled: if (marksProviderDirty && providerDialog.visible && !window.loadingProviderDraft) window.providerFormDirty = true
        spacing: 12
        implicitHeight: Theme.touchTarget
        indicator: Item {
            implicitWidth: 64; implicitHeight: 32
            x: softSwitch.leftPadding; y: (softSwitch.height - height) / 2
            Surface { anchors.fill: parent; anchors.margins: -8; margin: 8; cornerRadius: Theme.radiusSm; inset: true; shadowScale: 0.4; disabled: !softSwitch.enabled; focused: softSwitch.activeFocus }
            Rectangle {
                width: 24; height: 24; radius: Theme.radiusXs
                x: softSwitch.checked ? parent.width - width - 4 : 4; y: 4
                color: softSwitch.enabled ? Theme.surfaceLift : Theme.surfaceBase
                border.width: softSwitch.enabled ? 0 : 1; border.color: Theme.hairline
                Behavior on x { enabled: window.motionEnabled; NumberAnimation { duration: Theme.durSelection; easing.type: Easing.OutCubic } }
                SymbolIcon { anchors.centerIn: parent; width: 16; height: 16; name: softSwitch.checked ? "check" : "close"; color: softSwitch.enabled ? (softSwitch.checked ? Theme.accent : Theme.inkMuted) : Theme.inkFaint }
            }
        }
        contentItem: Label {
            text: softSwitch.text
            leftPadding: agentMark.x + (agentMark.hasMark ? agentMark.width + 8 : 0)
            verticalAlignment: Text.AlignVCenter
            color: softSwitch.enabled ? Theme.ink : Theme.inkFaint
            font.pixelSize: Theme.body
            wrapMode: Text.WordWrap
            AgentMark {
                id: agentMark
                anchors.verticalCenter: parent.verticalCenter
                x: softSwitch.indicator.width + softSwitch.spacing
                kind: softSwitch.agentKind; visible: hasMark
            }
        }
    }
    component SoftComboBox: ComboBox {
        id: softCombo
        property bool inModal: false
        onActivated: if (providerDialog.visible && !window.loadingProviderDraft) window.providerFormDirty = true
        implicitHeight: Theme.fieldHeight
        implicitWidth: 180
        leftPadding: 14; rightPadding: 42
        font.pixelSize: Theme.body
        contentItem: TextField {
            text: softCombo.editable ? softCombo.editText : softCombo.displayText
            font: softCombo.font
            color: softCombo.enabled ? Theme.ink : Theme.inkFaint
            placeholderTextColor: Theme.inkMuted
            verticalAlignment: Text.AlignVCenter
            readOnly: !softCombo.editable
            selectByMouse: true
            background: Item {}
            onTextEdited: if (softCombo.editable) softCombo.editText = text
        }
        indicator: SymbolIcon {
            x: softCombo.width - width - 16; y: (softCombo.height - height) / 2
            width: 22; height: 22; name: "keyboard_arrow_down"
            color: softCombo.enabled ? Theme.inkMuted : Theme.inkFaint
        }
        background: Surface {
            anchors.fill: parent; anchors.margins: -8; margin: 8; cornerRadius: Theme.radiusMd
            inset: true; focused: softCombo.activeFocus; disabled: !softCombo.enabled
        }
        delegate: ItemDelegate {
            width: softCombo.width - 16; implicitHeight: Theme.controlHeight
            highlighted: softCombo.highlightedIndex === index
            contentItem: Text {
                text: modelData && softCombo.textRole ? modelData[softCombo.textRole] : modelData
                color: softCombo.enabled ? Theme.ink : Theme.inkFaint
                font.pixelSize: Theme.body; verticalAlignment: Text.AlignVCenter
                elide: Text.ElideRight
            }
            background: Surface {
                anchors.fill: parent; margin: 0; cornerRadius: Theme.radiusMd
                inset: parent.highlighted || parent.down; surface: Theme.surfaceBase
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
            background: Surface {
                anchors.fill: parent; anchors.margins: -12; margin: 12
                cornerRadius: Theme.radiusLg; surface: Theme.surfaceBase; shadowScale: 1
                floatsOverModal: softCombo.inModal
            }
        }
    }
    component ProviderComboBox: SoftComboBox { inModal: true }
    component SoftCheckBox: CheckBox {
        id: softCheck
        property bool marksProviderDirty: true
        onToggled: if (marksProviderDirty && providerDialog.visible && !window.loadingProviderDraft) window.providerFormDirty = true
        spacing: 12
        implicitHeight: Theme.touchTarget
        indicator: Item {
            implicitWidth: 24; implicitHeight: 24
            x: softCheck.leftPadding; y: (softCheck.height - height) / 2
                        Surface {
                anchors.fill: parent; anchors.margins: -8; margin: 8
                inset: softCheck.checked || softCheck.down; shadowScale: 0.4; disabled: !softCheck.enabled; focused: softCheck.activeFocus; cornerRadius: Theme.radiusXs
            }
            SymbolIcon {
                anchors.centerIn: parent; visible: softCheck.checked
                name: "check"; width: 16; height: 16
                color: softCheck.enabled ? Theme.accent : Theme.inkFaint
            }
        }
        contentItem: Label {
            text: softCheck.text
            leftPadding: softCheck.indicator.width + softCheck.spacing
            verticalAlignment: Text.AlignVCenter
            color: softCheck.enabled ? Theme.inkMuted : Theme.inkFaint
        }
    }
    component SoftTextArea: TextArea {
        onTextChanged: if (activeFocus && providerDialog.visible && !window.loadingProviderDraft) window.providerFormDirty = true
        implicitHeight: 96
        leftPadding: 16; rightPadding: 16; topPadding: 12; bottomPadding: 12
        selectByMouse: true
        color: Theme.ink
        placeholderTextColor: Theme.inkMuted
        background: Surface {
            anchors.fill: parent; anchors.margins: -8; margin: 8; cornerRadius: Theme.radiusMd
            inset: true; focused: parent.activeFocus; disabled: !parent.enabled
        }
    }
    component SoftToolButton: ToolButton {
        id: softTool
        property string symbol: "more_horiz"
        Accessible.name: text || ({close:"关闭",arrow_upward:"上移",arrow_downward:"下移",more_horiz:"更多"})[symbol] || "操作"
        implicitWidth: Theme.touchTarget
        implicitHeight: Theme.touchTarget
        hoverEnabled: true
        contentItem: SymbolIcon {
            name: softTool.symbol
            color: !softTool.enabled ? Theme.inkFaint : Theme.inkMuted
            scale: softTool.down ? 0.94 : 1
            opacity: softTool.down ? 0.82 : 1
            Behavior on scale { enabled: window.motionEnabled; NumberAnimation { duration: softTool.down ? Theme.durPress : Theme.durRelease; easing.type: Easing.OutCubic } }
        }
        background: Surface {
            x: 4 - 8; y: 4 - 8; width: 40 + 16; height: 40 + 16; margin: 8
            cornerRadius: 20; inset: softTool.down
            focused: softTool.activeFocus; disabled: !softTool.enabled; hovered: softTool.hovered
        }
    }
    Image {
        id: themeOverlay
        anchors.fill: parent; z: 1000; visible: false
    }
    SequentialAnimation {
        id: themeFade
        NumberAnimation { target: themeOverlay; property: "opacity"; from: 1; to: 0; duration: Theme.durPanel; easing.type: Easing.OutCubic }
        ScriptAction { script: { themeOverlay.visible = false; themeOverlay.source = ""; themeSnapshot = null } }
    }
    RowLayout {
        id: mainLayout
        anchors.fill: parent
        spacing: 0
        Rectangle {
            Layout.preferredWidth: Theme.hostSidebar; Layout.fillHeight: true
            color: Theme.surfaceBase
            ColumnLayout {
                anchors.fill: parent; anchors.margins: 20; spacing: 10
                RowLayout {
                    Layout.topMargin: 18; Layout.bottomMargin: 3; spacing: 10
                    Image { source: "qrc:/src/assets/orbis.png"; Layout.preferredWidth: 40; Layout.preferredHeight: 40; smooth: true }
                    EngravedWordmark { text: "Orbis" }
                }
                Label { text: "Easy Agents Everywhere"; color: Theme.inkMuted; font.pixelSize: Theme.caption; Layout.leftMargin: 4; Layout.bottomMargin: 36 }
                Repeater {
                    model: window.pageNames
                    delegate: Button {
                        id: pageButton
                        objectName: "page-button-" + index
                        property real selectionProgress: window.page === index || down ? 1 : 0
                        Behavior on selectionProgress { enabled: window.motionEnabled; NumberAnimation { duration: Theme.durSelection; easing.type: Easing.OutCubic } }
                        Accessible.role: Accessible.PageTab
                        Accessible.name: modelData
                        Accessible.selected: window.page === index
                        required property string modelData
                        required property int index
                        Layout.fillWidth: true; implicitHeight: 48
                        onClicked: window.selectPage(index)
                        contentItem: RowLayout {
                            spacing: 15
                            SymbolIcon { name: ["computer", "qr_code_scanner", "tune", "settings", "menu"][index]; color: window.page === index ? Theme.accent : Theme.inkMuted; Layout.leftMargin: 16; Layout.preferredWidth: Theme.iconMd; Layout.preferredHeight: Theme.iconMd }
                            Label { text: modelData; color: window.page === index ? Theme.accent : Theme.inkMuted; font.weight: window.page === index ? Font.DemiBold : Font.Normal; Layout.fillWidth: true }
                            Rectangle { Layout.preferredWidth: 8; Layout.preferredHeight: 8; radius: 4; color: Theme.warning; visible: window.pageHasUpdate(index) }
                        }
                        background: Item {
                            Surface { anchors.fill: parent; anchors.margins: -12; margin: 12; cornerRadius: Theme.radiusMd; inset: false; opacity: (pageButton.hovered || pageButton.activeFocus ? 1 : 0) * (1 - pageButton.selectionProgress); focused: pageButton.activeFocus }
                            Surface { anchors.fill: parent; anchors.margins: -12; margin: 12; cornerRadius: Theme.radiusMd; inset: true; opacity: pageButton.selectionProgress; focused: pageButton.activeFocus }
                        }
                    }
                }
                Item { Layout.fillHeight: true }
                Rectangle { Layout.fillWidth: true; height: 1; color: Theme.hairline }
                RowLayout {
                    Layout.topMargin: 14; spacing: 9
                    StatusDot { color: window.hostOnline ? Theme.success : window.hostLinking ? Theme.warning : Theme.inkFaint; idle: host.state === "stopped" && !host.resumePending; syncing: window.hostLinking }
                    Label { text: stateText(); color: Theme.inkMuted; font.pixelSize: Theme.caption }
                }
                Label { text: Qt.platform.os === "osx" ? "macOS v" + host.version : "Windows v" + host.version; color: Theme.inkMuted; font.pixelSize: Theme.caption; Layout.bottomMargin: 10 }
            }
        }
        ColumnLayout {
            Layout.fillWidth: true; Layout.fillHeight: true; spacing: 0
            Rectangle {
                Layout.fillWidth: true; Layout.preferredHeight: 82; color: Theme.surfaceBase
                Rectangle { anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom; height: 1; color: Theme.hairline }
                RowLayout {
                    anchors.fill: parent; anchors.leftMargin: 40; anchors.rightMargin: 40
                    ColumnLayout {
                        spacing: 7
                        Label { text: window.pageNames[window.page]; font.pixelSize: Theme.display; font.weight: Font.DemiBold; color: Theme.ink }
                        Hint { text: ["让电脑上的 Agent，随时与你连接。", "管理这台电脑信任的手机。", "管理电脑上的 Agent。", "按照你的工作习惯设置 Orbis。", "了解连接状态，快速定位问题。"][window.page] }
                    }
                    Item { Layout.fillWidth: true }
                    Rectangle {
                        implicitWidth: statusLabel.implicitWidth + 32; implicitHeight: 32; radius: 16
                        color: host.state === "connected" ? Theme.surfaceBase : Theme.surfaceBase
                        MotionText { id: statusLabel; anchors.centerIn: parent; text: stateText(); color: host.state === "connected" ? Theme.success : Theme.inkMuted; font.pixelSize: Theme.caption }
                    }
                }
            }
            Rectangle {
                visible: host.message.length > 0 && !(window.page === 0 && window.connectionError && host.activated)
                Layout.fillWidth: true; Layout.leftMargin: 40; Layout.rightMargin: 40; Layout.bottomMargin: 16
                implicitHeight: messageLabel.implicitHeight + 24; radius: Theme.radiusMd; color: Theme.surfaceBase
                RowLayout {
                    anchors.fill: parent; anchors.margins: 12
                    MotionText { id: messageLabel; text: host.message; Layout.fillWidth: true; wrapMode: Text.WordWrap; color: Theme.inkMuted; font.pixelSize: Theme.label }
                    SoftToolButton { symbol: "close"; onClicked: host.clearMessage(); implicitWidth: Theme.touchTarget; implicitHeight: Theme.touchTarget; Accessible.name: "关闭提示" }
                }
            }
            Rectangle {
                visible: !window.updateNoticeDismissed && (host.hostUpdateAvailable || window.agentUpdatesAvailable() || window.androidUpdatesAvailable())
                Layout.fillWidth: true; Layout.leftMargin: 40; Layout.rightMargin: 40; Layout.bottomMargin: 14
                implicitHeight: updateNoticeRow.implicitHeight + 22; radius: Theme.radiusMd; color: Theme.surfaceBase
                RowLayout {
                    id: updateNoticeRow
                    anchors.fill: parent; anchors.leftMargin: 14; anchors.rightMargin: 10; anchors.topMargin: 8; anchors.bottomMargin: 8; spacing: 12
                    Label { text: "发现可用更新：" + window.availableUpdatesText(); Layout.fillWidth: true; wrapMode: Text.WordWrap; color: Theme.warning; font.pixelSize: Theme.label }
                    ActionButton { text: "更新 Host"; visible: host.hostUpdateAvailable; enabled: !host.busy; onClicked: host.updateHost() }
                    ActionButton { text: "查看 Agent"; visible: window.agentUpdatesAvailable(); onClicked: window.goAgent(host.claudeUpdateAvailable && window.agentEnabled("claude") ? "claude" : host.agents.find(agent => agent.updateAvailable && window.agentEnabled(agent.kind))?.kind || "") }
                    ActionButton { text: "查看设备"; visible: window.androidUpdatesAvailable(); onClicked: window.selectPage(1) }
                    SoftToolButton { symbol: "close"; onClicked: window.updateNoticeDismissed = true; implicitWidth: Theme.touchTarget; implicitHeight: Theme.touchTarget; Accessible.name: "关闭更新提示" }
                }
            }
            ScrollView {
                id: scroll; objectName: "pageScroll"
                Layout.fillWidth: true; Layout.fillHeight: true
                clip: true
                ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
                contentWidth: availableWidth
                ColumnLayout {
                    id: pageContent
                    property real entryProgress: 1
                    opacity: entryProgress
                    transform: Translate { x: 24 * (1 - pageContent.entryProgress) }
                    NumberAnimation { id: pageArrival; target: pageContent; property: "entryProgress"; from: 0; to: 1; duration: Theme.durPage; easing.type: Easing.OutCubic }
                    width: Math.min(Theme.contentWidth, scroll.availableWidth - 80)
                    x: (scroll.availableWidth - width) / 2; spacing: 24
                    Item { Layout.preferredHeight: 22 }

                    ColumnLayout {
                        visible: window.page === 0
                        Layout.fillWidth: true; spacing: 20
                        // HOST-GUIDE-01: once set up, a temporary disconnect does not reopen the guide.
                        RowLayout {
                            objectName: "overviewGuide"
                            visible: !window.setupComplete && window.setupStep >= 0
                            Layout.fillWidth: true; spacing: 0
                            Repeater {
                                model: ["激活", "连接", "添加手机", "启用 Agent", "安装 Agent"]
                                delegate: RowLayout {
                                    required property int index
                                    required property string modelData
                                    Layout.fillWidth: true; spacing: 6
                                    Rectangle {
                                        Layout.preferredWidth: 22; Layout.preferredHeight: 22; radius: 11
                                        color: index === window.setupStep ? Theme.accentSoft : Theme.surfaceLift
                                        Label { anchors.centerIn: parent; text: index < window.setupStep ? "✓" : String(index + 1); color: index === window.setupStep ? Theme.accent : index < window.setupStep ? Theme.success : Theme.inkMuted; font.pixelSize: Theme.caption }
                                    }
                                    Label { text: modelData; color: index === window.setupStep ? Theme.ink : Theme.inkMuted; font.pixelSize: Theme.caption; elide: Text.ElideRight; Layout.fillWidth: true }
                                }
                            }
                        }
                        // Activation leads until it is done.
                        RowLayout {
                            visible: !host.activated && !host.credentialsLoading
                            Layout.fillWidth: true; spacing: 20
                            Card {
                                Layout.fillWidth: true; Layout.preferredWidth: 510
                                ColumnLayout {
                                    anchors.fill: parent; spacing: 15
                                    Heading { text: "连接，从这里开始" }
                                    Hint { visible: host.verificationRequired && !host.registrationAvailable; text: "邮箱注册暂未开放"; Layout.fillWidth: true; Layout.bottomMargin: 9 }
                                    Label { visible: host.verificationRequired; text: "QQ 邮箱"; color: Theme.inkMuted; font.pixelSize: Theme.label }
                                    Field {
                                        id: emailField; visible: host.verificationRequired; objectName: "registrationEmail"
                                        // HOST-ACT-13: status ticks must not overwrite a user's draft or selection.
                                        readonly property string activationContext: JSON.stringify([host.relayUrl, host.hostId, host.email])
                                        onActivationContextChanged: { text = host.email; if (codeField) codeField.clear() }
                                        Component.onCompleted: text = host.email
                                        placeholderText: "你的邮箱@qq.com"; Layout.fillWidth: true
                                        inputMethodHints: Qt.ImhEmailCharactersOnly; enabled: !host.busy; Accessible.name: "QQ 邮箱"
                                    }
                                    Label { visible: host.verificationRequired; text: "邮箱验证码"; color: Theme.inkMuted; font.pixelSize: Theme.label }
                                    RowLayout {
                                        visible: host.verificationRequired; Layout.fillWidth: true; spacing: 10
                                        Field { id: codeField; objectName: "verificationCode"; placeholderText: "6 位验证码"; Layout.fillWidth: true; maximumLength: 6; validator: RegularExpressionValidator { regularExpression: /[0-9]{0,6}/ } Accessible.name: "验证码" }
                                        ActionButton { text: host.cooldown > 0 ? host.cooldown + " 秒后重发" : "获取验证码"; enabled: host.bridgeReady && host.registrationAvailable && !host.busy && host.cooldown === 0; onClicked: host.requestCode(emailField.text) }
                                    }
                                    ActionButton { objectName: "overviewActivate"; text: host.busy ? "正在处理…" : host.verificationRequired ? "注册并激活" : "直接激活"; primary: true; Layout.fillWidth: true; Layout.topMargin: 7; enabled: host.bridgeReady && host.registrationAvailable && !host.busy; onClicked: { if (host.verificationRequired) host.activate(emailField.text, codeField.text); else host.activateWithoutEmail() } }
                                    ActionButton { objectName: "activateAsNewComputer"; text: "作为新电脑激活"; visible: host.identityReplaceable; Layout.fillWidth: true; enabled: host.bridgeReady && !host.busy; onClicked: newComputerDialog.open() }
                                    Hint { visible: host.verificationRequired && !host.registrationAvailable; text: "邮箱注册暂未开放"; Layout.fillWidth: true }
                                }
                            }
                        }
                        Card {
                            objectName: "overviewLink"
                            Layout.fillWidth: true
                            ColumnLayout {
                                anchors.fill: parent; spacing: 18
                                RowLayout {
                                    Layout.fillWidth: true; spacing: 16
                                    NodeDisc { symbol: "computer"; lit: window.hostOnline }
                                    ColumnLayout {
                                        spacing: 4; Layout.preferredWidth: 180; Layout.maximumWidth: 220
                                        Heading { text: host.hostName || "这台电脑"; elide: Text.ElideRight; Layout.fillWidth: true }
                                        MotionText { objectName: "overviewLinkState"; text: window.stateText(); color: window.hostOnline ? Theme.success : host.state === "error" && !host.resumePending ? Theme.danger : Theme.inkMuted; font.pixelSize: Theme.label; Layout.fillWidth: true }
                                        // 按钮变灰时能读到这里在做什么：没有这句就只能看到“点了没反应”。
                                        RowLayout {
                                            objectName: "overviewActivity"
                                            visible: window.activityText.length > 0
                                            spacing: 6; Layout.fillWidth: true
                                            BusyIndicator { running: visible; Layout.preferredWidth: 14; Layout.preferredHeight: 14 }
                                            Label { text: window.activityText; color: Theme.inkMuted; font.pixelSize: Theme.caption; elide: Text.ElideRight; Layout.fillWidth: true }
                                        }
                                    }
                                    ColumnLayout {
                                        Layout.fillWidth: true; Layout.minimumWidth: 60; spacing: 2
                                        ConnectionLine { Layout.fillWidth: true }
                                        Hint { visible: window.publicPath.length > 0; text: window.publicPath; Layout.alignment: Qt.AlignHCenter }
                                    }
                                    ColumnLayout {
                                        spacing: 4; Layout.preferredWidth: 110
                                        RowLayout {
                                            spacing: 6; Layout.alignment: Qt.AlignRight
                                            MotionText { objectName: "home-metric-0"; roll: true; text: String(host.devices.length); font.pixelSize: Theme.title; font.weight: Font.DemiBold; color: Theme.ink; horizontalAlignment: Text.AlignRight }
                                            Label { text: "台手机"; color: Theme.inkMuted; font.pixelSize: Theme.label }
                                        }
                                        Label { text: window.onlineDevices + " 台在线"; visible: window.hostOnline && host.devices.length > 0; color: window.onlineDevices > 0 ? Theme.success : Theme.inkMuted; font.pixelSize: Theme.label; Layout.alignment: Qt.AlignRight }
                                    }
                                    NodeDisc { symbol: "smartphone"; lit: window.hostOnline && window.onlineDevices > 0 }
                                }
                                RowLayout {
                                    visible: window.connectionError && host.activated; Layout.fillWidth: true
                                    Hint { text: host.message || "无法连接 Host"; color: Theme.danger; Layout.fillWidth: true }
                                    ActionButton { text: "诊断"; onClicked: window.selectPage(4) }
                                    ActionButton { objectName: "overviewRetry"; text: "重试"; primary: true; enabled: host.connectionBlockReason.length === 0; onClicked: host.startHost() }
                                }
                                Flow {
                                    objectName: "overviewDevices"
                                    visible: host.devices.length > 0; Layout.fillWidth: true; spacing: 8
                                    Repeater {
                                        model: host.devices
                                        delegate: ActionButton {
                                            required property var modelData
                                            readonly property string path: window.hostOnline ? (modelData.path || "offline") : "offline"
                                            text: (modelData.label || "手机") + " · " + (path === "lan" ? "局域网" : path === "relay" ? "中继" : "离线")
                                            onClicked: window.selectPage(1)
                                        }
                                    }
                                }
                                RowLayout {
                                    // While the saved activation is still being read, keep Connect visible and say why it waits.
                                    visible: (host.activated || host.credentialsLoading) && !window.connectionError
                                    Layout.fillWidth: true; spacing: 12
                                    Item { Layout.fillWidth: true }
                                    ActionButton {
                                        objectName: "overviewConnection"
                                        text: host.desiredRunning || host.resumePending ? "暂停连接" : "开始连接"
                                        primary: window.nextStep === "connect" && !window.hostLinking
                                        enabled: !host.resumePending && (host.desiredRunning || host.connectionBlockReason.length === 0)
                                        loading: window.activityKinds.indexOf("connect") >= 0
                                        onClicked: { if (host.desiredRunning) host.stopHost(); else host.startHost() }
                                        // 点不了的时候给出原因，而不是只把按钮变灰。
                                        ToolTip.visible: !enabled && hoverHandler.hovered && host.connectionBlockReason.length > 0
                                        ToolTip.text: host.connectionBlockReason
                                        ToolTip.delay: 200
                                        HoverHandler { id: hoverHandler }
                                    }
                                    ActionButton { objectName: "overviewPair"; text: "添加手机"; symbol: "add"; primary: window.nextStep === "pair"; enabled: window.hostOnline && !host.busy; loading: window.activityKinds.indexOf("pair") >= 0; onClicked: host.pair() }
                                }
                            }
                        }
                        Card {
                            objectName: "overviewAgents"
                            Layout.fillWidth: true
                            ColumnLayout {
                                anchors.fill: parent; spacing: 6
                                RowLayout {
                                    Layout.fillWidth: true; Layout.bottomMargin: 6
                                    Heading { text: "Agent" }
                                    Hint { text: window.enabledAgentCount + " / " + window.agentRows.length + " 已启用"; Layout.fillWidth: true }
                                    ActionButton { text: "管理"; onClicked: window.goAgent("") }
                                }
                                RowLayout {
                                    visible: window.overviewAgents.length === 0; Layout.fillWidth: true
                                    Hint { text: window.agentRows.length ? "还没有启用的 Agent" : "正在读取 Agent"; Layout.fillWidth: true }
                                    ActionButton { objectName: "overviewEnableAgents"; text: "启用 Agent"; visible: window.agentRows.length > 0; primary: window.nextStep === "enable"; onClicked: window.goAgent("") }
                                }
                                Repeater {
                                    model: window.overviewAgents
                                    delegate: RowLayout {
                                        id: agentRow
                                        required property var modelData
                                        readonly property var backend: window.backendFor(modelData.kind)
                                        readonly property int sessions: window.hostOnline && backend ? backend.runtimeCount : 0
                                        readonly property bool reachable: window.agentReachable(modelData)
                                        readonly property string cliHint: window.agentCliHint(modelData)
                                        // CODEX-DESKTOP-MAC-RECOVERY-01: local opening remains available even without phone attachment.
                                        readonly property bool desktopNotice: modelData.kind === "codexDesktop" && window.codexDesktopNeedsAttention
                                        readonly property bool pathAction: !!cliHint || !!host.agentEntryOverrides[modelData.kind]
                                        readonly property bool installable: modelData.data !== undefined
                                        Layout.fillWidth: true; Layout.preferredHeight: Theme.controlHeight + 8; spacing: 14
                                        Accessible.role: Accessible.ListItem
                                        Accessible.name: modelData.name + "，" + window.agentPhoneState(modelData, sessions)
                                        Accessible.onPressAction: window.goAgent(agentRow.modelData.kind)
                                        activeFocusOnTab: true
                                        HoverHandler { id: overviewRowHover }
                                        TapHandler {
                                            onTapped: point => {
                                                const x = point.position.x
                                                if (x < overviewAgentStatus.x || (x > overviewAgentStatus.x + overviewAgentStatus.width && (!overviewAgentAction.visible || x < overviewAgentAction.x))) window.goAgent(agentRow.modelData.kind)
                                            }
                                        }
                                        Keys.onReturnPressed: window.goAgent(agentRow.modelData.kind)
                                        Keys.onSpacePressed: window.goAgent(agentRow.modelData.kind)
                                        Rectangle { anchors.fill: parent; z: -1; radius: Theme.radiusSm; color: Theme.surfaceLift; visible: overviewRowHover.hovered || agentRow.activeFocus }
                                        Item {
                                            Layout.preferredWidth: Theme.iconMd; Layout.preferredHeight: Theme.iconMd
                                            opacity: agentRow.modelData.installed === false ? 0.4 : 1
                                            AgentMark {
                                                id: overviewMark
                                                objectName: "overviewAgentMark-" + agentRow.modelData.kind
                                                anchors.fill: parent; kind: agentRow.modelData.kind; visible: hasMark
                                            }
                                            SymbolIcon { anchors.fill: parent; visible: !overviewMark.hasMark; name: "chat_bubble"; color: Theme.inkMuted }
                                        }
                                        Label { text: agentRow.modelData.name; color: agentRow.modelData.installed === false ? Theme.inkFaint : Theme.ink; font.pixelSize: Theme.body; elide: Text.ElideRight; Layout.fillWidth: true }
                                        Item {
                                            id: overviewAgentStatus
                                            Layout.preferredWidth: Math.max(72, agentStatusRow.implicitWidth); Layout.preferredHeight: Theme.touchTarget
                                            RowLayout {
                                                id: agentStatusRow
                                                anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; spacing: 4
                                                Label {
                                                    objectName: agentRow.modelData.kind === "codexDesktop" ? "overviewCodexDesktopNotice" : ""
                                                    visible: agentRow.desktopNotice
                                                    text: visible ? window.codexDesktopLabel() : ""
                                                    color: window.codexDesktopColor(); font.pixelSize: Theme.label
                                                }
                                                Label { visible: !agentRow.desktopNotice; text: window.agentPhoneState(agentRow.modelData, 0); color: agentRow.reachable ? Theme.success : Theme.inkMuted; font.pixelSize: Theme.label }
                                                SymbolIcon { visible: agentRow.sessions > 0; name: "chat_bubble"; color: Theme.success; Layout.preferredWidth: Theme.iconXs; Layout.preferredHeight: Theme.iconXs }
                                                MotionText { objectName: "overviewAgentSessions-" + agentRow.modelData.kind; visible: agentRow.sessions > 0; roll: true; text: String(agentRow.sessions); color: Theme.success; font.pixelSize: Theme.label; font.weight: Font.DemiBold; Layout.rightMargin: 6 }
                                                Item {
                                                    id: agentState
                                                    objectName: "overviewAgentState-" + agentRow.modelData.kind
                                                    readonly property bool hintVisible: agentHint.visible
                                                    readonly property bool preparing: window.preparing(agentRow.modelData.kind)
                                                    readonly property bool canEdit: agentRow.pathAction && !host.busy && !window.agentCliDetecting(agentRow.modelData.kind)
                                                    readonly property bool canAct: canEdit || agentRow.desktopNotice
                                                    readonly property string detail: agentRow.desktopNotice ? window.codexDesktopReason()
                                                        : agentRow.cliHint || window.agentPhoneState(agentRow.modelData, agentRow.sessions)
                                                            + (agentRow.pathAction && canEdit ? "。点击圆点管理 CLI 路径。" : "")
                                                    function activate() {
                                                        if (agentRow.desktopNotice) window.selectPage(4)
                                                        else if (canEdit) window.showAgentEntry(agentRow.modelData)
                                                    }
                                                    Layout.preferredWidth: Theme.touchTarget; Layout.preferredHeight: Theme.touchTarget
                                                    activeFocusOnTab: canAct
                                                    Accessible.role: canAct ? Accessible.Button : Accessible.StaticText
                                                    Accessible.name: agentRow.modelData.name + "，" + detail
                                                    Accessible.description: agentRow.desktopNotice ? "查看接入诊断" : canEdit && !agentRow.cliHint ? "管理手动指定的 CLI 路径" : ""
                                                    Accessible.onPressAction: agentState.activate()
                                                    ToolTip {
                                                        id: agentHint
                                                        objectName: "overviewAgentHint-" + agentRow.modelData.kind
                                                        visible: dotHover.hovered || (agentState.canAct && agentState.activeFocus)
                                                        delay: 300; width: Math.min(implicitWidth, 320); text: agentState.detail
                                                    }
                                                    HoverHandler { id: dotHover; cursorShape: agentState.canAct ? Qt.PointingHandCursor : Qt.ArrowCursor }
                                                    TapHandler { enabled: agentState.canAct; onTapped: agentState.activate() }
                                                    Keys.onReturnPressed: agentState.activate()
                                                    Keys.onSpacePressed: agentState.activate()
                                                    Rectangle { anchors.fill: parent; radius: Theme.radiusSm; color: "transparent"; border.color: Theme.accent; visible: agentState.activeFocus && agentState.canAct }
                                                    StatusDot {
                                                        anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                                                        color: agentRow.desktopNotice ? window.codexDesktopColor() : agentRow.cliHint || agentRow.modelData.broken ? Theme.warning : agentRow.reachable ? Theme.success : window.hostLinking || agentState.preparing ? Theme.warning : Theme.inkFaint
                                                        idle: !agentRow.desktopNotice && !agentRow.modelData.broken && !agentRow.reachable && (agentRow.modelData.installed === false || agentRow.modelData.installed === true && !window.hostLinking && !agentState.preparing)
                                                        syncing: !agentRow.desktopNotice && !agentRow.cliHint && !agentRow.modelData.broken && (window.hostLinking || agentState.preparing || window.agentCliDetecting(agentRow.modelData.kind))
                                                    }
                                                }
                                            }
                                        }
                                        Item { visible: agentRow.modelData.passive === true; Layout.preferredWidth: 112 }
                                        ActionButton {
                                            id: overviewAgentAction
                                            objectName: "overviewAgent-" + agentRow.modelData.kind
                                            visible: agentRow.modelData.passive !== true
                                            Layout.preferredWidth: 112
                                            text: window.overviewAgentActionText(agentRow.modelData, agentRow.installable)
                                            primary: window.overviewAgentActionPrimary(agentRow.modelData, agentRow.installable)
                                            enabled: window.overviewAgentActionEnabled(agentRow.modelData, agentRow.installable)
                                            loading: host.agentInstalling && host.agentInstallKind === agentRow.modelData.kind
                                                || agentRow.modelData.kind === "dshDesktop" && host.dshDesktopOpen !== "idle"
                                            Accessible.name: text + " " + agentRow.modelData.name
                                            onClicked: {
                                                if (agentRow.installable && (agentRow.modelData.installed === false || agentRow.modelData.broken)) window.showAgentInstaller(agentRow.modelData.data)
                                                else window.openOverviewAgent(agentRow.modelData.kind)
                                            }
                                        }
                                    }
                                }
                                DownloadBar { visible: host.downloadReceived >= 0 && host.agentInstalling; label: window.agentName(host.agentInstallKind) + " 下载"; received: host.downloadReceived; total: host.downloadTotal; Layout.fillWidth: true; Layout.topMargin: 6 }
                                // 终端接入的配套包不在启动关键路径上：手机已经能连，这里只显示它还差多少。
                                DownloadBar {
                                    visible: window.agentEnabled("codex") && window.codexTerminalPreparing && window.codexTerminalState.receivedBytes > 0
                                    label: "Codex 终端接入"
                                    received: window.codexTerminalState.receivedBytes || 0
                                    total: window.codexTerminalState.totalBytes || 0
                                    Layout.fillWidth: true; Layout.topMargin: 6
                                }
                                Hint { visible: window.agentEnabled("codex") && window.codexTerminalState.state === "error"; text: "Codex 终端接入未就绪，Codex 会话暂时不可用"; Layout.fillWidth: true; Layout.topMargin: 6 }
                                // HOST-PREP-04: a failed automatic registration only affects Claude Code started in a terminal.
                                Hint { visible: window.agentEnabled("claude") && window.preparationOf("claude").state === "error"; text: "Claude Code 插件未登记，终端里运行的 Claude Code 暂时不会连接 Orbis"; Layout.fillWidth: true; Layout.topMargin: 6 }
                            }
                        }
                    }

                    ColumnLayout {
                        visible: window.page === 1; Layout.fillWidth: true; spacing: 16
                        RowLayout {
                            Layout.fillWidth: true
                            Heading { text: "已配对设备" }
                            Item { Layout.fillWidth: true }
                            // HOST-IOS-DOWNLOAD-01: both platforms share the download dialog with their own QR target.
                            ActionButton { objectName: "downloadAndroidClient"; text: window.androidUpdatesAvailable() ? "更新Android客户端" : "下载Android客户端"; visible: host.appDownloadQr.length > 0; onClicked: { appDownloadDialog.platform = "android"; appDownloadDialog.open() } }
                            ActionButton { objectName: "downloadIosClient"; text: "下载iOS客户端"; visible: host.iosAppDownloadQr.length > 0; onClicked: { appDownloadDialog.platform = "ios"; appDownloadDialog.open() } }
                            ActionButton { text: "添加手机"; symbol: "add"; primary: true; enabled: host.state === "connected" && !host.busy; onClicked: host.pair() }
                        }
                        Card {
                            visible: host.devices.length === 0; Layout.fillWidth: true
                            Heading { text: "还没有连接的手机" }
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
                                        Heading { text: modelData.label || "手机（" + modelData.deviceId.slice(0, 8) + "）"; font.pixelSize: Theme.body }
                                        Hint { text: "连接方式：" + (({lan: "局域网直连", relay: "中继", offline: "离线"})[modelData.path || "offline"]) }
                                        Hint { text: modelData.lastSeen ? "最近连接：" + new Date(modelData.lastSeen).toLocaleString(Qt.locale(), "MM-dd hh:mm") : "配对时间：" + new Date(modelData.createdAt * 1000).toLocaleDateString(); font.pixelSize: Theme.caption }
                                        Hint { visible: modelData.androidUpdateAvailable; text: "Android " + modelData.appVersion + " → " + modelData.latestAndroidVersion; color: Theme.warning }
                                    }
                                    ActionButton { text: "重命名"; enabled: host.bridgeReady && !host.busy; onClicked: { window.revokeId = modelData.deviceId; deviceNameField.text = modelData.label || ""; renameDialog.open() } }
                                    ActionButton { text: "撤销配对"; danger: true; enabled: host.bridgeReady && !host.busy; onClicked: { window.revokeId = modelData.deviceId; revokeDialog.open() } }
                                }
                            }
                        }
                    }

                    ColumnLayout {
                        visible: window.page === 2; Layout.fillWidth: true; spacing: 16
                        RowLayout {
                            Layout.fillWidth: true; spacing: 12
                            Heading { text: "Agent"; font.pixelSize: Theme.display }
                            Hint { text: window.enabledAgentCount + " / " + window.agentRows.length + " 已启用"; visible: window.agentRows.length > 0 }
                            Item { Layout.fillWidth: true }
                            ActionButton { text: "检查更新"; enabled: host.bridgeReady && !host.busy && window.activityKinds.indexOf("agents") < 0; loading: window.activityKinds.indexOf("agents") >= 0; onClicked: host.detectAgents(true) }
                        }
                        Hint { visible: host.bridgeReady && !window.agentRows.length; text: "无法读取 Agent 设置，请检查 Host 状态目录后重启 Host。"; Layout.fillWidth: true }
                        RowLayout {
                            Layout.fillWidth: true; spacing: 20
                            ColumnLayout {
                                Layout.preferredWidth: 312; Layout.minimumWidth: 255; Layout.alignment: Qt.AlignTop; spacing: 10
                                Card {
                                    id: agentRail
                                    objectName: "agentRail"
                                    padding: 8; Layout.fillWidth: true; activeFocusOnTab: true
                                    Accessible.role: Accessible.List
                                    Accessible.name: "Agent"
                                    Keys.onPressed: event => {
                                        const ids = window.agentRows.map(row => row.kind)
                                        if (!ids.length) return
                                        if (event.key === Qt.Key_Up || event.key === Qt.Key_Down || event.key === Qt.Key_Home || event.key === Qt.Key_End) {
                                            const i = Math.max(0, ids.indexOf(window.detailKind))
                                            window.chooseAgent(ids[event.key === Qt.Key_Home ? 0 : event.key === Qt.Key_End ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, i + (event.key === Qt.Key_Down ? 1 : -1)))], event.modifiers)
                                        } else if (event.key === Qt.Key_Space) window.flipAgent(window.detailKind)
                                        else if (event.key === Qt.Key_Escape) window.selectedAgents = []
                                        else return
                                        event.accepted = true
                                    }
                                    ColumnLayout {
                                        anchors.fill: parent; spacing: 2
                                        Repeater {
                                            model: window.agentRows
                                            delegate: Item {
                                                id: railRow
                                                required property var modelData
                                                readonly property string kind: modelData.kind
                                                readonly property bool chosen: window.detailKind === kind
                                                readonly property bool multi: window.selectedAgents.includes(kind)
                                                readonly property var change: window.choiceFor(kind)
                                                readonly property var state: window.agentStatus(modelData)
                                                objectName: "agent-rail-" + kind
                                                Layout.fillWidth: true; Layout.preferredHeight: 52
                                                Accessible.role: Accessible.ListItem
                                                Accessible.name: modelData.label + "，" + state.text
                                                Accessible.onPressAction: window.chooseAgent(kind, 0)
                                                Rectangle {
                                                    anchors.fill: parent; radius: Theme.radiusMd
                                                    color: railRow.chosen || rowHover.hovered ? Theme.surfaceLift : "transparent"
                                                    border.color: Theme.accent; border.width: railRow.multi || railRow.chosen && agentRail.activeFocus ? 1.5 : 0
                                                }
                                                Rectangle {
                                                    x: 2; y: railRow.kind === "codex" || railRow.kind === "dsh" ? parent.height / 2 : 0
                                                    radius: 1; width: 2; height: parent.height / 2 + 1; color: Theme.hairline
                                                    visible: ["codex", "codexDesktop", "dsh", "dshDesktop"].includes(railRow.kind)
                                                }
                                                HoverHandler { id: rowHover }
                                                TapHandler { acceptedButtons: Qt.RightButton; onTapped: { window.chooseAgent(railRow.kind, 0); agentMenu.popup() } }
                                                Menu {
                                                    id: agentMenu
                                                    MenuItem { text: railRow.change && railRow.change.withdrawable ? "撤回排队" : railRow.modelData.enabled ? "停用" : "启用"; enabled: window.canEditAgent && (!railRow.change || railRow.change.withdrawable); onTriggered: window.flipAgent(railRow.kind) }
                                                    MenuItem { text: "供应商配置"; visible: !!window.providerGroup(railRow.kind); enabled: railRow.modelData.enabled && !host.busy; onTriggered: window.openProviders(window.providerGroup(railRow.kind)) }
                                                    MenuItem { text: "复制诊断信息"; onTriggered: host.copyDiagnostics() }
                                                }
                                                RowLayout {
                                                    anchors.fill: parent; anchors.leftMargin: 10; anchors.rightMargin: 8; spacing: 9
                                                    id: railControls
                                                    Label { text: "▸"; color: Theme.accent; opacity: railRow.chosen ? 1 : 0; Accessible.ignored: true }
                                                    AgentMark { kind: railRow.kind; visible: hasMark; opacity: window.agentVisualOn(railRow.modelData) ? 1 : 0.45 }
                                                    ColumnLayout {
                                                        Layout.fillWidth: true; spacing: 1
                                                        Label { text: railRow.modelData.label; font.pixelSize: Theme.body; color: Theme.ink; font.weight: Font.DemiBold; elide: Text.ElideRight; Layout.fillWidth: true }
                                                        Label { text: railRow.state.text; font.pixelSize: Theme.caption; color: railRow.state.color; elide: Text.ElideRight; Layout.fillWidth: true }
                                                    }
                                                    StatusDot { color: railRow.state.color; idle: railRow.state.idle === true; syncing: railRow.state.sync === true }
                                                    AgentLatch {
                                                        id: railLatch
                                                        objectName: "enableAgent-" + railRow.kind
                                                        Accessible.name: railRow.modelData.label
                                                        powered: window.agentVisualOn(railRow.modelData); change: railRow.change; tint: Theme.agent(railRow.kind)
                                                        failed: window.agentFeedback.status === "conflict" && (window.agentFeedback.kinds || []).includes(railRow.kind)
                                                        enabled: window.canEditAgent && (!change || change.withdrawable)
                                                        onClicked: window.flipAgent(railRow.kind)
                                                    }
                                                }
                                                // The latch and the row own disjoint hit regions, including when the latch is waiting.
                                                Item {
                                                    anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom
                                                    width: railControls.x + railLatch.x
                                                    TapHandler { onTapped: point => { window.chooseAgent(railRow.kind, point.modifiers); agentRail.forceActiveFocus() } }
                                                }
                                            }
                                        }
                                    }
                                }
                                Card {
                                    visible: window.selectedAgents.length > 0; Layout.fillWidth: true; padding: 10
                                    RowLayout {
                                        anchors.fill: parent
                                        Hint { text: "已选 " + window.selectedAgents.length; Layout.fillWidth: true }
                                        ActionButton { text: "启用"; enabled: window.canEditAgent && window.selectedAgents.some(kind => !window.agentEnabled(kind)) && !window.selectedAgents.some(kind => window.choiceFor(kind)); onClicked: host.setAgentsEnabled(window.selectedAgents, true) }
                                        ActionButton { text: "停用"; enabled: window.canEditAgent && window.selectedAgents.some(kind => window.agentEnabled(kind)) && !window.selectedAgents.some(kind => window.choiceFor(kind)); onClicked: host.setAgentsEnabled(window.selectedAgents, false) }
                                        ActionButton { text: "取消"; onClicked: window.selectedAgents = [] }
                                    }
                                }
                            }
                            Card {
                                id: agentDetail
                                objectName: "agentDetail"
                                visible: window.selectedAgentRow !== null; Layout.fillWidth: true; Layout.minimumWidth: 390; Layout.alignment: Qt.AlignTop
                                padding: 20
                                contentHeight: Math.max(520, detailColumn.implicitHeight)
                                ColumnLayout {
                                    id: detailColumn
                                    width: parent.width; spacing: 16
                                    RowLayout {
                                        Layout.fillWidth: true
                                        AgentMark { kind: window.detailKind; visible: hasMark; opacity: window.agentVisualOn(window.selectedAgentRow) ? 1 : 0.45 }
                                        ColumnLayout {
                                            Layout.fillWidth: true; spacing: 3
                                            Heading { text: window.selectedAgentRow ? window.selectedAgentRow.label : ""; Layout.fillWidth: true; elide: Text.ElideRight }
                                            Hint { text: window.selectedAgentRow ? window.agentStatus(window.selectedAgentRow).text : ""; color: window.selectedAgentRow ? window.agentStatus(window.selectedAgentRow).color : Theme.inkMuted }
                                        }
                                        AgentLatch { powered: window.agentVisualOn(window.selectedAgentRow); change: window.detailChange; tint: Theme.agent(window.detailKind); enabled: window.canEditAgent && (!change || change.withdrawable); Accessible.name: window.selectedAgentRow ? window.selectedAgentRow.label : "Agent"; onClicked: window.flipAgent(window.detailKind) }
                                    }
                                    RowLayout {
                                        visible: window.agentFeedbackText().length > 0 || host.agentChoicesNeedRetry
                                        Layout.fillWidth: true
                                        Hint { text: window.agentFeedbackText() || "无法读取 Agent 设置"; Layout.fillWidth: true }
                                        ActionButton { text: "重新读取"; visible: host.agentChoicesNeedRetry; onClicked: host.refreshAgentChoices() }
                                        ActionButton {
                                            text: "撤销"; visible: window.agentFeedback.status === "disabled" && window.agentFeedback.revision === host.agentEnablement.revision
                                            enabled: window.canEditAgent; onClicked: { const receipt = window.agentFeedback; window.agentFeedback = ({}); host.setAgentsEnabled(receipt.kinds, true, receipt.revision) }
                                        }
                                    }
                                    ActionButton { objectName: "agentDetailEnable"; visible: !window.detailPowered && !window.detailChange; text: "启用 " + (window.selectedAgentRow ? window.selectedAgentRow.label : "Agent"); primary: true; enabled: window.canEditAgent; onClicked: window.flipAgent(window.detailKind) }
                                    ColumnLayout {
                                        Layout.fillWidth: true; spacing: 16
                                        visible: window.detailPowered
                                        Hint { text: window.selectedAgentRow && window.agentStatus(window.selectedAgentRow).detail || ""; visible: text.length > 0; color: Theme.warning; Layout.fillWidth: true }
                                        Flow {
                                            Layout.fillWidth: true; spacing: 8
                                            ActionButton { id: dialInstall; objectName: "agentDetailInstall"; visible: !!window.detailFacts && (window.detailFacts.data !== undefined); text: window.detailFacts && window.detailFacts.broken ? "修复或更新" : window.detailFacts && window.detailFacts.installed ? "更新到最新版本" : "安装最新版本"; enabled: window.canEditAgent && !host.agentInstalling && (window.detailKind !== "claude" || (!host.claudeDetecting && !host.claudeLatestChecking && (!host.claudeLatestVersion || host.claudeUpdateAvailable || !host.claudeVersion))); onClicked: window.showAgentInstaller(window.detailKind === "claude" ? {kind:"claude", installed:true, version:host.claudeVersion, latestVersion:host.claudeLatestVersion} : window.detailFacts.data) }
                                            ActionButton { objectName: "updateClaude"; visible: window.detailKind === "claude" && window.detailPowered; text: host.claudeLatestVersion && !host.claudeUpdateAvailable && !!host.claudeVersion ? "已是最新版本" : "更新到最新版本"; enabled: host.claudeInstalled && dialInstall.enabled; onClicked: window.showAgentInstaller({kind:"claude", installed:true, version:host.claudeVersion, latestVersion:host.claudeLatestVersion}) }
                                            ActionButton { text: "打开"; visible: !!window.detailFacts && !window.detailFacts.passive && window.detailKind !== "openclaw"; enabled: window.canEditAgent && !!window.detailFacts && window.detailFacts.installed; onClicked: window.openOverviewAgent(window.detailKind) }
                                            ActionButton { objectName: "restartDshServer"; text: "重启 DSH Server"; visible: window.detailKind === "dsh"; enabled: window.canEditAgent && !host.agentInstalling && !!window.detailFacts && window.detailFacts.installed; onClicked: restartDshDialog.open() }
                                            ActionButton { text: "入口设置"; visible: !!window.detailFacts && (!!window.agentCliHint(window.detailFacts) || !!host.agentEntryOverrides[window.detailKind]); enabled: window.canEditAgent; onClicked: window.showAgentEntry(window.detailFacts) }
                                            ActionButton { text: "接入设置"; visible: ["codex", "dsh", "claude", "pi", "kimiCode"].includes(window.detailKind); onClicked: window.selectPage(3) }
                                            ActionButton { text: "全部更新到最新（" + window.batchAgentTargets().length + "）"; visible: window.batchAgentTargets().length > 0; enabled: window.canEditAgent; onClicked: window.showAgentBatch() }
                                        }
                                        Hint { objectName: "claudeVersions"; visible: window.detailKind === "claude"; text: "当前 " + (host.claudeVersion || "—") + "，最新 " + (host.claudeLatestChecking ? "查询中" : host.claudeLatestVersion || "未知") + (host.claudeUpdateAvailable ? "，有可用更新" : ""); Layout.fillWidth: true }
                                        Hint { visible: window.detailKind === "claude" && text.length > 0; text: host.claudeVersionError || host.claudeLatestError; Layout.fillWidth: true; color: Theme.warning }
                                        Hint { visible: !!window.detailFacts?.data && window.detailKind !== "claude" && text.length > 0; text: window.detailFacts?.data?.error || window.detailFacts?.data?.latestError || window.detailFacts?.data?.compatibilityNote || ""; Layout.fillWidth: true; color: Theme.warning }
                                        RowLayout { visible: host.agentInstalling && host.agentInstallKind === window.detailKind; Layout.fillWidth: true
                                            Hint { text: window.installationStage(); Layout.fillWidth: true }
                                            ActionButton { text: "取消安装"; enabled: host.bridgeReady && host.agentInstallStage !== "cancelling" && host.agentInstallStage !== "restarting"; danger: true; onClicked: host.cancelInstall() }
                                        }
                                        DownloadBar { visible: host.downloadReceived >= 0 && host.agentInstallKind === window.detailKind; label: window.agentName(host.agentInstallKind) + " 下载"; received: host.downloadReceived; total: host.downloadTotal; Layout.fillWidth: true }
                                        ColumnLayout {
                                            visible: !!window.detailProviderGroup; Layout.fillWidth: true; spacing: 8
                                            RowLayout {
                                                visible: !window.providersOpen; Layout.fillWidth: true
                                                Heading { text: "供应商"; Layout.fillWidth: true }
                                                ActionButton { text: "供应商配置"; enabled: window.canEditAgent && !window.detailChange; onClicked: window.openProviders(window.detailProviderGroup) }
                                            }
                                            Hint { visible: !window.providersOpen && host.providerKind === window.detailProviderGroup && host.providers.length === 0; text: window.activityKinds.indexOf("providerList") >= 0 ? "正在读取供应商" : "没有可用供应商" }
                                            Repeater {
                                                model: !window.providersOpen && host.providerKind === window.detailProviderGroup ? host.providers : []
                                                delegate: Item {
                                                    id: providerRow
                                                    required property var modelData
                                                    Layout.fillWidth: true; Layout.preferredHeight: 48
                                                    activeFocusOnTab: true
                                                    Accessible.role: Accessible.ListItem; Accessible.name: modelData.name + (modelData.enabled ? "，已启用" : "")
                                                    Accessible.onPressAction: window.previewProviderId = modelData.id
                                                    Keys.onReturnPressed: window.askProvider(modelData)
                                                    Rectangle { anchors.fill: parent; radius: Theme.radiusSm; color: providerHover.hovered || window.previewProviderId === providerRow.modelData.id ? Theme.surfaceLift : "transparent"; border.width: providerRow.activeFocus ? 1 : 0; border.color: Theme.accent }
                                                    HoverHandler { id: providerHover }
                                                    TapHandler { onTapped: window.previewProviderId = providerRow.modelData.id; onDoubleTapped: window.askProvider(providerRow.modelData) }
                                                    RowLayout {
                                                        anchors.fill: parent; anchors.margins: 6; spacing: 8
                                                        Label { text: "▸"; color: Theme.agent(window.detailKind); opacity: providerRow.modelData.enabled ? 1 : 0; Accessible.ignored: true }
                                                        Label { text: providerRow.modelData.name; color: Theme.ink; elide: Text.ElideRight; Layout.fillWidth: true }
                                                        ActionButton { text: "配额"; visible: providerRow.modelData.enabled && providerRow.modelData.subscriptionSupported === true; enabled: !host.busy && !window.detailChange; onClicked: host.querySubscription(providerRow.modelData.id) }
                                                        ActionButton { text: providerRow.modelData.enabled ? "移出" : "切换"; visible: (!providerRow.modelData.enabled || providerRow.modelData.mode === "additive") && (providerHover.hovered || providerRow.activeFocus || window.previewProviderId === providerRow.modelData.id); enabled: !host.busy && !window.detailChange; onClicked: window.askProvider(providerRow.modelData) }
                                                    }
                                                }
                                            }
                                        ColumnLayout {
                                            visible: window.providersOpen; Layout.fillWidth: true; spacing: 12
                                            RowLayout {
                                                Layout.fillWidth: true
                                                ActionButton { text: "‹ 供应商"; onClicked: window.providersOpen = false }
                                                Item { Layout.fillWidth: true }
                                            }
                                            Flow {
                                                Layout.fillWidth: true; spacing: 14
                                                ActionButton { text: "刷新"; enabled: !host.busy; onClicked: host.loadProviders(host.providerKind) }
                                                ActionButton { text: "通用配置"; visible: host.providerKind === "codex"; enabled: !host.busy; onClicked: host.loadCodexPreferences() }
                                                ActionButton { text: "账号管理"; visible: host.providerKind === "codex"; enabled: !host.busy; onClicked: { host.clearMessage(); host.oauthAccount("list"); oauthDialog.open() } }
                                                ActionButton { text: "添加供应商"; symbol: "add"; primary: true; enabled: !host.busy; onClicked: host.editProvider("") }
                                            }
                                            RowLayout { Layout.fillWidth: true
                                                Field { id: providerSearch; objectName: "providerSearch"; Layout.fillWidth: true; placeholderText: "搜索名称、标识、备注或网站"; Accessible.name: "搜索供应商" }
                                                Hint { text: String(window.visibleProviders.length) + " / " + host.providers.length }
                                            }
                                            Card {
                                                visible: host.providers.length === 0; Layout.fillWidth: true
                                                ColumnLayout { anchors.fill: parent; spacing: 12
                                                    Heading { text: "添加第一个供应商" }
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
                                                    Rectangle { anchors.fill: parent; color: "transparent"; border.color: Theme.accent; border.width: 2; radius: Theme.radiusLg; visible: providerDrop.containsDrag }
                                                    DropArea { id: providerDrop; anchors.fill: parent; keys: ["provider-card"]; enabled: !host.busy && providerSearch.text.trim().length === 0
                                                        onDropped: function(drop) { window.moveProvider(window.draggedProviderId, providerCard.modelData.id); drop.acceptProposedAction() }
                                                    }
                                                    ColumnLayout { id: providerCardContent; anchors.fill: parent; spacing: 12
                                                      RowLayout { Layout.fillWidth: true; spacing: 12
                                                        Item { Layout.preferredWidth: 30; Layout.preferredHeight: 40
                                                            SymbolIcon { id: providerDrag; objectName: "providerDragHandle-" + modelData.id; anchors.centerIn: parent; name: "more_horiz"; width: Theme.iconMd; height: Theme.iconMd; rotation: 90; color: dragMouse.enabled ? Theme.inkMuted : Theme.inkFaint
                                                                Drag.active: dragMouse.drag.active; Drag.source: providerCard; Drag.keys: ["provider-card"]; Drag.hotSpot.x: width / 2; Drag.hotSpot.y: height / 2
                                                                MouseArea { id: dragMouse; anchors.fill: parent; enabled: !host.busy && providerSearch.text.trim().length === 0; cursorShape: Qt.OpenHandCursor; drag.target: providerDrag
                                                                    onPressed: { window.draggedProviderId = modelData.id; providerDrag.anchors.centerIn = undefined }
                                                                    onReleased: { providerDrag.Drag.drop(); providerDrag.anchors.centerIn = providerDrag.parent; window.draggedProviderId = "" }
                                                                    onCanceled: { providerDrag.anchors.centerIn = providerDrag.parent; window.draggedProviderId = "" }
                                                                }
                                                            }
                                                        }
                                                        ColumnLayout { Layout.fillWidth: true
                                                            Heading { text: modelData.name; font.pixelSize: Theme.body; color: Theme.agent(modelData.kind || host.providerKind); Layout.fillWidth: true; elide: Text.ElideRight }
                                                            Hint { text: (modelData.enabled ? (modelData.mode === "additive" ? "已启用" : "当前使用") : "未启用") + (modelData.globalDefault ? "（Pi 全局默认）" : ""); color: modelData.enabled ? Theme.success : Theme.inkMuted }
                                                            Hint { text: modelData.notes || ""; visible: text.length > 0; Layout.fillWidth: true }
                                                        }
                                                      }
                                                      Flow { Layout.fillWidth: true; spacing: 6
                                                        ActionButton { text: modelData.enabled ? (modelData.mode === "additive" ? "移除" : "已在用") : "启用"; primary: !modelData.enabled; enabled: !host.busy && (!modelData.enabled || modelData.mode === "additive"); onClicked: window.askProvider(modelData) }
                                                        ActionButton { text: "编辑"; enabled: !host.busy; onClicked: host.editProvider(modelData.id) }
                                                        ActionButton { text: "复制"; enabled: !host.busy; onClicked: host.copyProvider(modelData.id) }
                                                        ActionButton { text: "删除"; danger: true; enabled: !host.busy && (!modelData.enabled || modelData.mode === "additive"); onClicked: { window.deleteProviderId = modelData.id; deleteProviderDialog.open() } }
                                                      }
                                                      Hint { text: modelData.websiteUrl || modelData.id; Layout.fillWidth: true }
                                                      Flow { Layout.fillWidth: true; spacing: 6
                                                        ActionButton { text: "检测连通"; loading: host.checkingProviderIds.indexOf(modelData.id) >= 0; visible: modelData.category !== "official"; enabled: !host.busy && host.checkingProviderIds.indexOf(modelData.id) < 0; onClicked: host.checkProvider(modelData.id) }
                                                        ActionButton { text: "查询订阅配额"; visible: modelData.enabled && modelData.subscriptionSupported === true; enabled: !host.busy; onClicked: host.querySubscription(modelData.id) }
                                                        SoftToolButton { symbol: "arrow_upward"; enabled: !host.busy && providerSearch.text.trim().length === 0 && index > 0; onClicked: window.moveProvider(modelData.id, window.visibleProviders[index - 1].id); ToolTip.visible: hovered; ToolTip.text: "上移" }
                                                        SoftToolButton { symbol: "arrow_downward"; enabled: !host.busy && providerSearch.text.trim().length === 0 && index + 1 < window.visibleProviders.length; onClicked: window.moveProvider(modelData.id, window.visibleProviders[index + 1].id); ToolTip.visible: hovered; ToolTip.text: "下移" }
                                                      }
                                                    }
                                                }
                                            }
                                            Hint { visible: host.busy; text: "正在处理供应商配置…"; Layout.fillWidth: true }
                                        }

                                        }
                                        ColumnLayout {
                                            visible: (window.detailSessions.total || 0) > 0; Layout.fillWidth: true; spacing: 6
                                            Heading { text: "运行中会话 · " + (window.detailSessions.total || 0) }
                                            Repeater { model: window.detailSessions.sessions || []; delegate: Hint { required property string modelData; text: modelData; Layout.fillWidth: true } }
                                            Hint { visible: window.detailSessions.total > (window.detailSessions.sessions || []).length; text: "另外 " + (window.detailSessions.total - (window.detailSessions.sessions || []).length) + " 个" }
                                        }
                                        // OPENCLAW-04: configure the local Gateway without managing its process.
                                        Card {
                                            id: openClawCard
                                            objectName: "openClawCard"
                                            Layout.fillWidth: true
                                            visible: host.bridgeReady && !!host.openClaw.source && window.detailKind === "openclaw" && window.detailPowered
                                            readonly property bool editable: host.openClaw.source === "file"
                                            readonly property bool dirty: clawUrl.text.trim() !== (host.openClaw.url || "") || clawToken.text.length > 0
                                            function reset() { clawUrl.text = host.openClaw.url || ""; clawToken.clear() }
                                            onVisibleChanged: reset()
                                            Component.onCompleted: reset()
                                            Connections { target: host; function onOpenClawChanged() { openClawCard.reset() } }
                                            ColumnLayout {
                                                anchors.fill: parent; spacing: 12
                                                RowLayout {
                                                    Layout.fillWidth: true
                                                    AgentMark { kind: "openclaw" }
                                                    Heading { text: "OpenClaw"; Layout.fillWidth: true }
                                                    StatusDot { idle: !window.openClawReady; color: window.openClawReady ? Theme.success : host.openClaw.invalid ? Theme.warning : Theme.inkFaint }
                                                    Hint { objectName: "openClawState"; text: window.openClawStateText }
                                                }
                                                Field { id: clawUrl; objectName: "openClawUrl"; Layout.fillWidth: true; enabled: !host.busy; readOnly: !openClawCard.editable; maximumLength: 2048; marksProviderDirty: false; placeholderText: "ws://127.0.0.1:18789"; Accessible.name: "OpenClaw Gateway 地址" }
                                                Field {
                                                    id: clawToken; objectName: "openClawToken"
                                                    visible: openClawCard.editable; Layout.fillWidth: true; enabled: !host.busy
                                                    marksProviderDirty: false; maximumLength: 4096; echoMode: TextInput.Password
                                                    inputMethodHints: Qt.ImhSensitiveData | Qt.ImhNoPredictiveText
                                                    placeholderText: host.openClaw.hasToken && clawUrl.text.trim() === host.openClaw.url ? "已保存令牌" : "Gateway 令牌（可选）"
                                                    Accessible.name: "OpenClaw Gateway 令牌"
                                                }
                                                Hint { visible: !openClawCard.editable; text: "由环境变量配置" }
                                                Flow {
                                                    Layout.fillWidth: true; spacing: 8
                                                    ActionButton {
                                                        objectName: "applyOpenClaw"
                                                        visible: openClawCard.editable
                                                        text: host.desiredRunning ? "应用并重新连接" : "保存配置"
                                                        enabled: !host.busy && openClawCard.dirty && clawUrl.text.trim().length > 0
                                                        loading: window.activityKinds.indexOf("openClaw") >= 0
                                                        onClicked: { host.saveOpenClaw(clawUrl.text, clawToken.text); clawToken.clear() }
                                                    }
                                                    ActionButton {
                                                        objectName: "reconnectOpenClaw"; text: "重新连接 Host"
                                                        visible: !!host.openClaw.url && !host.openClaw.invalid && host.desiredRunning
                                                        enabled: !host.busy && !openClawCard.dirty
                                                        onClicked: host.reconnectOpenClaw()
                                                    }
                                                    ActionButton {
                                                        objectName: "disableOpenClaw"; text: "移除连接配置"
                                                        visible: openClawCard.editable && (!!host.openClaw.url || host.openClaw.invalid)
                                                        enabled: !host.busy
                                                        onClicked: { clawToken.clear(); host.saveOpenClaw("", "") }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    Card {
                        id: settingsPane
                        visible: window.page === 3; Layout.fillWidth: true
                        // HOST-LIVE-01: start parameters of the running service apply by reconnecting it; the button says so.
                        readonly property bool reconnects: host.desiredRunning && (relayField.text.trim().replace(/\/+$/, "") !== host.relayUrl
                            || (nameField.text.trim().length > 0 && nameField.text.trim() !== host.hostName) || codexSwitch.checked !== host.codexEnabled
                            || (host.kimiCodeEnabled && host.kimiDesktopSupported && kimiSource.currentValue !== host.kimiCodeSource) || dshSwitch.checked !== host.dshEnabled || dshWebUrlField.text.trim() !== host.dshWebUrl)
                        function load() { relayField.text = host.relayUrl; nameField.text = host.hostName; dshWebUrlField.text = host.dshWebUrl; startupSwitch.checked = host.autoStart; codexSwitch.checked = host.codexEnabled; dshSwitch.checked = host.dshEnabled; kimiSource.currentIndex = host.kimiCodeSource === "desktop" ? 1 : 0; piIntegrationSwitch.checked = host.piIntegrationEnabled; claudeIntegrationSwitch.checked = host.claudeIntegrationEnabled }
                        ColumnLayout {
                            anchors.fill: parent; spacing: 15
                            Heading { text: "外观" }
                            RowLayout {
                                Layout.fillWidth: true; spacing: 12
                                Repeater {
                                    model: ["light", "dark"]
                                    delegate: Button {
                                        id: appearanceOption
                                        required property string modelData
                                        readonly property bool previewDark: modelData === "dark"
                                        readonly property bool chosen: Theme.dark === previewDark
                                        Layout.fillWidth: true; implicitHeight: 168
                                        Accessible.name: previewDark ? "深色" : "浅色"
                                        Accessible.selected: chosen
                                        onClicked: window.applyAppearance(Theme.preferences.material, modelData)
                                        contentItem: ColumnLayout {
                                            spacing: 12
                                            ThemePreview { dark: appearanceOption.previewDark; Layout.fillWidth: true; Layout.preferredHeight: 112 }
                                            RowLayout {
                                                Layout.alignment: Qt.AlignHCenter; spacing: 8
                                                Rectangle { width: 18; height: 18; radius: 9; color: "transparent"; border.width: 1.5; border.color: appearanceOption.chosen ? Theme.accent : Theme.inkMuted; Rectangle { anchors.centerIn: parent; width: 8; height: 8; radius: 4; visible: appearanceOption.chosen; color: Theme.accent } }
                                                Label { text: (appearanceOption.previewDark ? "深色" : "浅色") + (appearanceOption.chosen && Theme.preferences.mode === "system" ? "（跟随系统）" : ""); color: appearanceOption.chosen ? Theme.accent : Theme.inkMuted; font.pixelSize: Theme.label; font.weight: appearanceOption.chosen ? Font.DemiBold : Font.Normal }
                                            }
                                        }
                                        padding: 12
                                        background: Surface { anchors.fill: parent; anchors.margins: -8; margin: 8; cornerRadius: Theme.radiusSm; shadowScale: 0.4; inset: appearanceOption.chosen || appearanceOption.down; focused: appearanceOption.activeFocus; hovered: appearanceOption.hovered }
                                    }
                                }
                            }
                            SoftSwitch {
                                objectName: "appearanceSystem"; text: "跟随系统"; checked: Theme.preferences.mode === "system"
                                onToggled: window.applyAppearance(Theme.preferences.material, checked ? "system" : Theme.dark ? "dark" : "light")
                            }
                            Hint { text: "随电脑的浅色与深色自动切换" }
                            RowLayout {
                                spacing: 8
                                Label { text: "材质"; color: Theme.inkMuted; Layout.rightMargin: 16 }
                                Repeater {
                                    model: ["mist", "sage"]
                                    delegate: Button {
                                        id: materialOption
                                        required property string modelData
                                        readonly property bool chosen: Theme.preferences.material === modelData
                                        implicitHeight: Theme.controlHeight; implicitWidth: 112
                                        Accessible.name: modelData === "sage" ? "灰绿" : "雾蓝"
                                        Accessible.selected: chosen
                                        onClicked: window.applyAppearance(modelData, Theme.preferences.mode)
                                        contentItem: RowLayout {
                                            spacing: 8
                                            Rectangle { width: 28; height: 28; radius: 14; color: Theme.colorFor("surface-base", materialOption.modelData === "sage", Theme.dark); border.width: 0; SymbolIcon { anchors.centerIn: parent; width: 16; height: 16; visible: materialOption.chosen; name: "check"; color: Theme.colorFor("accent", materialOption.modelData === "sage", Theme.dark) } }
                                            Label { text: materialOption.modelData === "sage" ? "灰绿" : "雾蓝"; color: materialOption.chosen ? Theme.accent : Theme.inkMuted; font.pixelSize: Theme.label; font.weight: materialOption.chosen ? Font.DemiBold : Font.Normal }
                                        }
                                        background: Surface { anchors.fill: parent; anchors.margins: -8; margin: 8; cornerRadius: Theme.radiusSm; shadowScale: 0.4; inset: materialOption.chosen || materialOption.down; focused: materialOption.activeFocus; hovered: materialOption.hovered }
                                    }
                                }
                            }
                            Heading { text: "登录启动"; Layout.topMargin: 24 }
                            SoftSwitch { id: startupSwitch; enabled: !host.busy; marksProviderDirty: false; checked: host.autoStart; onToggled: { host.setAutoStart(checked); checked = host.autoStart } text: Qt.platform.os === "osx" ? "登录 macOS 后自动启动" : "登录 Windows 后自动启动" }
                            Hint { text: "立即应用，下次登录时自动打开 Orbis。" }
                            Heading { text: "常规"; Layout.topMargin: 24 }

                            Label { text: "电脑名称"; color: Theme.inkMuted }
                            Field { id: nameField; enabled: host.bridgeReady && !host.busy; Layout.fillWidth: true; maximumLength: 80 }
                            SoftSwitch { id: codexSwitch; visible: window.agentEnabled("codex"); enabled: host.bridgeReady && !host.busy; text: "启动 Host 时预启动 Codex 终端后端" }
                            SoftSwitch { id: dshSwitch; visible: window.agentEnabled("dsh"); enabled: host.bridgeReady && !host.busy; text: "启动 Host 时预启动 DeepSeek Harness" }
                            RowLayout {
                                visible: host.kimiCodeAvailable && window.agentEnabled("kimiCode"); Layout.fillWidth: true; spacing: 12
                                onVisibleChanged: if (visible) kimiSource.currentIndex = host.kimiCodeSource === "desktop" ? 1 : 0
                                AgentMark { kind: "kimiCode" }
                                Label { text: "Kimi Code"; Layout.fillWidth: true }
                                SoftComboBox {
                                    id: kimiSource; objectName: "kimiCodeSource"
                                    visible: host.kimiDesktopSupported
                                    enabled: host.bridgeReady && !host.busy
                                    model: [{ label: "Web", value: "web" }, { label: "桌面版", value: "desktop" }]
                                    textRole: "label"; valueRole: "value"
                                    Accessible.name: "Kimi Code 来源"
                                }
                                Hint {
                                    objectName: "kimiCodeStatus"
                                    visible: host.kimiCodeEnabled && (!host.kimiDesktopSupported || kimiSource.currentValue === host.kimiCodeSource)
                                    text: !host.desiredRunning ? "未连接" : ({ connected: "已接入", connecting: "正在连接", not_running: host.kimiCodeSource === "desktop" ? "桌面版未连接" : "服务未启动", ambiguous: "有多个实例", unauthorized: "认证失败", unsupported: "版本不支持", unsafe: "配置不安全", unavailable: "暂不可用" })[host.kimiCodeState] || "未连接"
                                }
                                SoftToolButton {
                                    symbol: "info"; Accessible.name: "Kimi Code 接入说明"
                                    onClicked: kimiHelp.open()
                                    ToolTip.visible: hovered; ToolTip.text: "Kimi Code 接入说明"
                                }
                            }
                            SoftSwitch { id: piIntegrationSwitch; enabled: host.bridgeReady && !host.busy; visible: Qt.platform.os === "osx" && window.agentEnabled("pi"); text: "让终端里运行的 Pi 连接 Orbis" }
                            Hint { visible: Qt.platform.os === "osx" && window.agentEnabled("pi"); text: "会在 Pi 的 settings.json 里追加 Orbis 扩展，不影响你已有的扩展；已在运行的 Pi 需重启后才会连接。删除 Orbis Host 前请先关闭此项（终端命令 pi 也会一并移除）。"; Layout.fillWidth: true }
                            SoftSwitch { id: claudeIntegrationSwitch; visible: window.agentEnabled("claude"); enabled: host.bridgeReady && !host.busy; text: "让终端里运行的 Claude Code 连接 Orbis" }
                            Hint { visible: window.agentEnabled("claude"); text: "安装或首次打开 Host 时自动安装 Orbis 插件；未安装 Claude Code 时跳过，安装后重新打开 Host 即可。关闭此项会卸载插件，更新 Host 会保留关闭状态。需要 Claude Code 2.1.287 或更新版本，以及 PATH 中的 node。已在运行的 Claude Code 需执行 /reload-plugins 或重启。"; Layout.fillWidth: true }
                            RowLayout {
                                objectName: "piCommandRow"
                                visible: window.agentEnabled("pi") && ["installed", "available", "foreign"].includes(window.piAgent().terminalCommand)
                                Layout.fillWidth: true; spacing: 12
                                Hint { text: "终端命令 pi：" + (window.piAgent().terminalCommandDetail || ""); Layout.fillWidth: true }
                                ActionButton {
                                    visible: Qt.platform.os === "osx" && (window.piAgent().terminalCommand === "available" || window.piAgent().terminalCommand === "installed")
                                    text: window.piAgent().terminalCommand === "installed" ? "移除 pi 命令" : "安装 pi 命令"
                                    primary: window.piAgent().terminalCommand === "available"
                                    enabled: host.bridgeReady && !host.busy
                                    onClicked: host.piCommand(window.piAgent().terminalCommand === "installed" ? "remove" : "install")
                                }
                            }
                            RowLayout {
                                visible: window.agentEnabled("codex") && host.agents.some(a => a.kind === "codex" && a.terminalNeedsElevation === true)
                                Layout.fillWidth: true; spacing: 12
                                Hint { text: "系统 PATH 里其他 codex 抢先于 Orbis，终端接入无法生效"; Layout.fillWidth: true; color: Theme.warning }
                                ActionButton { text: "修复终端接入"; primary: true; enabled: host.bridgeReady && !host.busy; onClicked: host.enableCodexTerminal() }
                            }
                            Heading { text: "中继服务器"; Layout.topMargin: 10 }
                            Field { id: relayField; enabled: host.bridgeReady && !host.busy; Layout.fillWidth: true; placeholderText: "wss://服务器地址/relay" }
                            Label { text: "DeepSeek Web 启动链接（可选）"; color: Theme.inkMuted }
                            Field { id: dshWebUrlField; enabled: host.bridgeReady && !host.busy; Layout.fillWidth: true; echoMode: TextInput.PasswordEchoOnEdit; placeholderText: "http://127.0.0.1:3080/?token=..."; Accessible.name: "DeepSeek Web 启动链接" }
                            ActionButton { objectName: "applySettings"; text: settingsPane.reconnects ? "应用并重新连接" : "应用设置"; primary: true; enabled: host.bridgeReady && !host.busy; onClicked: host.saveSettings(relayField.text, host.autoStart, codexSwitch.checked, nameField.text, dshSwitch.checked, dshWebUrlField.text, piIntegrationSwitch.checked, claudeIntegrationSwitch.checked, host.kimiDesktopSupported ? kimiSource.currentValue : "") }
                            Rectangle { Layout.fillWidth: true; height: 1; color: Theme.hairline; Layout.topMargin: 10 }
                            RowLayout { spacing: 10; ActionButton { text: "检查更新"; onClicked: host.checkUpdates() } ActionButton { text: "更新 Host"; visible: host.message.indexOf("点击“更新 Host”") >= 0; onClicked: host.updateHost() } ActionButton { text: "打开下载页"; onClicked: host.openDownloads() } Hint { text: "v" + host.version } }
                            DownloadBar { visible: host.downloadReceived >= 0; label: host.downloadLabel || "Host 更新"; received: host.downloadReceived; total: host.downloadTotal; Layout.fillWidth: true }
                        }
                    }

                    ColumnLayout {
                        visible: window.page === 4; Layout.fillWidth: true; spacing: 16
                        Card {
                            Layout.fillWidth: true
                            ColumnLayout {
                                anchors.fill: parent; spacing: 16
                                Heading { text: "连接诊断" }
                                RowLayout { spacing: 10; ActionButton { text: "运行检查"; primary: true; enabled: host.bridgeReady && !host.busy; onClicked: host.diagnose() } ActionButton { text: "复制诊断"; onClicked: host.copyDiagnostics() } ActionButton { text: "导出文件"; onClicked: host.exportDiagnostics() } ActionButton { text: "数据目录"; onClicked: host.openDataDirectory() } }
                            }
                        }
                        Card {
                            objectName: "codexDesktopAttach"
                            visible: window.agentEnabled("codexDesktop")
                            Layout.fillWidth: true
                            ColumnLayout {
                                anchors.fill: parent; spacing: 12
                                RowLayout { Layout.fillWidth: true
                                    Heading { text: "Codex 桌面版接入" }
                                    Item { Layout.fillWidth: true }
                                    ActionButton { text: "供应商配置"; enabled: host.bridgeReady && !host.busy; onClicked: window.openProviders("codex") }
                                }
                                RowLayout {
                                    Layout.fillWidth: true; spacing: 10
                                    StatusDot { color: window.codexDesktopColor(); idle: window.codexDesktopState() === "closed" }
                                    Label { objectName: "codexDesktopAttachLabel"; text: window.codexDesktopLabel(); color: window.codexDesktopColor(); font.pixelSize: Theme.body; font.weight: Font.DemiBold }
                                }
                                Hint { objectName: "codexDesktopAttachReason"; visible: text.length > 0; text: window.codexDesktopReason(); Layout.fillWidth: true }
                            }
                        }
                        Card {
                            objectName: "dshDesktopAttach"
                            visible: window.agentEnabled("dshDesktop")
                            Layout.fillWidth: true
                            ColumnLayout {
                                anchors.fill: parent; spacing: 12
                                Heading { text: "DeepSeek 桌面版接入" }
                                RowLayout {
                                    Layout.fillWidth: true; spacing: 10
                                    StatusDot { color: window.dshDesktopColor(); idle: window.dshDesktopState() === "closed" }
                                    Label { text: window.dshDesktopLabel(); color: window.dshDesktopColor(); font.pixelSize: Theme.body; font.weight: Font.DemiBold }
                                }
                                Hint { text: window.dshDesktopReason(); Layout.fillWidth: true }
                            }
                        }
                        Card {
                            Layout.fillWidth: true
                            ColumnLayout {
                                anchors.fill: parent; spacing: 16
                                Heading { text: "本次运行日志" }
                                Loader {
                                    active: window.visible && window.page === 4
                                    Layout.fillWidth: true
                                    Layout.preferredHeight: 320
                                    sourceComponent: DiagnosticLogView { surfaceColor: Theme.surfaceBase; textColor: Theme.inkMuted; highlightColor: Theme.highlight; shadeColor: Theme.shade; logModel: host.logModel }
                                }
                            }
                        }
                    }
                    Item { Layout.preferredHeight: 30 }
                }
            }
        }
    }
    // HOST-EXIT-01 / HOST-UPDATE-01 share the same confirmation and asynchronous cleanup.
    SoftDialog {
        id: exitDialog; objectName: "hostExitDialog"; title: "退出 Orbis？"
        anchors.centerIn: parent; modal: true; width: 500
        closePolicy: Popup.CloseOnEscape
        Hint { width: parent.width; text: "手机连接将断开，Host 管理的后台（包括 DeepSeek Web）将关闭，正在运行的任务会中断。" }
        footer: SoftDialogButtons {
            ActionButton { objectName: "cancelHostExit"; text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole }
            ActionButton { objectName: "confirmHostExit"; text: "停止并退出"; danger: true; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole }
            onAccepted: exitDialog.accept(); onRejected: exitDialog.reject()
        }
        onAccepted: host.confirmExit()
        onRejected: host.cancelExit()
    }
    SoftDialog {
        id: installerExitDialog; objectName: "installerExitDialog"; title: "停止后台并安装新版 Host？"
        anchors.centerIn: parent; modal: true; width: 500; closePolicy: Popup.CloseOnEscape
        Hint { width: parent.width; text: "手机连接将断开，Host 管理的后台（包括 DeepSeek Web）将关闭，正在运行的任务会中断。" }
        footer: SoftDialogButtons {
            ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole }
            ActionButton { text: "停止并安装"; danger: true; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole }
            onAccepted: installerExitDialog.accept(); onRejected: installerExitDialog.reject()
        }
        onAccepted: host.confirmExit()
        onRejected: host.cancelExit()
    }
    SoftDialog {
        id: hostUpdateDialog; objectName: "hostUpdateDialog"; title: "安装新版 Host？"
        anchors.centerIn: parent; modal: true; width: 500
        closePolicy: Popup.CloseOnEscape
        ColumnLayout { width: parent.width; spacing: 12
            Hint { text: "下载完成后将断开手机连接，停止 Host 管理的后台并退出。DeepSeek Web 中的任务会中断。"; Layout.fillWidth: true }
            Hint { visible: Qt.platform.os === "osx"; text: "退出后会打开更新包，请将新版拖入 Applications 替换。"; Layout.fillWidth: true }
        }
        footer: SoftDialogButtons {
            ActionButton { objectName: "cancelHostUpdate"; text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole }
            ActionButton { objectName: "confirmHostUpdate"; text: "下载并更新"; primary: true; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole }
            onAccepted: hostUpdateDialog.accept(); onRejected: hostUpdateDialog.reject()
        }
        onAccepted: host.confirmHostUpdate()
    }
    SoftDialog {
        id: exitProgressDialog; objectName: "hostExitProgressDialog"; title: "正在停止相关后台…"
        anchors.centerIn: parent; modal: true; width: 420; closePolicy: Popup.NoAutoClose
        RowLayout { width: parent.width; spacing: 12
            BusyIndicator { running: host.exiting }
            Hint { text: "正在保存状态并关闭后台任务"; Layout.fillWidth: true }
        }
    }
    SoftDialog {
        id: appDownloadDialog
        objectName: "appDownloadDialog"
        property string platform: "android"
        title: platform === "ios" ? "Orbis iOS · TestFlight" : "Orbis Android"
        anchors.centerIn: parent
        width: 370
        modal: true
        footer: SoftDialogButtons { ActionButton { text: "关闭"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } onRejected: appDownloadDialog.reject() }
        ColumnLayout {
            width: parent.width; spacing: 12
            Label { text: appDownloadDialog.platform === "ios" ? "扫描下方二维码加入测试" : "扫描下方二维码下载"; Layout.alignment: Qt.AlignHCenter; color: Theme.inkMuted; font.pixelSize: Theme.label }
            Image {
                objectName: "appDownloadQrImage"
                source: appDownloadDialog.platform === "ios" ? host.iosAppDownloadQr : host.appDownloadQr
                sourceSize.width: 320; sourceSize.height: 320
                Layout.preferredWidth: 320; Layout.preferredHeight: 320
                Layout.alignment: Qt.AlignHCenter
                fillMode: Image.PreserveAspectFit
                smooth: false
                mipmap: false
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
            Label { text: "二维码将在 " + host.pairSeconds + " 秒后失效"; Layout.alignment: Qt.AlignHCenter; color: Theme.inkMuted }
        }
    }
    SoftDialog {
        // HOST-ACT-16: the always-available activation when this Host ID cannot be restored.
        id: newComputerDialog; title: "作为新电脑激活？"; anchors.centerIn: parent; modal: true; width: 410
        footer: SoftDialogButtons { ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } ActionButton { objectName: "confirmNewComputer"; text: "作为新电脑激活"; danger: true; enabled: host.bridgeReady && !host.busy; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole } onAccepted: newComputerDialog.accept(); onRejected: newComputerDialog.reject() }
        Label { width: parent.width; text: "已配对的手机需要重新添加。"; wrapMode: Text.WordWrap }
        onAccepted: host.replaceIdentity()
    }
    SoftDialog {
        id: revokeDialog; title: "撤销这台手机的配对？"; anchors.centerIn: parent; modal: true; width: 410
        footer: SoftDialogButtons { ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } ActionButton { text: "撤销配对"; danger: true; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole } onAccepted: revokeDialog.accept(); onRejected: revokeDialog.reject() }
        Label { width: parent.width; text: "连接会立即失效。"; wrapMode: Text.WordWrap }
        onAccepted: host.revoke(window.revokeId)
    }
    Timer { id: agentFeedbackExpiry; interval: 4000; onTriggered: window.agentFeedback = ({}) }
    Connections {
        target: host
        function onAgentWriteFeedback(kinds, status, revision) {
            if (status === "enabled") return
            window.agentFeedback = {kinds: kinds, status: status, revision: revision}
            agentFeedbackExpiry.restart()
        }
        function onAgentReviewsRequested(kinds, reviews, revision) {
            disableAgentDialog.kinds = kinds
            disableAgentDialog.reviews = reviews
            disableAgentDialog.revision = revision
            disableAgentDialog.open()
        }
        function onPaired() { if (pairDialog.opened) pairDialog.accept() }
    }
    SoftDialog {
        id: disableAgentDialog; objectName: "disableAgentDialog"; anchors.centerIn: parent; modal: true; width: 430
        property var kinds: []
        property var reviews: []
        property double revision: -1
        title: kinds.length > 1 ? "停用 " + kinds.length + " 个 Agent？" : "停用 " + (window.agentRows.find(row => row.kind === kinds[0])?.label || "Agent") + "？"
        contentItem: ScrollView {
            implicitHeight: Math.min(360, reviewDetails.implicitHeight + 6)
            contentWidth: availableWidth
            ColumnLayout {
                id: reviewDetails
                width: parent.width; spacing: 10
                Hint { text: "这些会话将不再同步到 Orbis，电脑上照常运行。"; Layout.fillWidth: true }
                Hint { visible: disableAgentDialog.kinds.length > 1; text: disableAgentDialog.kinds.map(kind => window.agentRows.find(row => row.kind === kind)?.label || kind).join("、"); Layout.fillWidth: true }
                Repeater {
                    model: disableAgentDialog.reviews
                    delegate: ColumnLayout {
                        id: reviewGroup
                        required property var modelData
                        Layout.fillWidth: true; spacing: 4
                        Hint { text: window.agentRows.find(row => row.kind === reviewGroup.modelData.kind)?.label || reviewGroup.modelData.kind; visible: disableAgentDialog.reviews.length > 1; Layout.fillWidth: true }
                        Repeater { model: reviewGroup.modelData.sessions || []; delegate: Label { required property string modelData; text: "• " + modelData; textFormat: Text.PlainText; color: Theme.ink; wrapMode: Text.Wrap; Layout.fillWidth: true } }
                        Hint { visible: reviewGroup.modelData.total > reviewGroup.modelData.sessions.length; text: "另外 " + (reviewGroup.modelData.total - reviewGroup.modelData.sessions.length) + " 个" }
                    }
                }
                Hint { visible: host.agentEnablement.revision !== disableAgentDialog.revision; text: "设置已变化，请重新发起停用。"; color: Theme.warning }
            }
        }
        footer: SoftDialogButtons {
            ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole }
            ActionButton { text: "停用"; danger: true; enabled: window.canEditAgent && disableAgentDialog.reviews.length > 0 && host.agentEnablement.revision === disableAgentDialog.revision; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole }
            onAccepted: disableAgentDialog.accept(); onRejected: disableAgentDialog.reject()
        }
        onAccepted: host.confirmAgentReviews()
        onRejected: host.dismissAgentReviews()
    }
    SoftDialog {
        id: agentProviderConfirm; anchors.centerIn: parent; modal: true; width: 430
        property var profile: null
        property string group: ""
        readonly property bool fresh: !!profile && window.detailProviderGroup === group && window.detailPowered && !window.detailChange && host.providerKind === group && host.providers.some(row => row.id === profile.id && row.name === profile.name && !row.enabled)
        title: "切换到 " + (profile ? profile.name : "") + "？"
        contentItem: Hint { text: "已有会话可能需要重新打开。"; width: parent.width }
        footer: SoftDialogButtons {
            ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole }
            ActionButton { text: "切换"; primary: true; enabled: agentProviderConfirm.fresh && !host.busy; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole }
            onAccepted: agentProviderConfirm.accept(); onRejected: agentProviderConfirm.reject()
        }
        onAccepted: if (fresh && !host.busy) host.switchProvider(profile.id, true)
    }
    SoftDialog {
        id: restartDshDialog; title: "重启 DSH Server？"; anchors.centerIn: parent; modal: true; width: 480
        contentItem: Hint { text: "重启会断开 DSH 网页和相关会话连接，正在生成的回复可能中断。完成后从 Host 重新打开网页工作台。手动配置的外部服务需在原启动位置重启。"; width: parent.width }
        footer: SoftDialogButtons {
            ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole }
            ActionButton { text: host.desiredRunning ? "重启并重新连接" : "确认重启"; enabled: host.bridgeReady && !host.busy; danger: true; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole }
            onAccepted: restartDshDialog.accept(); onRejected: restartDshDialog.reject()
        }
        onAccepted: host.restartDshServer()
    }
    SoftDialog {
        id: agentEntryDialog
        objectName: "agentEntryDialog"
        property string kind: ""
        property string error: ""
        title: "指定 " + window.agentName(kind) + " 路径"
        anchors.centerIn: parent; modal: true; width: 540
        closePolicy: window.activityKinds.indexOf("agentEntry") >= 0 ? Popup.NoAutoClose : Popup.CloseOnEscape | Popup.CloseOnPressOutside
        onOpened: agentEntryPath.forceActiveFocus()
        Connections {
            target: host
            function onAgentEntryFinished(kind, error) {
                if (!agentEntryDialog.visible || agentEntryDialog.kind !== kind) return
                if (error) agentEntryDialog.error = error
                else agentEntryDialog.close()
            }
        }
        ColumnLayout { width: parent.width; spacing: 12
            Hint {
                Layout.fillWidth: true
                readonly property string cli: agentEntryDialog.kind
                text: "在终端运行 " + (Qt.platform.os === "windows" ? "where.exe " : "command -v ") + cli + "，粘贴返回的 CLI 绝对路径。"
            }
            Field { id: agentEntryPath; objectName: "agentEntryPath"; Layout.fillWidth: true; marksProviderDirty: false; placeholderText: "CLI 绝对路径"; enabled: !host.busy; onTextEdited: agentEntryDialog.error = "" }
            Hint { visible: !!agentEntryDialog.error; text: agentEntryDialog.error; Layout.fillWidth: true; color: Theme.warning }
            Hint { visible: host.desiredRunning; text: "应用时会短暂断开 Host。"; Layout.fillWidth: true }
        }
        footer: SoftDialogActions {
            Item { Layout.fillWidth: true }
            ActionButton { text: "恢复自动检测"; visible: !!host.agentEntryOverrides[agentEntryDialog.kind]; enabled: host.bridgeReady && !host.busy; onClicked: { agentEntryDialog.error = ""; host.selectAgentEntry(agentEntryDialog.kind, "") } }
            ActionButton { text: "取消"; enabled: !host.busy; onClicked: agentEntryDialog.close() }
            ActionButton { text: "验证并保存"; primary: true; enabled: host.bridgeReady && !host.busy && !!agentEntryPath.text.trim(); loading: window.activityKinds.indexOf("agentEntry") >= 0; onClicked: { agentEntryDialog.error = ""; host.selectAgentEntry(agentEntryDialog.kind, agentEntryPath.text.trim()) } }
        }
    }
    SoftDialog {
        id: installDialog; objectName: "agentInstallDialog"; title: (window.installAgentData.installed ? "更新 " : "安装 ") + window.agentName(window.installKind) + " 到最新版本"; anchors.centerIn: parent; modal: true; width: 540
        footer: SoftDialogButtons { ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } ActionButton { objectName: "confirmAgentInstall"; text: (window.installAgentData.installed ? "更新" : "安装") + (host.desiredRunning ? "并重新连接" : "到最新版本"); enabled: !host.busy; primary: true; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole } onAccepted: installDialog.accept(); onRejected: installDialog.reject() }
        ColumnLayout { width: parent.width; spacing: 12
            Hint { text: "当前 " + (window.installAgentData.version || "未安装") + "，最新 " + (window.installAgentData.latestVersion || "未知"); Layout.fillWidth: true }
            Hint { visible: !!window.installAgentData.compatibilityNote; text: window.installAgentData.compatibilityNote || ""; Layout.fillWidth: true }
            Hint { visible: host.desiredRunning && host.runtimeCount > 0; text: "手机上 " + host.runtimeCount + " 个会话会暂时断开"; Layout.fillWidth: true; color: Theme.warning }
        }
        onAccepted: host.updateAgent(window.installKind)
    }
    SoftDialog {
        id: batchInstallDialog; title: "全部更新到最新版本"; anchors.centerIn: parent; modal: true; width: 540
        footer: SoftDialogButtons { ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } ActionButton { text: host.desiredRunning ? "全部更新并重新连接" : "全部更新到最新版本"; primary: true; enabled: !host.busy; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole } onAccepted: batchInstallDialog.accept(); onRejected: batchInstallDialog.reject() }
        ColumnLayout { width: parent.width; spacing: 12
            Repeater { model: window.batchAgentTargets(); delegate: Hint { required property var modelData; text: window.agentName(modelData.kind) + " → 最新兼容版本"; Layout.fillWidth: true } }
            DownloadBar { visible: host.downloadReceived >= 0; label: window.agentName(host.agentInstallKind) + " 下载"; received: host.downloadReceived; total: host.downloadTotal; Layout.fillWidth: true }
            Hint { visible: host.desiredRunning && host.runtimeCount > 0; text: "手机上 " + host.runtimeCount + " 个会话会暂时断开"; Layout.fillWidth: true; color: Theme.warning }
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
                        Heading { text: "选择预设或自定义"; font.pixelSize: Theme.body; Layout.fillWidth: true }
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
                    Rectangle { Layout.fillWidth: true; height: 1; color: Theme.hairline }
                }
                Label { text: "名称"; color: Theme.inkMuted }
                Field { id: providerName; objectName: "providerName"; Layout.fillWidth: true; maximumLength: 80; placeholderText: "例如：工作账号 / 自建 API" }
                Label { text: "供应商标识"; visible: window.providerDraft.kind === "pi" || providerDetails.checked; color: Theme.inkMuted }
                Field { id: providerKey; visible: window.providerDraft.kind === "pi" || providerDetails.checked; Layout.fillWidth: true; maximumLength: 128; placeholderText: "custom"; enabled: window.providerDraft.kind !== "pi" || !!window.providerDraft.create }
                Hint { visible: window.providerDraft.kind === "pi"; text: window.providerDraft.create ? "标识对应 models.json 的节点；保存后不可修改。" : "标识固定；修改名称不会更改模型引用。"; Layout.fillWidth: true }
                Label { text: "ChatGPT 登录来源"; visible: window.officialProvider && window.providerDraft.kind === "codex"; color: Theme.inkMuted }
                ProviderComboBox { id: providerAccount; visible: window.officialProvider && window.providerDraft.kind === "codex"; Layout.fillWidth: true; textRole: "label"; valueRole: "id"; model: [] }
                RowLayout { visible: window.officialProvider && window.providerDraft.kind === "codex"; Layout.fillWidth: true
                    ActionButton { text: "管理账号"; enabled: !host.busy; onClicked: { host.oauthAccount("list"); oauthDialog.open() } }
                }
                Hint { visible: window.officialProvider && window.providerDraft.kind === "claude"; text: "使用 Claude Code 已登录的官方订阅账号；请在 CLI 中完成登录。"; Layout.fillWidth: true }
                SoftSwitch { id: providerDetails; marksProviderDirty: false; text: "显示其他信息与高级标识" }
                ColumnLayout { visible: providerDetails.checked; Layout.fillWidth: true; spacing: 8
                    RowLayout { Layout.fillWidth: true
                        ColumnLayout { Layout.fillWidth: true
                            Label { text: "分类"; color: Theme.inkMuted }
                            Field { id: providerCategory; Layout.fillWidth: true; placeholderText: "custom / official / aggregator" }
                        }
                        ColumnLayout { Layout.preferredWidth: 100
                            Label { text: "排序"; color: Theme.inkMuted }
                            Field { id: providerOrder; Layout.fillWidth: true; validator: IntValidator {} }
                        }
                        ColumnLayout { Layout.preferredWidth: 130
                            Label { text: "图标"; color: Theme.inkMuted }
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
                Hint { visible: !!window.providerDraft.nativeOnly; text: "原生专有字段或 YAML 标签，只能在原生编辑器修改"; Layout.fillWidth: true }
                ColumnLayout { visible: !advancedProvider.checked; Layout.fillWidth: true; spacing: 12
                    Label { text: "API 地址"; visible: !window.officialProvider; color: Theme.inkMuted }
                    Field { id: providerUrl; objectName: "providerUrl"; visible: !window.officialProvider; Layout.fillWidth: true; placeholderText: "例如 https://api.example.com/v1" }
                    Label { text: "API Key / 凭据"; visible: !window.officialProvider; color: Theme.inkMuted }
                    Field { id: providerApiKey; objectName: "providerApiKey"; visible: !window.officialProvider; Layout.fillWidth: true; placeholderText: "API Key；已有环境变量认证会保留"; echoMode: TextInput.PasswordEchoOnEdit }
                    ColumnLayout { visible: window.providerDraft.kind === "claude"; Layout.fillWidth: true; spacing: 8
                        Label { text: "认证字段"; visible: !window.officialProvider; color: Theme.inkMuted }
                        ProviderComboBox { id: claudeCredential; visible: !window.officialProvider; Layout.fillWidth: true; model: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] }
                        Field { id: claudeHaiku; Layout.fillWidth: true; placeholderText: "Haiku 模型 ID（留空使用原生默认）" }
                        Field { id: claudeSonnet; Layout.fillWidth: true; placeholderText: "Sonnet 模型 ID（留空使用原生默认）" }
                        Field { id: claudeOpus; Layout.fillWidth: true; placeholderText: "Opus 模型 ID（留空使用原生默认）" }
                    }
                    Label { text: "默认模型"; visible: window.providerDraft.kind !== "pi"; color: Theme.inkMuted }
                    RowLayout { visible: window.providerDraft.kind !== "pi"; Layout.fillWidth: true; spacing: 12
                        Field { id: providerModel; objectName: "providerDefaultModel"; Layout.fillWidth: true; placeholderText: "填写模型 ID，或从模型列表选择" }
                        ActionButton { objectName: "fetchDefaultModel"; text: host.providerModelsLoading ? "获取中…" : "获取模型列表"; visible: window.providerDraft.kind === "codex" && !window.officialProvider; enabled: !host.busy && !host.providerModelsLoading && providerUrl.text.trim().length > 0; onClicked: window.requestProviderModels(-2) }
                    }
                    RowLayout { visible: window.providerDraft.kind === "codex"; Layout.fillWidth: true
                        Label { text: "思考档位"; color: Theme.inkMuted }
                        ProviderComboBox { id: codexReasoning; objectName: "codexReasoning"; Layout.fillWidth: true; model: ["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] }
                    }
                    Label { text: "接口格式"; visible: !window.officialProvider; color: Theme.inkMuted }
                    ProviderComboBox { id: providerApi; visible: !window.officialProvider; Layout.fillWidth: true; model: [] }
                    Hint { visible: window.providerDraft.kind === "codex" && !window.officialProvider && providerApi.currentText !== "openai-responses"; text: "需要已有的 Codex 本地 API 转换配置"; Layout.fillWidth: true }
                    SoftSwitch { id: providerProxyDetails; marksProviderDirty: false; text: "接口兼容与推理参数"; visible: window.providerDraft.kind === "codex" && !window.officialProvider }
                    ColumnLayout { visible: window.providerDraft.kind === "codex" && providerProxyDetails.checked; Layout.fillWidth: true; spacing: 8
                        SoftSwitch { id: providerFullUrl; text: "使用完整 API 端点地址" }
                        RowLayout { Layout.fillWidth: true
                            Label { text: "会话缓存路由"; color: Theme.inkMuted }
                            ProviderComboBox { id: providerCache; Layout.fillWidth: true; textRole: "label"; valueRole: "value"; model: [{label:"自动",value:"auto"},{label:"启用",value:"enabled"},{label:"禁用",value:"disabled"}] }
                        }
                        SoftSwitch { id: providerReasoningAuto; text: "自动识别推理参数" }
                        GridLayout { visible: !providerReasoningAuto.checked; columns: 2; Layout.fillWidth: true
                            SoftCheckBox { id: providerThinking; text: "支持思考开关" }
                            SoftCheckBox { id: providerEffort; text: "支持思考档位" }
                            Label { text: "思考开关参数"; color: Theme.inkMuted }
                            ProviderComboBox { id: providerThinkingParam; Layout.fillWidth: true; model: ["thinking", "enable_thinking", "reasoning_split", "none"] }
                            Label { text: "档位参数"; color: Theme.inkMuted }
                            ProviderComboBox { id: providerEffortParam; Layout.fillWidth: true; model: ["reasoning_effort", "reasoning.effort", "none"] }
                            Label { text: "档位映射"; color: Theme.inkMuted }
                            ProviderComboBox { id: providerEffortMode; Layout.fillWidth: true; model: ["passthrough", "deepseek", "low_high", "openrouter", "zen"] }
                        }
                        Label { text: "Chat 兼容参数（JSON）"; color: Theme.inkMuted }
                        SoftTextArea { id: providerChatOptions; Layout.fillWidth: true; Layout.preferredHeight: 64; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas" }
                        Label { text: "请求覆盖（headers / body）"; color: Theme.inkMuted }
                        SoftTextArea { id: providerRequestOverrides; Layout.fillWidth: true; Layout.preferredHeight: 90; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas" }
                    }
                    SoftSwitch { id: providerTransportDetails; marksProviderDirty: false; text: "请求头与兼容配置"; visible: !window.officialProvider && ["pi", "codex"].indexOf(window.providerDraft.kind) >= 0 }
                    Label { text: "请求头（JSON 对象）"; visible: providerTransportDetails.visible && providerTransportDetails.checked; color: Theme.inkMuted }
                    SoftTextArea { id: piHeaders; visible: providerTransportDetails.visible && providerTransportDetails.checked; Layout.fillWidth: true; Layout.preferredHeight: 64; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas" }
                    ColumnLayout { visible: window.providerDraft.kind === "pi" || window.providerDraft.kind === "dsh"; Layout.fillWidth: true; spacing: 8
                        Label { text: "兼容参数（JSON 对象）"; visible: window.providerDraft.kind === "pi" && providerTransportDetails.checked; color: Theme.inkMuted }
                        SoftTextArea { id: piCompat; visible: window.providerDraft.kind === "pi" && providerTransportDetails.checked; Layout.fillWidth: true; Layout.preferredHeight: 64; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas" }
                        RowLayout { Layout.fillWidth: true
                            Label { text: "模型目录"; color: Theme.inkMuted; font.bold: true }
                            Item { Layout.fillWidth: true }
                            ActionButton { objectName: "fetchCatalogModels"; text: host.providerModelsLoading ? "获取中…" : "获取模型列表"; enabled: !host.busy && !host.providerModelsLoading && providerUrl.text.trim().length > 0; onClicked: window.requestProviderModels(-1) }
                            ActionButton { text: "添加模型"; symbol: "add"; enabled: !host.providerModelsLoading; onClicked: window.addProviderModel() }
                        }
                        Repeater { model: window.providerModels
                            delegate: ColumnLayout {
                                id: modelEditor
                                required property var modelData
                                required property int index
                                property var reasoningMapping: modelData.reasoningEfforts
                                function saveReasoningMapping(value) {
                                    reasoningMapping = value
                                    window.updateProviderModel(index, "reasoningEfforts", value)
                                }
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
                                    Label { text: "上下文"; color: Theme.inkMuted }
                                    Field { Layout.fillWidth: true; text: modelData.contextWindow === undefined ? "" : String(modelData.contextWindow); placeholderText: window.providerDraft.kind === "pi" ? "128000" : window.providerDraft.kind === "dsh" ? "262144" : "继承原生默认"; inputMethodHints: Qt.ImhDigitsOnly; onTextEdited: window.updateProviderModel(index, "contextWindow", text) }
                                    Label { text: "最大输出"; color: Theme.inkMuted }
                                    Field { Layout.fillWidth: true; text: modelData.maxTokens === undefined ? "" : String(modelData.maxTokens); placeholderText: window.providerDraft.kind === "pi" ? "16384" : window.providerDraft.kind === "dsh" ? "32768" : "继承原生默认"; inputMethodHints: Qt.ImhDigitsOnly; onTextEdited: window.updateProviderModel(index, "maxTokens", text) }
                                }
                                SoftTextArea { visible: window.providerDraft.kind === "pi"; Layout.fillWidth: true; Layout.preferredHeight: 58; placeholderText: "思考档位映射（留空使用 Pi 默认值）"; text: modelData.thinkingLevelMap === undefined ? "" : JSON.stringify(modelData.thinkingLevelMap); selectByMouse: true; wrapMode: TextEdit.Wrap; onTextChanged: if (activeFocus) window.updateProviderModel(index, "thinkingLevelMap", text) }
                                ColumnLayout { visible: window.providerDraft.kind === "dsh"; Layout.fillWidth: true; spacing: 6
                                    RowLayout { Layout.fillWidth: true
                                        Label { text: "思考深度映射"; color: Theme.inkMuted }
                                        ProviderComboBox {
                                            objectName: "dshReasoningMode-" + modelEditor.index
                                            Layout.fillWidth: true; textRole: "label"; valueRole: "value"
                                            model: [{label:"自定义映射",value:"custom"},{label:"继承原生能力",value:"inherit"},{label:"不支持推理",value:"disabled"}]
                                            currentIndex: ProviderFlow.reasoningMode(modelEditor.reasoningMapping) === "inherit" ? 1 : ProviderFlow.reasoningMode(modelEditor.reasoningMapping) === "disabled" ? 2 : 0
                                            onActivated: function(selectedIndex) {
                                                var mode = model[selectedIndex].value
                                                modelEditor.saveReasoningMapping(mode === "custom" ? ProviderFlow.defaultReasoningEfforts() : mode === "disabled" ? false : undefined)
                                            }
                                        }
                                        ActionButton { text: "恢复默认"; onClicked: modelEditor.saveReasoningMapping(ProviderFlow.defaultReasoningEfforts()) }
                                    }
                                    Hint { Layout.fillWidth: true; text: "勾选模型支持的档位，在输入框填写 API 对应值。off 留空表示关闭思考；其他档位不能为空。" }
                                    GridLayout { visible: ProviderFlow.reasoningMode(modelEditor.reasoningMapping) === "custom"; Layout.fillWidth: true; columns: 2; columnSpacing: 12
                                        Repeater { model: ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
                                            delegate: RowLayout {
                                                id: effortRow
                                                required property string modelData
                                                property string level: modelData
                                                property bool selected: !!modelEditor.reasoningMapping && Object.prototype.hasOwnProperty.call(modelEditor.reasoningMapping, level)
                                                Layout.fillWidth: true
                                                SoftCheckBox {
                                                    text: effortRow.level; checked: effortRow.selected
                                                    onToggled: modelEditor.saveReasoningMapping(ProviderFlow.editReasoningEffort(modelEditor.reasoningMapping, effortRow.level, effortValue.text || (effortRow.level === "off" ? "" : effortRow.level), checked))
                                                }
                                                Field {
                                                    id: effortValue
                                                    objectName: "dshReasoning-" + modelEditor.index + "-" + effortRow.level
                                                    Layout.fillWidth: true; enabled: effortRow.selected
                                                    text: effortRow.selected && modelEditor.reasoningMapping[effortRow.level] !== null ? String(modelEditor.reasoningMapping[effortRow.level]) : ""
                                                    placeholderText: effortRow.level === "off" ? "留空表示关闭思考" : "API 档位值"
                                                    onTextEdited: modelEditor.saveReasoningMapping(ProviderFlow.editReasoningEffort(modelEditor.reasoningMapping, effortRow.level, text, true))
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                ColumnLayout { visible: advancedProvider.checked; Layout.fillWidth: true; spacing: 10
                    Hint { text: window.providerDraft.kind === "codex" ? "Codex 的 auth.json、config.toml 和其他字段分别编辑，保存时会还原为原生配置对象。" : window.providerDraft.kind === "dsh" ? "DSH 的 patch YAML、环境变量和其他字段分别编辑，保存时会还原为原生配置对象。" : window.providerDraft.kind === "claude" ? "Claude Code：供应商环境变量、模型和认证配置。" : "Pi：完整的 models.json.providers.<标识> 节点。"; Layout.fillWidth: true }
                    ColumnLayout { visible: window.providerDraft.kind === "codex"; Layout.fillWidth: true; spacing: 8
                        Label { text: "auth.json（JSON 对象或 null）"; color: Theme.inkMuted }
                        SoftTextArea { id: providerAuthJson; Layout.fillWidth: true; Layout.preferredHeight: 100; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas" }
                        Label { text: "config.toml（原文）"; color: Theme.inkMuted }
                        SoftTextArea { id: providerConfigToml; Layout.fillWidth: true; Layout.preferredHeight: 250; selectByMouse: true; wrapMode: TextEdit.NoWrap; font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas" }
                        Label { text: "其他字段（JSON 对象，可留空）"; color: Theme.inkMuted }
                        SoftTextArea { id: codexExtraJson; Layout.fillWidth: true; Layout.preferredHeight: 100; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas" }
                    }
                    ColumnLayout { visible: window.providerDraft.kind === "dsh"; Layout.fillWidth: true; spacing: 8
                        Label { text: "cordis.patch.yml（原文）"; color: Theme.inkMuted }
                        SoftTextArea { id: providerPatchYaml; Layout.fillWidth: true; Layout.preferredHeight: 220; selectByMouse: true; wrapMode: TextEdit.NoWrap; font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas" }
                        Label { text: "环境变量（JSON 对象）"; color: Theme.inkMuted }
                        SoftTextArea { id: providerEnvJson; Layout.fillWidth: true; Layout.preferredHeight: 100; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas" }
                        Label { text: "其他字段（JSON 对象，可留空）"; color: Theme.inkMuted }
                        SoftTextArea { id: dshExtraJson; Layout.fillWidth: true; Layout.preferredHeight: 100; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas" }
                    }
                    ColumnLayout { visible: ["pi", "claude"].indexOf(window.providerDraft.kind) >= 0; Layout.fillWidth: true
                        Hint { text: window.providerDraft.kind === "claude" ? "Claude Code：settings.json 中的供应商 env、模型和认证字段。Hooks、权限与共享设置保持不变。" : "Pi：完整的 models.json.providers.<标识> 节点。"; Layout.fillWidth: true }
                        SoftTextArea { id: providerJson; Layout.fillWidth: true; Layout.preferredHeight: 230; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas"; color: Theme.ink }
                    }
                }
                Hint { visible: host.message.length > 0; text: host.message; Layout.fillWidth: true; color: Theme.danger }
                Hint { visible: window.providerFormError.length > 0; text: window.providerFormError; Layout.fillWidth: true; color: Theme.danger }
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
        objectName: "providerChangePresetDialog"
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
        id: oauthDialog; title: "Codex（ChatGPT 账号）"; anchors.centerIn: parent; modal: true; width: 700; height: 560
        contentItem: ScrollView { clip: true; contentWidth: availableWidth
            ColumnLayout { width: oauthDialog.width - 44; spacing: 12
                RowLayout {
                    ActionButton { text: "添加账号"; primary: true; enabled: !host.busy && !window.oauthPending.deviceCode; onClicked: host.oauthAccount("start") }
                    ActionButton { text: "导入本机登录"; enabled: !host.busy; onClicked: host.oauthAccount("import") }
                    ActionButton { text: "刷新"; enabled: !host.busy; onClicked: host.oauthAccount("list") }
                }
                ColumnLayout { visible: !!window.oauthPending.deviceCode; Layout.fillWidth: true
                    Label { text: window.oauthPending.userCode || ""; font.pixelSize: Theme.display; font.bold: true; color: Theme.ink }
                    RowLayout {
                        ActionButton { text: "打开授权页"; onClicked: Qt.openUrlExternally(window.oauthPending.verificationUrl) }
                        ActionButton { text: "取消登录"; enabled: !host.busy; onClicked: { host.oauthAccount("cancel", window.oauthPending.deviceCode); window.oauthPending = ({}) } }
                    }
                }
                Repeater { model: window.oauthAccounts
                    delegate: ColumnLayout { required property var modelData; Layout.fillWidth: true
                        Label { text: (modelData.email || modelData.workspace) + (modelData.isDefault ? "（默认账号）" : ""); color: Theme.ink; font.bold: true }
                        Hint { text: modelData.workspace; Layout.fillWidth: true }
                        RowLayout {
                            ActionButton { text: "设为默认"; enabled: !host.busy && !modelData.isDefault; onClicked: host.oauthAccount("default", modelData.id) }
                            ActionButton { text: "重新登录"; enabled: !host.busy && !window.oauthPending.deviceCode; onClicked: host.oauthAccount("start", modelData.id) }
                            ActionButton { text: "删除账号"; danger: true; enabled: !host.busy; onClicked: { oauthDeleteDialog.accountId = modelData.id; oauthDeleteDialog.open() } }
                        }
                    }
                }
                Hint { text: host.message; visible: text.length > 0; Layout.fillWidth: true; color: Theme.danger }
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
            SoftTextArea { id: codexCommonText; Layout.fillWidth: true; Layout.preferredHeight: 230; selectByMouse: true; wrapMode: TextEdit.Wrap; font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas" }
            SoftSwitch { id: preserveCodexLogin; text: "切换第三方供应商时保留官方登录" }
            Hint { text: host.message; visible: text.length > 0; Layout.fillWidth: true; color: Theme.danger }
        }
        footer: SoftDialogActions {
            Item { Layout.fillWidth: true }
            ActionButton { text: "取消"; enabled: !host.busy; onClicked: codexPreferencesDialog.reject() }
            ActionButton { text: "保存"; primary: true; enabled: !host.busy; onClicked: host.saveCodexPreferences({ commonConfig: codexCommonText.text, preserveOfficialLogin: preserveCodexLogin.checked }) }
        }
    }
    SoftDialog {
        id: kimiHelp; anchors.centerIn: parent; modal: true; width: 410
        title: "Kimi Code"; standardButtons: Dialog.Ok
        contentItem: Hint { text: "桌面版：先打开 Kimi Code。Web：先运行 kimi web。" }
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
                ButtonGroup { id: discoveredModelGroup }
                Repeater { model: window.fetchedModels
                    SoftCheckBox {
                        required property var modelData; required property int index
                        objectName: "discoveredModel-" + modelData.id; marksProviderDirty: false
                        text: modelData.name === modelData.id ? modelData.id : modelData.name + "（" + modelData.id + "）"
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
        Label { width: parent.width; text: "仅移除 models.json 中的节点，卡片和最新配置仍保留。" + (host.piDefaultProvider === window.removeProviderId ? "\n这是 Pi 的全局默认供应商。" : ""); wrapMode: Text.WordWrap }
        standardButtons: Dialog.Cancel | Dialog.Ok
        onAccepted: host.switchProvider(window.removeProviderId, false)
    }
    SoftDialog {
        id: deleteProviderDialog; title: "删除供应商？"; anchors.centerIn: parent; modal: true; width: 410
        Label { width: parent.width; text: host.providerKind === "pi" ? "删除卡片和 models.json 中的对应供应商。" + (host.piDefaultProvider === window.deleteProviderId ? "\n这是 Pi 的全局默认供应商。" : "") : "删除这个未启用的供应商配置。"; wrapMode: Text.WordWrap }
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
        function onExitConfirmationRequested() { window.showNormal(); window.raise(); window.requestActivate(); exitDialog.open() }
        function onUpdateConfirmationRequested() { hostUpdateDialog.open() }
        function onInstallerConfirmationRequested() { window.showNormal(); window.raise(); window.requestActivate(); installerExitDialog.open() }
        function onExitReady() { exitProgressDialog.close() }
        function onChanged() {
            if (host.exiting) { if (!exitProgressDialog.visible) exitProgressDialog.open() }
            else exitProgressDialog.close()
            if (!host.exiting && host.qr.length > 0 && !pairDialog.visible) pairDialog.open()
            if (host.qr.length === 0 && pairDialog.visible) pairDialog.close()
        }
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
