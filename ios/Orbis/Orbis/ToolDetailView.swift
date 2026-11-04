import SwiftUI
import UIKit

struct ToolDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @AppStorage("orbis.visualStyle") private var visualStyle = "classic"
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var reader: ToolContentReader
    let title: String
    var body: some View {
        VStack(spacing: 16) {
            OrbisPageHeader(title: title, closes: true, back: { dismiss() }) {
                OrbisCopyButton(label: L10n.tr("复制已读取内容"), size: 40) { reader.text }.disabled(reader.text.isEmpty)
            }
            HStack {
                Text(toolPartTitle(reader.locator?.part ?? "output")).font(.orbisLabel(.semibold))
                Spacer()
                Text(L10n.tr("已读取至 {0}", byteCount(reader.throughOffset))).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
            }.padding(.horizontal, 24)
            if reader.discardedPrefix { OrbisNotice(text: L10n.tr("已清空较早内容，当前只保留最近读取的 2 MiB。")).padding(.horizontal, 24) }
            if !reader.gaps.isEmpty { OrbisNotice(text: L10n.tr("来源存在不可恢复的内容缺口，当前读取范围不代表完整输出。"), error: true).padding(.horizontal, 24) }
            ScrollView([.horizontal, .vertical]) {
                Text(reader.text.isEmpty ? (reader.loading ? L10n.tr("读取中…") : L10n.tr("当前范围没有文本内容。")) : reader.text)
                    .font(.orbisCaption(mono: true)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .topLeading).padding(18)
            }.neuSurface(inset: true, radius: 16, intensity: 0.4).padding(.horizontal, 20)
            // One footer slot of fixed height: loading, paging and the end state replace each other in place.
            Group {
                if let error = reader.error {
                    VStack(spacing: 12) {
                        OrbisNotice(text: error, error: true)
                        OrbisActionButton(title: L10n.tr("重新读取"), symbol: "arrow.clockwise", action: reader.retry)
                    }
                } else if reader.nextCursor != nil {
                    OrbisActionButton(title: reader.loading ? L10n.tr("正在读取…") : L10n.tr("读取下一页"), symbol: "arrow.down", action: reader.loadNext).disabled(reader.loading || reader.exporting)
                } else if reader.loading {
                    ProgressView().controlSize(.small)
                } else {
                    Text(reader.final ? L10n.tr("已到当前读取范围末尾") : L10n.tr("已到当前末尾，工具可能仍在运行")).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                }
            }.frame(maxWidth: .infinity, minHeight: 52).padding(.horizontal, 24)
            if reader.exporting {
                ProgressView(L10n.tr("正在导出，{0}", byteCount(reader.exportedBytes))).font(.orbisCaption()).accessibilityIdentifier("tool-export-progress")
                OrbisActionButton(title: L10n.tr("取消导出"), symbol: "xmark", action: reader.cancelExport).padding(.horizontal, 24)
            } else {
                HStack(spacing: 12) {
                    OrbisActionButton(title: L10n.tr("导出当前部分"), symbol: "square.and.arrow.down", action: export).disabled(reader.loading).accessibilityIdentifier("tool-export")
                    if reader.exportComplete, let path = reader.exportedPath {
                        ShareLink(item: URL(fileURLWithPath: path)) { Label(L10n.tr("分享导出文件"), systemImage: "square.and.arrow.up").font(.orbisCaption()).frame(minHeight: 48) }
                            .buttonStyle(NeuButtonStyle()).accessibilityIdentifier("tool-export-share")
                    }
                }.padding(.horizontal, 24)
                if reader.exportComplete { Text(L10n.tr("已导出 {0}", byteCount(reader.exportedBytes))).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary) }
            }
            Toggle(L10n.tr("跟随输出"), isOn: Binding(get: { reader.following }, set: reader.follow))
                .toggleStyle(NeuToggleStyle())
                .font(.orbisBody()).padding(.horizontal, 24).padding(.bottom, 24).disabled(reader.exporting || (reader.final && reader.nextCursor == nil))
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onDisappear { reader.close() }
            .onChange(of: scenePhase) { _, phase in if phase != .active { reader.close(); dismiss() } }
            .onChange(of: reader.locator) { _, locator in if locator == nil { dismiss() } }
    }
    private func export() {
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        reader.export(to: documents.appendingPathComponent("Tool Exports", isDirectory: true).appendingPathComponent("tool-" + UUID().uuidString + ".txt"))
    }
}

struct LiveToolsView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var inventory: ToolInventories
    let runtime: RuntimeSummary
    var body: some View {
        let loading = inventory.loading.contains(runtime.runtimeId), error = inventory.errors[runtime.runtimeId]
        // Nothing at all when idle: an empty stack would still take a row of list spacing above the composer.
        if loading || error != nil {
            VStack(alignment: .leading, spacing: 12) {
                if loading { ProgressView(L10n.tr("正在同步工具活动…")).font(.orbisCaption()) }
                if let error {
                    OrbisNotice(text: error, error: true)
                    OrbisActionButton(title: L10n.tr("重试工具清单"), symbol: "arrow.clockwise") { inventory.retry(runtime.runtimeId) }.disabled(!store.canSend)
                }
            }
        }
    }
}

func toolPartTitle(_ part: String) -> String {
    switch part { case "arguments": return L10n.tr("参数"); case "result": return L10n.tr("结果"); default: return L10n.tr("输出") }
}
