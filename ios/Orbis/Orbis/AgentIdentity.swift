/// Presentation identity, shared by the app and Live Activity without changing wire kinds.
struct AgentIdentity {
    static let pi = AgentIdentity("Pi", "AgentPi", original: true)

    let title: String
    let original: Bool
    private let asset: String
    private let darkAsset: String?

    private init(_ title: String, _ asset: String, darkAsset: String? = nil, original: Bool = false) {
        self.title = title
        self.asset = asset
        self.darkAsset = darkAsset
        self.original = original
    }

    init?(kind: String?) {
        switch kind {
        case "pi": self = .pi
        case "codex", "codexDesktop": self.init("Codex", "AgentCodex")
        case "dsh", "dshDesktop": self.init("DeepSeek", "AgentDeepSeek")
        case "claude": self.init("Claude Code", "AgentClaude", original: true)
        case "kimiCode": self.init("Kimi Code Web", "AgentKimi", original: true)
        case "kimiCodeDesktop": self.init("Kimi Code 桌面版", "AgentKimi", original: true)
        case "openclaw": self.init("OpenClaw", "AgentOpenClaw", original: true)
        case "hermes": self.init("Hermes Agent", "AgentHermes")
        case "agy": self.init("Antigravity CLI", "AgentAgy")
        case "opencode": self.init("OpenCode", "AgentOpenCode", darkAsset: "AgentOpenCodeDark", original: true)
        default: return nil
        }
    }

    func assetName(dark: Bool) -> String { dark ? (darkAsset ?? asset) : asset }
}
