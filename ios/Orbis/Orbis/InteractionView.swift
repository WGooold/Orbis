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
        let inline = requests.count == 1 && requests[0].kind == "confirm"
        // No reserved space: the panel floats above the composer over the transcript,
        // so neither an empty slot nor an arriving request moves the input field.
        Color.clear.frame(height: 0).overlay(alignment: .bottom) {
            if inline, let request = requests.first {
                requestView(request, inSheet: false).padding(.horizontal, 16).padding(.bottom, 10).fixedSize(horizontal: false, vertical: true)
            } else if !requests.isEmpty {
                Button { open = true } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "exclamationmark.bubble")
                        Text(requests.count == 1 ? requests[0].title : "\(requests.count) 项交互待确认").font(.orbisLabel(.semibold)).lineLimit(2)
                        Spacer()
                        Text("打开").font(.orbisCaption())
                        Image(systemName: "chevron.up").font(.orbisCaption())
                    }.padding(14).frame(minHeight: 48)
                }.buttonStyle(NeuButtonStyle(radius: 16)).padding(.horizontal, 16).padding(.bottom, 10).accessibilityIdentifier("interaction-open")
            }
        }
        .sheet(isPresented: $open) {
            VStack(spacing: 14) {
                OrbisPageHeader(title: "远程交互", closes: true, back: { open = false }) { Text("\(requests.count) 项").font(.orbisCaption()) }
                if requests.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(requests) { request in
                                Button { selectedId = request.requestId } label: {
                                    Text(request.title).font(.orbisCaption()).lineLimit(1).padding(.horizontal, 14).frame(minHeight: 44)
                                }.buttonStyle(NeuButtonStyle(selected: (selectedId ?? requests.first?.requestId) == request.requestId, radius: 12))
                            }
                        }.padding(6)
                    }.padding(.horizontal, 16)
                }
                if let request = requests.first(where: { $0.requestId == selectedId }) ?? requests.first {
                    requestView(request, inSheet: true)
                        .padding(.horizontal, 16).padding(.bottom, 20)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .foregroundStyle(OrbisPalette(scheme).text).background(OrbisPalette(scheme).base.ignoresSafeArea()).orbisSheet([.large])
        }
        .onAppear { if !requests.isEmpty && !inline { open = true } }
        .onChange(of: requests.map(\.requestId)) { old, next in
            if next.isEmpty { open = false; selectedId = nil }
            else if inline { open = false }
            else if next.contains(where: { !old.contains($0) }) { open = true }
        }
        .onChange(of: store.selectedHostId) { _, _ in open = false }
    }

    private func requestView(_ request: InteractionRequest, inSheet: Bool) -> some View {
        let key = interactionDraftKey(host: store.selectedHost, sessionId: store.runtimes.first(where: { $0.runtimeId == runtimeId })?.sessionId, request: request)
        return InteractionRequestView(request: request, draft: drafts.value(for: key, request: request), onDraftChange: { drafts.save($0, for: key, request: request) }, inSheet: inSheet).id(key)
    }
}

private struct InteractionRequestView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL
    @Environment(\.orbisAccent) private var pageAccent
    let request: InteractionRequest
    let draft: InteractionDraftValue
    let onDraftChange: (InteractionDraftValue) -> Void
    let inSheet: Bool
    @State private var choices: Set<String> = []
    @State private var input = ""
    @State private var answers: [String: Set<String>] = [:]
    @State private var other: [String: String] = [:]
    @State private var notes: [String: String] = [:]
    @State private var expanded = true
    private var draftValue: InteractionDraftValue { InteractionDraftValue(input: input, choices: choices, answers: answers, other: other, notes: notes) }
    @FocusState private var focusedField: String?

    private var pending: Bool { store.submittingInteractions.contains(request.requestId) || request.submitted == true }
    private var valid: Bool { request.acceptsResponse(draftValue.response(for: request)) }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let expired = Int64(context.date.timeIntervalSince1970 * 1000) >= request.expiresAt
            let p = OrbisPalette(scheme)
            VStack(alignment: .leading, spacing: 0) {
                Button { if request.kind != "confirm" { expanded.toggle() } } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.bubble").foregroundStyle(pageAccent ?? p.accent)
                        Text(request.title).font(.orbisBody(.semibold)).lineLimit(2)
                        Spacer(minLength: 0)
                        // One fixed status slot: submitting swaps the label for a spinner without reflowing the title.
                        ZStack(alignment: .trailing) {
                            Text(expired ? "已过期" : "待确认").font(.orbisCaption()).foregroundStyle(pageAccent ?? p.accent).opacity(pending ? 0 : 1)
                            if pending { ProgressView().controlSize(.small) }
                        }.accessibilityLabel(pending ? "已提交，等待电脑端确认" : expired ? "已过期" : "待确认")
                        if request.kind != "confirm" {
                            Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(p.secondary)
                                .rotationEffect(.degrees(expanded ? 180 : 0)).animation(.orbisCollapse, value: expanded)
                                .frame(width: 24)
                        }
                    }.frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain)
                    .accessibilityHint(request.kind == "confirm" ? "" : expanded ? "收起交互" : "展开交互")
                OrbisCollapse(expanded: expanded || request.kind == "confirm") {
                    VStack(alignment: .leading, spacing: 12) {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 14) {
                                if let description = request.description { Text(description).font(.orbisLabel()) }
                                if let summary = request.argumentSummary { Text(summary).font(.orbisCaption(mono: true)).textSelection(.enabled) }
                                if let external = request.externalUrl, let url = URL(string: external), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                                    OrbisTextButton(title: "在浏览器打开", symbol: "safari") { openURL(url) }
                                }
                                content
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.frame(maxHeight: inSheet ? .infinity : 220).scrollBounceBehavior(.basedOnSize)
                        HStack(spacing: 12) {
                            OrbisActionButton(title: request.cancelLabel ?? (request.kind == "confirm" ? "拒绝" : "取消")) {
                                let accepted = store.respond(request, response: request.kind == "confirm" ? ["kind": "confirm", "value": false] : ["kind": "cancel"])
                                if accepted && request.kind == "confirm" { OrbisHaptics.commit() }
                            }
                            OrbisActionButton(title: request.confirmLabel ?? (request.kind == "confirm" ? "允许" : "提交"), symbol: "checkmark") { submit() }.disabled(!valid)
                        }.disabled(pending || expired || store.connection != .secured)
                    }.padding(.top, 8)
                }
            }.neuSurface(inset: true, radius: OrbisRadius.card, intensity: 0.6, padding: OrbisRadius.cardPadding)
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
            if request.secret == true {
                SecureField(request.placeholder ?? "输入内容", text: $input).font(.orbisBody())
                    .focused($focusedField, equals: "input").orbisInput(focused: focusedField == "input").accessibilityIdentifier("interaction-input")
            } else {
                TextField(request.placeholder ?? "输入内容", text: $input, axis: .vertical).font(.orbisBody()).lineLimit(2...6)
                    .focused($focusedField, equals: "input").orbisInput(focused: focusedField == "input").accessibilityIdentifier("interaction-input")
            }
        case "questionnaire":
            ForEach(request.questions ?? []) { question in
                VStack(alignment: .leading, spacing: 12) {
                    if let header = question.header { Text(header).font(.orbisCaption(.semibold)).foregroundStyle(OrbisPalette(scheme).accent) }
                    Text(question.question).font(.orbisBody(.medium))
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
                        let key = "other-" + question.id
                        if question.secret == true {
                            SecureField("其他回答", text: textBinding($other, question.id)).font(.orbisBody())
                                .focused($focusedField, equals: key).orbisInput(focused: focusedField == key)
                        } else {
                            TextField("其他回答", text: textBinding($other, question.id), axis: .vertical).font(.orbisBody())
                                .focused($focusedField, equals: key).orbisInput(focused: focusedField == key)
                        }
                    }
                    if question.allowNotes == true {
                        let key = "notes-" + question.id
                        if question.secret == true {
                            SecureField("补充说明（可选）", text: textBinding($notes, question.id)).font(.orbisBody())
                                .focused($focusedField, equals: key).orbisInput(focused: focusedField == key)
                        } else {
                            TextField("补充说明（可选）", text: textBinding($notes, question.id), axis: .vertical).font(.orbisBody())
                                .focused($focusedField, equals: key).orbisInput(focused: focusedField == key)
                        }
                    }
                    if (other[question.id]?.utf16.count ?? 0) > 4_000 || (notes[question.id]?.utf16.count ?? 0) > 4_000 {
                        Text("其他回答和补充说明各不能超过 4,000 个字符。").font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).error)
                    }
                }
                .onChange(of: other[question.id]) { _, value in
                    if question.multiSelect != true, value?.isEmpty == false { answers[question.id] = [] }
                }
            }
        case "confirm": EmptyView()
        default: Text("此交互需要在电脑端完成。").font(.orbisLabel()).foregroundStyle(OrbisPalette(scheme).secondary)
        }
    }

    private func textBinding(_ values: Binding<[String: String]>, _ key: String) -> Binding<String> {
        Binding(get: { values.wrappedValue[key] ?? "" }, set: { values.wrappedValue[key] = $0 })
    }
    private func optionButton(_ option: RuntimeOption, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .orbisIconBaseline(OrbisTextSize.body)
                    .scaleEffect(selected ? 1 : 0.92).animation(.orbisPop, value: selected)
                VStack(alignment: .leading, spacing: 4) {
                    Text(option.label).font(.orbisBody(.medium))
                    if let description = option.description { Text(description).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(12).frame(minHeight: 48)
        }.buttonStyle(NeuButtonStyle(selected: selected, radius: 14)).disabled(pending)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
    private func submit() {
        if store.respond(request, response: draftValue.response(for: request)) { OrbisHaptics.commit() }
    }
}
