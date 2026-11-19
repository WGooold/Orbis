func importProblemText(_ problem: ExternalImportProblem) -> String {
    switch problem {
    case .empty: L10n.tr("没有可导入的内容")
    case .unsupported: L10n.tr("不支持此分享内容")
    case .limit: L10n.tr("导入内容超过大小或数量上限")
    case .full: L10n.tr("待导入空间已满")
    case .busy: L10n.tr("已有导入正在进行，请稍后重试")
    case .unreadable: L10n.tr("无法读取导入内容")
    case .targetUnavailable: L10n.tr("所选会话已不可用")
    case .launchConfiguration: L10n.tr("配置未确认，请刷新核对")
    case .hostUpgrade: L10n.tr("更新电脑端后可发送导入内容")
    case .uploadFailed: L10n.tr("上传未完成，附件已保留")
    case .alreadyAssigned: L10n.tr("此内容已加入其他会话草稿")
    }
}
