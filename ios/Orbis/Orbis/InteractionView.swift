import SwiftUI

struct InteractionWorkspaceView: View, Equatable {
    let model: ChatScreenModel
    let actions: ChatSessionActions
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    let runtimeId: String
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model === rhs.model && lhs.actions == rhs.actions && lhs.runtimeId == rhs.runtimeId
    }
    @State private var selectedId: String?
    @State private var open = false
    @StateObject private var drafts = InteractionDraftCache(preferences: ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--preview-screen=") }) ? nil : .standard)
    var body: some View {
        // ADR-0049 §6.5：正在回答的请求立即收起（草稿保留在缓存里），其他请求直接切到下一项。
        #if DEBUG
        let _ = ChatUpdateProbe.shared.rendered(.workspace)
        #endif
        let facts = model.workspace
        let requests = facts.requests.filter { !facts.responding.contains($0.requestId) }
        let status = facts.interactionText.map { (text: $0, pending: facts.interactionPending) }
        let actionable = requests.filter(\.validForModel)
        let inline = requests.count == 1 && (requests[0].kind == "confirm" || actionable.isEmpty)
        // Sits inside ChatBottomOverlayRegion over the transcript so neither an empty slot nor an
        // arriving request moves the composer, while coordinating height with JumpToLatest and F3.
        Group {
            if inline, let request = requests.first {
                requestView(request, inSheet: false).padding(.horizontal, 16).padding(.bottom, 10).fixedSize(horizontal: false, vertical: true)
            } else if !requests.isEmpty {
                OrbisMotionButton { open = true } label: {
                    HStack(spacing: 10) {
                        OrbisActionSymbol(systemName: "exclamationmark.bubble")
                        Text(requests.count == 1 ? requests[0].title : L10n.tr("{0} 项交互待确认", requests.count)).font(.orbisLabel(.semibold)).lineLimit(2)
                        Spacer()
                        Text(L10n.tr("打开")).font(.orbisCaption())
                        OrbisActionSymbol(systemName: "chevron.up").font(.orbisCaption())
                    }.padding(14).frame(minHeight: 48)
                }.buttonStyle(NeuButtonStyle(radius: 16)).padding(.horizontal, 16).padding(.bottom, 10).accessibilityIdentifier("interaction-open")
            } else if let status {
                // 原面板位置的覆盖式短状态（V06）：不插入消息行、不推动正文；确认前带轻量处理中标记（V16）。
                HStack(spacing: 8) {
                    if status.pending { ProgressView().controlSize(.small) }
                    Text(status.text).font(.orbisLabel()).lineLimit(2)
                    Spacer(minLength: 0)
                }.padding(.horizontal, 14).frame(minHeight: 44)
                    .neuSurface(inset: true, radius: OrbisRadius.card, intensity: 0.6, padding: 0)
                    .padding(.horizontal, 16).padding(.bottom, 10)
                    .accessibilityElement(children: .combine).accessibilityIdentifier("interaction-status")
                    .transition(.opacity)
            }
        }
        .orbisBottomSheet(isPresented: $open) {
            let compactHeight = verticalSizeClass == .compact
            VStack(spacing: compactHeight ? 6 : 14) {
                OrbisPageHeader(title: L10n.tr("远程交互"), closes: true, back: { open = false }) { Text(L10n.tr("{0} 项", requests.count)).font(.orbisCaption()) }
                if requests.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(requests) { request in
                                OrbisMotionButton { selectedId = request.requestId } label: {
                                    Text(request.title).font(.orbisCaption()).lineLimit(1).padding(.horizontal, 14).frame(minHeight: compactHeight ? 36 : 44)
                                }.buttonStyle(NeuButtonStyle(selected: (selectedId ?? requests.first?.requestId) == request.requestId, radius: 12))
                            }
                        }.padding(compactHeight ? 4 : 6)
                    }.padding(.horizontal, 16)
                }
                if let request = requests.first(where: { $0.requestId == selectedId }) ?? requests.first {
                    requestView(request, inSheet: true)
                        .padding(.horizontal, 16).padding(.bottom, compactHeight ? 8 : 20)
                        .frame(maxHeight: .infinity, alignment: .top)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .foregroundStyle(OrbisPalette(scheme).text)
                .background(OrbisPalette(scheme).base.ignoresSafeArea())
                .presentationContentInteraction(.scrolls)
                .orbisSheet([.large])
        }
        .onAppear { if let first = actionable.first, !inline { selectedId = first.requestId; open = true } }
        .onChange(of: requests.map(\.requestId)) { old, next in
            if next.isEmpty { open = false; selectedId = nil }
            else if inline { open = false }
            else if let added = actionable.first(where: { !old.contains($0.requestId) }) {
                if !open { selectedId = added.requestId }
                open = true
            }
        }
        .onChange(of: model.workspace.identity) { _, _ in open = false }
    }

    @ViewBuilder private func requestView(_ request: InteractionRequest, inSheet: Bool) -> some View {
        if request.validForModel {
            let key = interactionDraftKey(host: model.workspace.host, sessionId: actions.sessionId, request: request)
            InteractionRequestView(actions: actions, connected: model.workspace.canSend, request: request,
                responseError: model.workspace.interactionErrors[request.requestId], draft: drafts.value(for: key, request: request),
                onDraftChange: { drafts.save($0, for: key, request: request) }, inSheet: inSheet)
                .id(key)
                .frame(maxHeight: inSheet ? .infinity : nil, alignment: .top)
        } else {
            let p = OrbisPalette(scheme)
            VStack(alignment: .leading, spacing: 6) {
                Text(request.title).font(.orbisBody(.semibold)).lineLimit(2)
                Text(L10n.tr("当前版本不支持此交互")).font(.orbisLabel()).foregroundStyle(p.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
                .neuSurface(inset: true, radius: OrbisRadius.card, intensity: 0.6, padding: OrbisRadius.cardPadding)
                .accessibilityIdentifier("interaction-unsupported")
        }
    }
}

private struct InteractionRequestView: View {
    let actions: ChatSessionActions
    let connected: Bool
    @Environment(\.colorScheme) private var scheme
    @Environment(\.orbisAppearance) private var visualStyle
    @Environment(\.orbisVisualActive) private var visualActive
    @Environment(\.openURL) private var openURL
    @Environment(\.orbisAccent) private var pageAccent
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    let request: InteractionRequest
    let responseError: String?
    let draft: InteractionDraftValue
    let onDraftChange: (InteractionDraftValue) -> Void
    let inSheet: Bool
    @State private var choices: Set<String> = []
    @State private var input = ""
    @State private var answers: [String: Set<String>] = [:]
    @State private var other: [String: String] = [:]
    @State private var notes: [String: String] = [:]
    @State private var questionPage = 0
    @State private var expanded = true
    @State private var linkError = false
    @State private var linkAttempt: UUID?
    private var draftValue: InteractionDraftValue {
        InteractionDraftValue(input: input, choices: choices, answers: answers, other: other, notes: notes, questionPage: questionPage)
    }
    private var questions: [InteractionRequest.Question] { request.questions ?? [] }
    private var currentQuestionIndex: Int { min(max(questionPage, 0), max(questions.count - 1, 0)) }
    private var currentQuestion: InteractionRequest.Question? { questions.indices.contains(currentQuestionIndex) ? questions[currentQuestionIndex] : nil }
    private var answeredQuestionCount: Int { questions.filter(questionHasAnswer).count }
    @FocusState private var focusedField: String?

    private var pending: Bool { request.submitted == true }
    private var valid: Bool { request.acceptsResponse(draftValue.response(for: request)) }
    private var compactSheet: Bool { inSheet && verticalSizeClass == .compact }

    var body: some View {
        TimelineView(OrbisPausablePeriodicSchedule(interval: 1, paused: !visualActive)) { context in
            let expired = Int64(context.date.timeIntervalSince1970 * 1000) >= request.expiresAt
            let p = OrbisPalette(scheme)
            let isExpanded = expanded || request.kind == "confirm"
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    OrbisMotionButton {
                        guard request.kind != "confirm" else { return }
                        if inSheet { withAnimation(.orbisCollapse) { expanded.toggle() } }
                        else { expanded.toggle() }
                    } label: {
                        HStack(spacing: 8) {
                            OrbisActionSymbol(systemName: "exclamationmark.bubble").foregroundStyle(pageAccent ?? p.accent)
                            Text(request.title).font(.orbisBody(.semibold)).lineLimit(2)
                            Spacer(minLength: 0)
                            // One fixed status slot: submitting swaps the label for a spinner without reflowing the title.
                            ZStack(alignment: .trailing) {
                                Text(expired ? L10n.tr("已过期") : L10n.tr("待确认")).font(.orbisCaption())
                                    .foregroundStyle(expired ? p.warning : pageAccent ?? p.accent).opacity(pending && !expired ? 0 : 1)
                                if pending && !expired { ProgressView().controlSize(.small) }
                            }.accessibilityLabel(expired ? L10n.tr("已过期") : pending ? L10n.tr("已提交，等待处理结果…") : L10n.tr("待确认"))
                            if request.kind != "confirm" {
                                OrbisActionSymbol(systemName: "chevron.down").imageScale(.small).foregroundStyle(p.secondary)
                                    .rotationEffect(.degrees(expanded ? 180 : 0)).animation(.orbisCollapse, value: expanded)
                                    .frame(width: 24)
                            }
                        }.frame(maxWidth: .infinity, minHeight: compactSheet ? 36 : 44).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                        .accessibilityHint(request.kind == "confirm" ? "" : expanded ? L10n.tr("收起交互") : L10n.tr("展开交互"))
                    if request.kind == "questionnaire" {
                        OrbisTextButton(title: request.cancelLabel ?? L10n.tr("取消回答")) { cancel() }
                            .disabled(pending || expired || !connected)
                            .accessibilityIdentifier("questionnaire-cancel")
                    }
                }
                if inSheet {
                    if isExpanded {
                        expandedContent(expired: expired)
                            .frame(maxHeight: .infinity, alignment: .top)
                            .transition(.opacity)
                    }
                } else {
                    OrbisCollapse(expanded: isExpanded) { expandedContent(expired: expired) }
                }
            }
            .frame(maxHeight: inSheet && isExpanded ? .infinity : nil, alignment: .top)
            .neuSurface(inset: true, radius: OrbisRadius.card, intensity: 0.6, padding: compactSheet ? 10 : OrbisRadius.cardPadding)
        }.frame(maxHeight: inSheet ? .infinity : nil, alignment: .top)
        .onAppear {
            input = draft.input; choices = draft.choices.intersection(Set((request.options ?? []).map(\.value)))
            answers = draft.answers; other = draft.other; notes = draft.notes
            questionPage = min(max(draft.questionPage ?? 0, 0), max(questions.count - 1, 0))
        }.onChange(of: questions.count) { _, count in
            questionPage = min(questionPage, max(count - 1, 0))
        }.onChange(of: draftValue) { _, value in onDraftChange(value) }
    }

    @ViewBuilder
    private func expandedContent(expired: Bool) -> some View {
        VStack(alignment: .leading, spacing: compactSheet ? 8 : 12) {
            if request.kind == "questionnaire", !compactSheet {
                questionnaireTabs
                questionnairePosition
            }
            ScrollView {
                VStack(alignment: .leading, spacing: compactSheet ? 8 : 14) {
                    if request.kind == "questionnaire", compactSheet {
                        HStack(spacing: 8) {
                            questionnaireTabs
                            Spacer(minLength: 0)
                            questionnairePosition
                        }
                    }
                    if let description = request.description { Text(description).font(.orbisLabel()) }
                    if let summary = request.argumentSummary { Text(summary).font(.orbisCaption(mono: true)).textSelection(.enabled) }
                    if let external = request.externalUrl, let url = URL(string: external), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                        OrbisTextButton(title: L10n.tr("在浏览器打开"), symbol: "safari") { openLink(url) }
                        if linkError {
                            Text(L10n.tr("无法打开链接，请重试")).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).error)
                        }
                    }
                    content
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: compactSheet ? 130 : 0, maxHeight: inSheet ? .infinity : 220)
            .layoutPriority(1)
            .scrollBounceBehavior(.basedOnSize)
            .id(request.kind == "questionnaire" ? "question-\(currentQuestion?.id ?? "")" : "interaction-content")
            .accessibilityIdentifier(request.kind == "questionnaire" ? "questionnaire-answer-scroll" : "interaction-content-scroll")
            if compactSheet && request.kind == "questionnaire" {
                if !expired && !pending {
                    if let responseError {
                        Text(responseError).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).error)
                            .accessibilityIdentifier("interaction-response-error")
                    }
                    if !connected {
                        Text(L10n.tr("连接后可提交")).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                    }
                }
                HStack(spacing: 12) {
                    if !expired { questionnaireProgress.fixedSize() }
                    actionButtons(expired: expired)
                }
            } else {
                if !expired {
                    if request.kind == "questionnaire" { questionnaireProgress }
                    if !pending {
                        if let responseError {
                            Text(responseError).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).error)
                                .accessibilityIdentifier("interaction-response-error")
                        }
                        if !connected {
                            Text(L10n.tr("连接后可提交")).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary)
                        }
                    }
                }
                actionButtons(expired: expired)
            }
        }
        .frame(maxHeight: inSheet ? .infinity : nil, alignment: .top)
        .padding(.top, compactSheet ? 4 : 8)
    }

    @ViewBuilder private var questionnaireTabs: some View {
        if questions.count > 1 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(questions.indices, id: \.self) { index in
                        let question = questions[index]
                        let header = question.header?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                            ? question.header! : L10n.tr("问题")
                        OrbisMotionButton {
                            focusedField = nil
                            withAnimation(.orbisCollapse) { questionPage = index }
                        } label: {
                            Text("\(index + 1). \(header)\(questionHasAnswer(question) ? " ✓" : "")")
                                .font(.orbisCaption()).lineLimit(1).padding(.horizontal, 14).frame(minHeight: compactSheet ? 36 : 44)
                        }
                        .buttonStyle(NeuButtonStyle(selected: currentQuestionIndex == index, radius: 12))
                        .accessibilityIdentifier("questionnaire-page-\(index)")
                    }
                }.padding(compactSheet ? 2 : 6)
            }
            .accessibilityIdentifier("questionnaire-pages")
        }
    }

    private var questionnairePosition: some View {
        let kind = currentQuestion?.options.isEmpty == true ? L10n.tr("填写回答") : currentQuestion?.multiSelect == true ? L10n.tr("可多选") : L10n.tr("单选")
        return Text(L10n.tr("第 {0} / {1} 题，{2}", currentQuestionIndex + 1, questions.count, kind))
            .font(.orbisCaption(.semibold)).foregroundStyle(OrbisPalette(scheme).secondary)
            .accessibilityIdentifier("questionnaire-position")
    }

    private var questionnaireProgress: some View {
        let title = pending ? L10n.tr("已提交，等待处理结果…") : answeredQuestionCount == questions.count
            ? L10n.tr("答案已填好，可继续修改或提交")
            : L10n.tr("已回答 {0} / {1} 题", answeredQuestionCount, questions.count)
        return Text(title).font(.orbisCaption()).lineLimit(1)
            .accessibilityIdentifier("questionnaire-progress")
    }

    @ViewBuilder
    private func actionButtons(expired: Bool) -> some View {
        if request.kind == "questionnaire" {
            HStack(spacing: 12) {
                if currentQuestionIndex > 0 {
                    OrbisActionButton(title: L10n.tr("上一题"), symbol: "chevron.left") { changeQuestionPage(by: -1) }
                        .accessibilityIdentifier("questionnaire-previous")
                }
                if currentQuestionIndex < questions.count - 1 {
                    OrbisActionButton(title: L10n.tr("下一题"), symbol: "chevron.right") { changeQuestionPage(by: 1) }
                        .accessibilityIdentifier("questionnaire-next")
                } else {
                    OrbisActionButton(title: pending ? L10n.tr("正在提交…") : L10n.tr("提交答案"), symbol: "checkmark") { submit() }
                        .disabled(!valid)
                        .accessibilityIdentifier("questionnaire-submit")
                }
            }
            .disabled(pending || expired || !connected)
        } else {
            HStack(spacing: 12) {
                OrbisActionButton(title: request.extensionId == "opencode.permission" ? L10n.tr("拒绝") : (request.cancelLabel ?? (request.kind == "confirm" ? L10n.tr("拒绝") : L10n.tr("取消")))) { cancel() }
                OrbisActionButton(title: request.extensionId == "opencode.permission" ? L10n.tr("允许一次") : (request.confirmLabel ?? (request.kind == "confirm" ? L10n.tr("允许") : L10n.tr("提交"))), symbol: "checkmark") { submit() }
                    .disabled(!valid)
            }.disabled(pending || expired || !connected)
        }
    }

    private func openLink(_ url: URL) {
        let attempt = UUID()
        linkAttempt = attempt
        linkError = false
        openURL(url) { accepted in
            guard linkAttempt == attempt else { return }
            linkError = !accepted
        }
    }

    private func cancel() {
        guard actions.isCurrent else { return }
        let response: [String: Any] = request.kind == "confirm"
            ? ["kind": "confirm", "value": false] : ["kind": "cancel"]
        let accepted = actions.respond(request, response: response)
        if accepted && request.kind == "confirm" { OrbisHaptics.commit() }
    }

    private func changeQuestionPage(by offset: Int) {
        focusedField = nil
        withAnimation(.orbisCollapse) {
            questionPage = min(max(currentQuestionIndex + offset, 0), max(questions.count - 1, 0))
        }
    }

    private func questionHasAnswer(_ question: InteractionRequest.Question) -> Bool {
        let allowedValues = Set(question.options.map(\.value))
        let selectedValues = (answers[question.id] ?? []).intersection(allowedValues)
        return !selectedValues.isEmpty ||
            (question.allowOther == true && !(other[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
                SecureField(request.placeholder ?? L10n.tr("输入内容"), text: $input).font(.orbisBody())
                    .focused($focusedField, equals: "input").orbisInput(focused: focusedField == "input").accessibilityIdentifier("interaction-input")
            } else {
                TextField(request.placeholder ?? L10n.tr("输入内容"), text: $input, axis: .vertical).font(.orbisBody()).lineLimit(2...6)
                    .focused($focusedField, equals: "input").orbisInput(focused: focusedField == "input").accessibilityIdentifier("interaction-input")
            }
        case "questionnaire":
            if let question = currentQuestion {
                VStack(alignment: .leading, spacing: 12) {
                    Text(question.question).font(.orbisBody(.medium))
                        .accessibilityIdentifier("questionnaire-current-question")
                    ForEach(question.options) { option in
                        optionButton(option, selected: answers[question.id]?.contains(option.value) == true) {
                            if question.multiSelect == true {
                                var values = answers[question.id] ?? []
                                if !values.insert(option.value).inserted { values.remove(option.value) }
                                answers[question.id] = values
                            } else { answers[question.id] = [option.value]; other[question.id] = nil }
                        }
                        .accessibilityIdentifier("questionnaire-option-\(question.id)-\(option.value)")
                    }
                    if question.allowOther == true {
                        let key = "other-" + question.id
                        if question.secret == true {
                            SecureField(L10n.tr("其他回答"), text: textBinding($other, question.id)).font(.orbisBody())
                                .focused($focusedField, equals: key).orbisInput(focused: focusedField == key)
                        } else {
                            TextField(L10n.tr("其他回答"), text: textBinding($other, question.id), axis: .vertical).font(.orbisBody()).lineLimit(2...6)
                                .focused($focusedField, equals: key).orbisInput(focused: focusedField == key)
                        }
                    }
                    if question.allowNotes == true {
                        let key = "notes-" + question.id
                        if question.secret == true {
                            SecureField(L10n.tr("补充说明（可选）"), text: textBinding($notes, question.id)).font(.orbisBody())
                                .focused($focusedField, equals: key).orbisInput(focused: focusedField == key)
                        } else {
                            TextField(L10n.tr("补充说明（可选）"), text: textBinding($notes, question.id), axis: .vertical).font(.orbisBody()).lineLimit(2...6)
                                .focused($focusedField, equals: key).orbisInput(focused: focusedField == key)
                        }
                    }
                    if (other[question.id]?.utf16.count ?? 0) > 4_000 || (notes[question.id]?.utf16.count ?? 0) > 4_000 {
                        Text(L10n.tr("其他回答和补充说明各不能超过 4,000 个字符。")).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).error)
                    }
                }
                .onChange(of: other[question.id]) { _, value in
                    if question.multiSelect != true, value?.isEmpty == false { answers[question.id] = [] }
                }
            }
        case "confirm": EmptyView()
        default: EmptyView()
        }
    }

    private func textBinding(_ values: Binding<[String: String]>, _ key: String) -> Binding<String> {
        Binding(get: { values.wrappedValue[key] ?? "" }, set: { values.wrappedValue[key] = $0 })
    }
    private func optionButton(_ option: RuntimeOption, selected: Bool, action: @escaping () -> Void) -> some View {
        OrbisMotionButton(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                OrbisActionSymbol(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .orbisIconBaseline(OrbisTextSize.body)
                    .scaleEffect(selected ? 1 : 0.92).animation(.orbisPop, value: selected)
                VStack(alignment: .leading, spacing: 4) {
                    Text(request.extensionId == "claude-code" && request.kind == "select" ? L10n.hostText(option.label) : option.label)
                        .font(.orbisBody(.medium))
                    if let description = option.description { Text(description).font(.orbisCaption()).foregroundStyle(OrbisPalette(scheme).secondary) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(12).frame(minHeight: 48)
        }.buttonStyle(NeuButtonStyle(selected: selected, radius: 14)).disabled(pending)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
    private func submit() {
        guard actions.isCurrent else { return }
        if actions.respond(request, response: draftValue.response(for: request)) { OrbisHaptics.commit() }
    }
}
