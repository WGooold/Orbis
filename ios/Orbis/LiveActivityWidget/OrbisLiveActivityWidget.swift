import ActivityKit
import SwiftUI
import WidgetKit

@main
struct OrbisLiveActivityBundle: WidgetBundle {
    var body: some Widget { OrbisLiveActivityWidget() }
}

/// LA-02: ActivityKit animates state changes, but all resting marks stay still.
/// In particular, elapsed time is an approximate confirmed minute value rather
/// than Text(timerInterval:) or a continuously changing spinner.
struct OrbisLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OrbisLiveActivityAttributes.self) { context in
            let presentation = context.presentation
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    OrbisActivityIdentity(presentation: presentation)
                    Spacer(minLength: 12)
                    Text(presentation.headline)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(presentation.tint)
                        .monospacedDigit()
                        .lineLimit(1)
                }
                OrbisActivityDetails(presentation: presentation)
            }
            .padding(18)
            .foregroundStyle(.white)
            .activityBackgroundTint(.black)
            .activitySystemActionForegroundColor(.white)
            .widgetURL(context.attributes.url(focusKey: context.state.focusKey))
        } dynamicIsland: { context in
            let presentation = context.presentation
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    OrbisActivityIdentity(presentation: presentation)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(presentation.headline)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(presentation.tint)
                        .monospacedDigit()
                        .lineLimit(1)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    OrbisActivityDetails(presentation: presentation)
                        .padding(.horizontal, 4)
                        .padding(.top, 8)
                        .padding(.bottom, 4)
                }
            } compactLeading: {
                Text(presentation.source.compactName)
                    .font(.caption2.weight(.medium))
                    .lineLimit(1)
                    .frame(maxWidth: 56)
                    .privacySensitive()
                    .accessibilityLabel(presentation.sourceAccessibilityLabel)
            } compactTrailing: {
                HStack(spacing: 4) {
                    if presentation.isAttention {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.caption)
                    }
                    Text(presentation.compactText)
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                }
                .foregroundStyle(presentation.tint)
                .accessibilityLabel(presentation.headline)
            } minimal: {
                HStack(spacing: 1) {
                    Text(presentation.source.badge)
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .minimumScaleFactor(0.65)
                        .lineLimit(1)
                        .privacySensitive()
                    if presentation.isAttention { Image(systemName: "exclamationmark").font(.system(size: 9, weight: .bold)) }
                }
                .foregroundStyle(presentation.tint)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(presentation.sourceAccessibilityLabel)
            }
            .widgetURL(context.attributes.url(focusKey: context.state.focusKey))
            .keylineTint(presentation.tint)
        }
    }
}

private extension ActivityViewContext where Attributes == OrbisLiveActivityAttributes {
    var presentation: OrbisLiveActivityPresentation {
        OrbisLiveActivityPresentation(state: state, isStale: isStale, language: attributes.language,
            initialFocusKey: attributes.initialFocusKey, initialTitle: attributes.initialTitle,
            hostId: attributes.hostId, source: attributes.source)
    }
}

private extension OrbisLiveActivityPresentation {
    var tint: Color {
        isAttention ? Color(red: 0.96, green: 0.77, blue: 0.46)
            : Color(white: isStale ? 0.58 : 0.82)
    }
}

private struct OrbisActivityMark: View {
    let presentation: OrbisLiveActivityPresentation
    let size: CGFloat
    var body: some View {
        Image(presentation.assetName)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(presentation.isStale ? Color.gray : Color.white)
            .accessibilityLabel(presentation.isAggregate ? "Orbis" : presentation.agentName)
    }
}

private struct OrbisActivityIdentity: View {
    let presentation: OrbisLiveActivityPresentation
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "desktopcomputer").font(.subheadline)
                .foregroundStyle(Color(white: 0.65))
            Text(presentation.source.name).font(.subheadline.weight(.medium))
                .lineLimit(1).privacySensitive()
        }
        .accessibilityElement(children: .combine)
    }
}

private struct OrbisActivityDetails: View {
    let presentation: OrbisLiveActivityPresentation
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                OrbisActivityMark(presentation: presentation, size: 18)
                Text(presentation.title)
                    .font(.headline)
                    .privacySensitive()
                    .foregroundStyle(.white)
                    .lineLimit(1)
            }
            Text(presentation.detail)
                .font(.subheadline)
                .foregroundStyle(Color(white: 0.65))
                .lineLimit(2)
            if !presentation.isEnded {
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    if presentation.isAttention {
                        Image(systemName: "exclamationmark.circle.fill")
                    } else if presentation.isStale {
                        Image(systemName: "clock.badge.questionmark")
                    } else if presentation.isEnded {
                        Image(systemName: presentation.state.outcome == "completed" ? "checkmark.circle" : "minus.circle")
                    } else {
                        Circle().frame(width: 4, height: 4)
                    }
                    Text(presentation.statusText)
                }
                .foregroundStyle(presentation.tint)
                Spacer(minLength: 8)
                if !presentation.isEnded {
                    HStack(spacing: 3) {
                        Text(presentation.actionText)
                        Image(systemName: "arrow.up.right")
                    }
                    .foregroundStyle(Color(white: 0.78))
                }
            }
            .font(.caption)
            .padding(.top, 8)
            }
            if let others = presentation.otherRunningText {
                Divider().overlay(Color(white: 0.15)).padding(.top, 4)
                Label(others, systemImage: "square.stack")
                    .font(.caption)
                    .foregroundStyle(Color(white: 0.6))
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentTransition(.identity)
        .transaction { transaction in
            if reduceMotion { transaction.animation = nil }
        }
    }
}
