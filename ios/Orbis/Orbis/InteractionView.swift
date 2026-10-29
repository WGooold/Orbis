import SwiftUI

struct InteractionWorkspaceView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    let runtimeId: String
    @State private var selectedId: String?
    var body: some View {
        let requests = store.interactions[runtimeId] ?? []
        Color.clear.frame(height: 48)
            .overlay(alignment: .bottom) {
                if !requests.isEmpty {
                    VStack(spacing: 10) {
                        if requests.count > 1 {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 10) {
                                    ForEach(requests) { request in
                                        Button { selectedId = request.requestId } label: {
                                            Text(request.title).font(.orbisCaption()).lineLimit(1).padding(.horizontal, 14).frame(minHeight: 40)
                                        }.buttonStyle(NeuButtonStyle(selected: (selectedId ?? requests.first?.requestId) == request.requestId, radius: 12))
                                    }
                                }.padding(6)
                            }
                        }
                        if let request = requests.first(where: { $0.requestId == selectedId }) ?? requests.first {
                            InteractionRequestView(request: request).id(request.requestId)
                        }
                    }.padding(.horizontal, 16).padding(.top, 10)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }.allowsHitTesting(!requests.isEmpty)
    }
}

private struct InteractionRequestView: View {
    @EnvironmentObject private var store: OrbisStore
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL
    let request: InteractionRequest
    @State private var choices: Set<String> = []
    @State private var input = ""
    @State private var answers: [String: Set<String>] = [:]
    @State private var other: [String: String] = [:]
    @State private var notes: [String: String] = [:]
    @State private var expanded = false
    @FocusState private var focusedField: String?

    private var pending: Bool { store.submittingInteractions.contains(request.requestId) || request.submitted == true }
    private var valid: Bool {
        switch request.kind {
        case "select": return choices.count == 1
        case "multi-select": return choices.count >= (request.minSelections ?? 0) && choices.count <= (request.maxSelections ?? Int.max)
        case "input": return input.count >= (request.minLength ?? 0) && input.count <= (request.maxLength ?? 100_000)
        case "questionnaire":
            return (request.questions ?? []).allSatisfy { !(answers[$0.id] ?? []).isEmpty || ($0.allowOther == true && !(other[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
        default: return true
        }
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let expired = Int64(context.date.timeIntervalSince1970 * 1000) >= request.expiresAt
            let p = OrbisPalette(scheme)
            VStack(alignment: .leading, spacing: 0) {
                Button { if request.kind != "confirm" { expanded.toggle() } } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.bubble").foregroundStyle(p.accent)
                        Text(request.title).font(.orbisBody(.semibold)).lineLimit(2)
                        Spacer(minLength: 0)
                        // One fixed status slot: submitting swaps the label for a spinner without reflowing the title.
                        ZStack(alignment: .trailing) {
                            Text(expired ? "已过期" : "待确认").font(.orbisCaption()).foregroundStyle(p.accent).opacity(pending ? 0 : 1)
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
                        }.frame(maxHeight: 220).scrollBounceBehavior(.basedOnSize)
                        HStack(spacing: 12) {
                            OrbisActionButton(title: request.cancelLabel ?? (request.kind == "confirm" ? "拒绝" : "取消")) {
                                _ = store.respond(request, response: request.kind == "confirm" ? ["kind": "confirm", "value": false] : ["kind": "cancel"])
                            }
                            OrbisActionButton(title: request.confirmLabel ?? (request.kind == "confirm" ? "允许" : "提交"), symbol: "checkmark") { submit() }.disabled(!valid)
                        }.disabled(pending || expired || store.connection != .secured)
                    }.padding(.top, 8)
                }
            }.neuSurface(inset: true, radius: OrbisRadius.card, intensity: 0.6, padding: OrbisRadius.cardPadding)
        }.onAppear { input = request.initialValue ?? "" }
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
                    .focused($focusedField, equals: "input").orbisInput(focused: focusedField == "input")
            } else {
                TextField(request.placeholder ?? "输入内容", text: $input, axis: .vertical).font(.orbisBody()).lineLimit(2...6)
                    .focused($focusedField, equals: "input").orbisInput(focused: focusedField == "input")
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
                            } else { answers[question.id] = [option.value] }
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
                        TextField("补充说明（可选）", text: textBinding($notes, question.id), axis: .vertical).font(.orbisBody())
                            .focused($focusedField, equals: key).orbisInput(focused: focusedField == key)
                    }
                }
            }
        default: EmptyView()
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
        var response: [String: Any] = ["kind": request.kind]
        switch request.kind {
        case "confirm": response["value"] = true
        case "select": response["value"] = choices.first ?? ""
        case "multi-select": response["values"] = (request.options ?? []).map(\.value).filter { choices.contains($0) }
        case "input": response["value"] = input
        case "questionnaire":
            response["answers"] = (request.questions ?? []).map { question -> [String: Any] in
                var answer: [String: Any] = ["id": question.id, "values": question.options.map(\.value).filter { answers[question.id]?.contains($0) == true }]
                if question.allowOther == true, let value = other[question.id], !value.isEmpty { answer["other"] = value }
                if question.allowNotes == true, let value = notes[question.id], !value.isEmpty { answer["notes"] = value }
                return answer
            }
        default: return
        }
        _ = store.respond(request, response: response)
    }
}
