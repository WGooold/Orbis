import ActivityKit
import SwiftUI
import WidgetKit

@main
struct OrbisLiveActivityBundle: WidgetBundle {
    var body: some Widget { OrbisLiveActivityWidget() }
}

/// LIVE-ACTIVITY-02: two rows, each with one purpose. Use the same rows for
/// the Lock Screen and expanded island; compact/minimal carry no prose.
struct OrbisLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OrbisLiveActivityAttributes.self) { context in
            let presentation = context.presentation
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    OrbisActivitySource(presentation: presentation)
                    Spacer(minLength: 4)
                    OrbisActivityStatus(presentation: presentation)
                }
                OrbisActivityDetails(presentation: presentation)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .dynamicTypeSize(...DynamicTypeSize.accessibility1)
            .foregroundStyle(.white)
            .activityBackgroundTint(.black)
            .activitySystemActionForegroundColor(.white)
            .widgetURL(context.openURL)
        } dynamicIsland: { context in
            let presentation = context.presentation
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    OrbisActivitySource(presentation: presentation)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing, priority: 1) {
                    OrbisActivityStatus(presentation: presentation)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    OrbisActivityDetails(presentation: presentation)
                        .padding(.horizontal, 4).padding(.vertical, 4)
                }
            } compactLeading: {
                HStack(spacing: 3) {
                    OrbisActivityMark(agent: presentation.compactAgent, size: 16)
                    if let badge = presentation.badge { OrbisActivityBadge(text: badge) }
                }
                .foregroundStyle(.white)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(presentation.source.name)
            } compactTrailing: {
                OrbisActivityCompactStatus(presentation: presentation)
                    .foregroundStyle(presentation.tint)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(presentation.compactStatusAccessibilityLabel)
            } minimal: {
                Group {
                    if let badge = presentation.badge { OrbisActivityBadge(text: badge) }
                    else { OrbisActivityMark(agent: presentation.compactAgent, size: 16) }
                }
                .foregroundStyle(presentation.tint)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(presentation.sourceAccessibilityLabel)
            }
            .widgetURL(context.openURL)
            .keylineTint(presentation.tint)
        }
    }
}

private extension ActivityViewContext where Attributes == OrbisLiveActivityAttributes {
    var presentation: OrbisLiveActivityPresentation {
        (LiveActivityDisplayCache.read(from: LiveActivityDisplayCache.sharedURL()) ?? LiveActivityDisplayCache())
            .presentation(attributes: attributes, state: state, isStale: isStale,
                fallbackLanguage: Locale.preferredLanguages.first ?? "en")
    }
    var openURL: URL? { attributes.url(focusKey: state.isValid ? state.focusKey : nil) }
}

private extension OrbisLiveActivityPresentation {
    var tint: Color {
        switch status {
        case .attention: return Color(red: 0.96, green: 0.77, blue: 0.46)
        case .failed: return Color(red: 1, green: 0.47, blue: 0.49)
        case .completed: return Color(red: 0.49, green: 0.84, blue: 0.67)
        case .stale: return Color(white: 0.64)
        default: return Color(white: 0.84)
        }
    }
}

private struct OrbisActivityMark: View {
    let agent: AgentIdentity?
    let size: CGFloat
    var body: some View {
        Image(agent?.assetName(dark: true) ?? "OrbisMark")
            .renderingMode(agent?.original == true ? .original : .template)
            .resizable().scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

private struct OrbisActivityBadge: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 10, weight: .semibold, design: .monospaced))
            .lineLimit(1).minimumScaleFactor(0.65)
    }
}

private struct OrbisActivitySource: View {
    let presentation: OrbisLiveActivityPresentation
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "desktopcomputer").accessibilityHidden(true)
            Text(presentation.source.name).lineLimit(1).privacySensitive()
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(Color(white: 0.84))
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    }
}

private struct OrbisActivityStatus: View {
    let presentation: OrbisLiveActivityPresentation
    var body: some View {
        HStack(spacing: 4) {
            if presentation.status != .running {
                Image(systemName: presentation.statusSymbol).accessibilityHidden(true)
            }
            Text(presentation.headline).lineLimit(1).minimumScaleFactor(0.75).monospacedDigit()
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(presentation.tint)
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .layoutPriority(1)
    }
}

private struct OrbisActivityDetails: View {
    let presentation: OrbisLiveActivityPresentation
    var body: some View {
        if let details = presentation.details {
            HStack(spacing: 7) {
                OrbisActivityMark(agent: presentation.agent, size: 18)
                Text(details).font(.headline).lineLimit(1)
                    .privacySensitive(presentation.title != nil)
                Spacer(minLength: 4)
                if let started = presentation.startedText, details != started {
                    Text(started).font(.caption).monospacedDigit().lineLimit(1).minimumScaleFactor(0.8)
                        .foregroundStyle(Color(white: 0.74)).layoutPriority(1)
                }
            }
            .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        }
    }
}

private struct OrbisActivityCompactStatus: View {
    let presentation: OrbisLiveActivityPresentation
    var body: some View {
        HStack(spacing: 3) {
            if presentation.status != .running || presentation.compactText == nil {
                Image(systemName: presentation.statusSymbol)
                    .font(.system(size: presentation.status == .running ? 6 : 12, weight: .semibold))
            }
            if let text = presentation.compactText {
                Text(text).font(.system(size: 12, weight: .semibold)).monospacedDigit()
                    .lineLimit(1).minimumScaleFactor(0.75)
            }
        }
    }
}
