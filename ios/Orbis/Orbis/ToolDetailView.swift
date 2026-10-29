import SwiftUI
import UIKit

struct ToolDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var reader: ToolContentReader
    let title: String
    var body: some View {
        VStack(spacing: 16) {
            OrbisPageHeader(title: title, back: { dismiss() }) {
                OrbisCopyButton(label: "复制已读取内容", size: 40) { reader.text }.disabled(reader.text.isEmpty)
            }
            HStack {
                Text(toolPartTitle(reader.locator?.part ?? "output")).font(.orbisLabel(.semibold))
                Spacer()
                Text("已读取至 \(byteCount(reader.throughOffset))").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
            }.padding(.horizontal, 24)
            if reader.discardedPrefix { OrbisNotice(text: "已清空较早内容，当前只保留最近读取的 2 MiB。").padding(.horizontal, 24) }
            if !reader.gaps.isEmpty { OrbisNotice(text: "来源存在不可恢复的内容缺口，当前读取范围不代表完整输出。", error: true).padding(.horizontal, 24) }
            ScrollView([.horizontal, .vertical]) {
                Text(reader.text.isEmpty ? (reader.loading ? "读取中…" : "当前范围没有文本内容。") : reader.text)
                    .font(.orbisCaption(mono: true)).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .topLeading).padding(18)
            }.neuSurface(inset: true, radius: 16, intensity: 0.4).padding(.horizontal, 20)
            // One footer slot of fixed height: loading, paging and the end state replace each other in place.
            Group {
                if let error = reader.error {
                    VStack(spacing: 12) {
                        OrbisNotice(text: error, error: true)
                        OrbisActionButton(title: "重新读取", symbol: "arrow.clockwise", action: reader.retry)
                    }
                } else if reader.nextCursor != nil {
                    OrbisActionButton(title: reader.loading ? "正在读取…" : "读取下一页", symbol: "arrow.down", action: reader.loadNext).disabled(reader.loading)
                } else if reader.loading {
                    ProgressView().controlSize(.small)
                } else {
                    Text(reader.final ? "已到当前读取范围末尾" : "已到当前末尾，工具可能仍在运行").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                }
            }.frame(maxWidth: .infinity, minHeight: 52).padding(.horizontal, 24)
            Toggle("跟随输出", isOn: Binding(get: { reader.following }, set: reader.follow))
                .toggleStyle(NeuToggleStyle())
                .font(.orbisBody()).padding(.horizontal, 24).padding(.bottom, 24).disabled(reader.final && reader.nextCursor == nil)
        }.background(OrbisPalette(scheme).base.ignoresSafeArea())
            .onDisappear { reader.close() }
            .onChange(of: scenePhase) { _, phase in if phase != .active { reader.close(); dismiss() } }
            .onChange(of: reader.locator) { _, locator in if locator == nil { dismiss() } }
    }
}

struct LiveToolsView: View {
    @EnvironmentObject private var store: OrbisStore
    @EnvironmentObject private var inventory: ToolInventories
    let runtime: RuntimeSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if inventory.loading.contains(runtime.runtimeId) { ProgressView("正在同步工具活动…").font(.orbisCaption()) }
            if let error = inventory.errors[runtime.runtimeId] {
                OrbisNotice(text: error, error: true)
                OrbisActionButton(title: "重试工具清单", symbol: "arrow.clockwise") { inventory.retry(runtime.runtimeId) }.disabled(!store.canSend)
            }
        }
    }
}

func toolPartTitle(_ part: String) -> String {
    switch part { case "arguments": return "参数"; case "result": return "结果"; default: return "输出" }
}
