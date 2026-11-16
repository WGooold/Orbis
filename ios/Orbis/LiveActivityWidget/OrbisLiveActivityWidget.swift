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
                    OrbisActivityMark(presentation: presentation, size: 24)
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
                OrbisActivityMark(presentation: presentation, size: 19)
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
                if presentation.isAttention {
                    Image(systemName: "exclamationmark.circle.fill")
                        .foregroundStyle(presentation.tint)
                        .accessibilityLabel(presentation.statusText)
                } else {
                    OrbisActivityMark(presentation: presentation, size: 19)
                }
            }
            .widgetURL(context.attributes.url(focusKey: context.state.focusKey))
            .keylineTint(presentation.tint)
        }
    }
}

private extension ActivityViewContext where Attributes == OrbisLiveActivityAttributes {
    var presentation: OrbisLiveActivityPresentation {
        OrbisLiveActivityPresentation(state: state, isStale: isStale, language: attributes.language,
            initialFocusKey: attributes.initialFocusKey, initialTitle: attributes.initialTitle)
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
            OrbisActivityMark(presentation: presentation, size: 22)
            Text("Orbis").font(.subheadline.weight(.medium))
        }
    }
}

private struct OrbisActivityDetails: View {
    let presentation: OrbisLiveActivityPresentation
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(presentation.title)
                .font(.headline)
                .privacySensitive()
                .foregroundStyle(.white)
                .lineLimit(1)
            Text(presentation.detail)
                .font(.subheadline)
                .foregroundStyle(Color(white: 0.65))
                .lineLimit(2)
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
