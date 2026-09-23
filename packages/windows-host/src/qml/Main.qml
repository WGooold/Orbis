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
    onVisibleChanged: if (visible) host.refreshRegistrationPolicy()
    function selectPage(index) { page = index; if (index === 3) settingsPane.load() }
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
                                        model: [{n: "01", title: "激活这台电脑", detail: host.verificationRequired ? "用 QQ 邮箱验证并注册。" : "按当前服务器设置直接激活。"}, {n: "02", title: "接入你的 Agent", detail: "复用 Pi 或 Codex 的现有安装。"}, {n: "03", title: "手机扫码连接", detail: "在 Orbis Android 中扫码配对。"}]
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
                                model: [{label: "已配对设备", value: String(host.devices.length), detail: "每台设备均可独立撤销"}, {label: "在线会话", value: String(host.runtimeCount), detail: "由这台电脑上的 Host 提供"}, {label: "Agent 接入", value: String(host.agents.filter(a => a.installed).length), detail: "支持 Pi 与 Codex"}]
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
                        visible: window.page === 2; Layout.fillWidth: true; spacing: 16
                        RowLayout { Layout.fillWidth: true; Heading { text: "你的 Agent" } Item { Layout.fillWidth: true } ActionButton { text: "重新检测"; enabled: host.bridgeReady && !host.busy; onClicked: host.detectAgents() } }
                        Repeater {
                            model: host.agents
                            delegate: Card {
                                required property var modelData
                                Layout.fillWidth: true
                                ColumnLayout {
                                    anchors.fill: parent; spacing: 15
                                    RowLayout {
                                        Layout.fillWidth: true
                                        Heading { text: modelData.kind === "pi" ? "Pi" : "Codex" }
                                        Item { Layout.fillWidth: true }
                                        Hint { text: modelData.installed ? "已检测到安装" : "尚未安装"; color: modelData.installed ? "#278868" : "#8b7790" }
                                    }
                                    Hint { text: modelData.installed ? (modelData.version || "版本未知") : "可将推荐版本安装到 Orbis 的独立目录。"; Layout.fillWidth: true }
                                    Hint { visible: !!modelData.path; text: modelData.path || ""; Layout.fillWidth: true; font.pixelSize: 12; elide: Text.ElideMiddle; maximumLineCount: 2 }
                                    RowLayout {
                                        spacing: 10
                                        ActionButton { text: modelData.kind === "pi" ? "打开 Pi 并接入" : "打开 Codex 登录"; primary: true; visible: modelData.installed; enabled: !host.busy; onClicked: host.openAgent(modelData.kind) }
                                        ActionButton { text: "安装推荐版本"; visible: !modelData.installed; enabled: !host.busy; onClicked: { window.installKind = modelData.kind; installDialog.open() } }
                                    }
                                }
                            }
                        }
                        Hint { text: "Agent 的模型账号由官方登录流程管理。Pi 打开后可输入 /login 完成登录；Codex 登录完成后启动 Host 即可接入。"; Layout.fillWidth: true }
                        Hint { visible: host.busy; text: "正在处理，请稍候。首次安装需要下载依赖，可能需要几分钟。"; Layout.fillWidth: true }
                    }

                    Card {
                        id: settingsPane
                        visible: window.page === 3; Layout.fillWidth: true
                        function load() { relayField.text = host.relayUrl; nameField.text = host.hostName; piPathField.text = host.piEntry; codexPathField.text = host.codexEntry; startupSwitch.checked = host.autoStart; codexSwitch.checked = host.codexEnabled }
                        ColumnLayout {
                            anchors.fill: parent; spacing: 15
                            Heading { text: "常规" }
                            Label { text: "电脑名称"; color: "#4b5d78" }
                            Field { id: nameField; Layout.fillWidth: true; maximumLength: 80 }
                            SoftSwitch { id: startupSwitch; text: "登录 Windows 后自动启动" }
                            SoftSwitch { id: codexSwitch; text: "启动 Host 时启用 Codex" }
                            Heading { text: "中继服务器"; Layout.topMargin: 10 }
                            Field { id: relayField; Layout.fillWidth: true; placeholderText: "wss://服务器地址/relay" }
                            Hint { text: "支持默认中继或自建中继。更换服务器后需按新服务器设置重新激活，并为手机重新配对。"; Layout.fillWidth: true }
                            Heading { text: "Agent 路径"; Layout.topMargin: 10 }
                            Hint { text: "留空时自动检测。安装了多个版本时，可指定对应的 CLI JavaScript 入口文件。"; Layout.fillWidth: true }
                            Field { id: piPathField; Layout.fillWidth: true; placeholderText: "Pi：自动检测" }
                            Field { id: codexPathField; Layout.fillWidth: true; placeholderText: "Codex：自动检测" }
                            ActionButton { text: "保存设置"; primary: true; enabled: host.bridgeReady && !host.busy; onClicked: host.saveSettings(relayField.text, startupSwitch.checked, codexSwitch.checked, piPathField.text, codexPathField.text, nameField.text) }
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
        id: installDialog; title: "安装 " + (window.installKind === "pi" ? "Pi 0.84.4" : "Codex 0.154.0"); anchors.centerIn: parent; modal: true; width: 420
        background: NeuSurface { anchors.fill: parent; anchors.margins: -14; margin: 14; cornerRadius: 18 }
        footer: DialogButtonBox { ActionButton { text: "取消"; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole } ActionButton { text: "开始安装"; primary: true; DialogButtonBox.buttonRole: DialogButtonBox.AcceptRole } onAccepted: installDialog.accept(); onRejected: installDialog.reject() }
        Label { width: parent.width; text: "从 npm 下载推荐版本并安装到 Orbis 的独立目录。完成后仍需使用你自己的模型账号登录。"; wrapMode: Text.WordWrap }
        onAccepted: host.installAgent(window.installKind)
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
    }
}
