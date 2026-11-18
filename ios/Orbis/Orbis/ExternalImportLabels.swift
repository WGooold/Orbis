func importProblemText(_ problem: ExternalImportProblem) -> String {
    switch problem {
    case .empty: L10n.tr("没有可导入的内容")
    case .unsupported: L10n.tr("不支持此分享内容")
    case .limit: L10n.tr("导入内容超过大小或数量上限")
    case .full: L10n.tr("待导入空间已满")
    case .busy: L10n.tr("已有导入正在进行，请稍后重试")
    case .unreadable: L10n.tr("无法读取导入内容")
    }
}
