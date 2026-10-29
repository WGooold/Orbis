import SwiftUI

struct InteractionWorkspaceView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    let runtimeId: String
    @State private var selectedId: String?
    @State private var open = false
    @StateObject private var drafts = InteractionDraftCache(preferences: ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--preview-screen=") }) ? nil : .standard)
    var body: some View {
        let requests = store.interactions[runtimeId] ?? []
        Group {
            if !requests.isEmpty {
                Button { open = true } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "exclamationmark.bubble")
                        Text(requests.count == 1 ? requests[0].title : "\(requests.count) 项交互待确认").font(.system(size: 13, weight: .semibold)).lineLimit(2)
                        Spacer()
                        Text("打开").font(.system(size: 12))
                        Image(systemName: "chevron.up").font(.system(size: 11))
                    }.padding(14).frame(minHeight: 48)
                }.buttonStyle(NeuButtonStyle(radius: 16)).padding(.horizontal, 16).accessibilityIdentifier("interaction-open")
            }
        }
        .sheet(isPresented: $open) {
            VStack(spacing: 14) {
                OrbisPageHeader(title: "远程交互", back: { open = false }) { Text("\(requests.count) 项").font(.system(size: 12)) }
                if requests.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(requests) { request in
                                Button { selectedId = request.requestId } label: {
                                    Text(request.title).font(.system(size: 12)).lineLimit(1).padding(.horizontal, 14).frame(minHeight: 44)
                                }.buttonStyle(NeuButtonStyle(selected: (selectedId ?? requests.first?.requestId) == request.requestId, radius: 12))
                            }
                        }.padding(6)
                    }.padding(.horizontal, 16)
                }
                if let request = requests.first(where: { $0.requestId == selectedId }) ?? requests.first {
                    let key = interactionDraftKey(host: store.selectedHost, sessionId: store.runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId, request: request)
                    InteractionRequestView(request: request, draft: drafts.value(for: key, request: request), onDraftChange: { drafts.save($0, for: key, request: request) }).id(key)
                        .padding(.horizontal, 16).padding(.bottom, 20)
                }
            }.foregroundStyle(OrbisPalette(scheme).text).background(OrbisPalette(scheme).base.ignoresSafeArea()).orbisSheet([.large])
        }
        .onAppear { if !requests.isEmpty { open = true } }
        .onChange(of: requests.map(\.requestId)) { old, next in
            if next.isEmpty { open = false; selectedId = nil }
            else if next.contains(where: { !old.contains($0) }) { open = true }
        }
        .onChange(of: store.selectedHostId) { _, _ in open = false }
    }
}

private struct InteractionRequestView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL
    let request: InteractionRequest
    let draft: InteractionDraftValue
    let onDraftChange: (InteractionDraftValue) -> Void
    @State private var choices: Set<String> = []
    @State private var input = ""
    @State private var answers: [String: Set<String>] = [:]
    @State private var other: [String: String] = [:]
    @State private var notes: [String: String] = [:]
    @State private var expanded = true
    private var draftValue: InteractionDraftValue { InteractionDraftValue(input: input, choices: choices, answers: answers, other: other, notes: notes) }

    private var pending: Bool { store.submittingInteractions.contains(request.requestId) || request.submitted == true }
    private var valid: Bool { request.acceptsResponse(draftValue.response(for: request)) }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let expired = Int64(context.date.timeIntervalSince1970 * 1000) >= request.expiresAt
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.bubble").foregroundStyle(OrbisPalette(scheme).accent)
                    Text(request.title).font(.system(size: 14, weight: .semibold)).lineLimit(2)
                    Spacer(minLength: 0)
                    if pending { ProgressView().controlSize(.small) }
                    else { Text(expired ? "已过期" : "待确认").font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).accent) }
                    OrbisIconButton(symbol: expanded ? "chevron.up" : "chevron.down", label: expanded ? "收起交互" : "展开交互", size: 32) { expanded.toggle() }
                }
                if expanded {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            if let description = request.description { Text(description).font(.system(size: 13)) }
                            if let summary = request.argumentSummary { Text(summary).font(.system(size: 12, design: .monospaced)).textSelection(.enabled) }
                            if let external = request.externalUrl, let url = URL(string: external), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                                OrbisTextButton(title: "在浏览器打开", symbol: "safari") { openURL(url) }
                            }
                            content
                        }
                    }.frame(maxHeight: .infinity)
                    HStack(spacing: 12) {
                        OrbisActionButton(title: request.cancelLabel ?? (request.kind == "confirm" ? "拒绝" : "取消")) {
                            _ = store.respond(request, response: request.kind == "confirm" ? ["kind": "confirm", "value": false] : ["kind": "cancel"])
                        }
                        OrbisActionButton(title: request.confirmLabel ?? (request.kind == "confirm" ? "允许" : "提交"), symbol: "checkmark") { submit() }.disabled(!valid)
                    }.disabled(pending || expired || store.connection != .secured)
                } else {
                    OrbisTextButton(title: "打开并完成交互", symbol: "chevron.down") { expanded = true }
                }
                if pending { Text("已提交，等待电脑端确认").font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).secondary) }
            }.padding(16).neuSurface(inset: true, radius: 20, intensity: 0.6)
        }.onAppear {
            input = draft.input; choices = draft.choices.intersection(Set((request.options ?? []).map(\.value)))
            answers = draft.answers; other = draft.other; notes = draft.notes
        }.onChange(of: draftValue) { _, value in onDraftChange(value) }
    }

    @ViewBuilder private var content: some View {
        switch request.kind {
        case "select", "multi-select":
            ForEach(request.options ?? []) { option in
                optionButton(option, selected: choices.contains(option.value)) {
                    if request.kind == "select" { choices = [option.value] }
                    else if !choices.insert(option.value).inserted { choices.remove(option.value) }
                }
            }
        case "input":
            if request.secret == true { SecureField(request.placeholder ?? "输入内容", text: $input).orbisInput().accessibilityIdentifier("interaction-input") }
            else { TextField(request.placeholder ?? "输入内容", text: $input, axis: .vertical).lineLimit(2...6).orbisInput().accessibilityIdentifier("interaction-input") }
        case "questionnaire":
            ForEach(request.questions ?? []) { question in
                VStack(alignment: .leading, spacing: 12) {
                    if let header = question.header { Text(header).font(.system(size: 11, weight: .semibold)).foregroundStyle(OrbisPalette(scheme).accent) }
                    Text(question.question).font(.system(size: 14, weight: .medium))
                    ForEach(question.options) { option in
                        optionButton(option, selected: answers[question.id]?.contains(option.value) == true) {
                            if question.multiSelect == true {
                                var values = answers[question.id] ?? []
                                if !values.insert(option.value).inserted { values.remove(option.value) }
                                answers[question.id] = values
                            } else { answers[question.id] = [option.value]; other[question.id] = nil }
                        }
                    }
                    if question.allowOther == true {
                        if question.secret == true { SecureField("其他回答", text: textBinding($other, question.id)).orbisInput() }
                        else { TextField("其他回答", text: textBinding($other, question.id), axis: .vertical).orbisInput() }
                    }
                    if question.allowNotes == true {
                        if question.secret == true { SecureField("补充说明（可选）", text: textBinding($notes, question.id)).orbisInput() }
                        else { TextField("补充说明（可选）", text: textBinding($notes, question.id), axis: .vertical).orbisInput() }
                    }
                    if (other[question.id]?.utf16.count ?? 0) > 4_000 || (notes[question.id]?.utf16.count ?? 0) > 4_000 {
                        Text("其他回答和补充说明各不能超过 4,000 个字符。").font(.system(size: 11)).foregroundStyle(OrbisPalette(scheme).error)
                    }
                }
                .onChange(of: other[question.id]) { _, value in
                    if question.multiSelect != true, value?.isEmpty == false { answers[question.id] = [] }
                }
            }
        case "confirm": EmptyView()
        default: Text("此交互需要在电脑端完成。").font(.system(size: 13)).foregroundStyle(OrbisPalette(scheme).secondary)
        }
    }

    private func textBinding(_ values: Binding<[String: String]>, _ key: String) -> Binding<String> {
        Binding(get: { values.wrappedValue[key] ?? "" }, set: { values.wrappedValue[key] = $0 })
    }
    private func optionButton(_ option: RuntimeOption, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle").padding(.top, 2)
                VStack(alignment: .leading, spacing: 4) {
                    Text(option.label).font(.system(size: 13, weight: .medium))
                    if let description = option.description { Text(description).font(.system(size: 12)).foregroundStyle(OrbisPalette(scheme).secondary) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(12).frame(minHeight: 48)
        }.buttonStyle(NeuButtonStyle(selected: selected, radius: 14)).disabled(pending)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
    private func submit() {
        _ = store.respond(request, response: draftValue.response(for: request))
    }
}
