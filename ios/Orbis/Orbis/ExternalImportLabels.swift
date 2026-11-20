func importProblemText(_ problem: ExternalImportProblem) -> String {
    switch problem {
    case .empty: L10n.tr("没有可发送的内容")
    case .unsupported: L10n.tr("不支持此分享内容")
    case .limit: L10n.tr("内容超过大小或数量上限")
    case .full: L10n.tr("待发送内容已满，请先删除一些")
    case .busy: L10n.tr("上一条还在处理，请稍后再试")
    case .unreadable: L10n.tr("无法读取分享的内容")
    case .targetUnavailable: L10n.tr("所选会话已不可用")
    case .launchConfiguration: L10n.tr("会话配置还没准备好，请稍后再试")
    case .hostUpgrade: L10n.tr("电脑端版本较旧，更新后才能发送")
    case .uploadFailed: L10n.tr("上传未完成，附件已保留")
    case .alreadyAssigned: L10n.tr("这条内容已选定其他会话")
    }
}
