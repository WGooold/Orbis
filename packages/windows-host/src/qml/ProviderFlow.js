// Shared by the QML editor and its behavioral tests. No Host/native writes.
/* eslint-disable @typescript-eslint/no-unused-vars -- QML imports these functions as a namespace. */
function newModel(kind, id, name) {
    var model = {id: id || "", name: name || id || "", input: ["text"], contextWindow: kind === "dsh" ? 262144 : 128000, maxTokens: kind === "dsh" ? 32768 : 8192}
    if (kind === "dsh") model.reasoningEfforts = false
    else model.reasoning = false
    return model
}

function applyDiscoveredModels(kind, current, selected, defaultModel, index) {
    if (!selected.length) return {models: current, defaultModel: defaultModel}
    var models = current.slice()
    if (index >= 0) {
        if (index >= models.length) return {error: "模型行已变化，请重新选择。"}
        var id = selected[0].id
        if (models.some(function(row, position) { return position !== index && row.id === id })) return {error: "该模型已在目录中，请选择其他模型。"}
        var previous = models[index]
        // Changing an ID keeps capabilities and explicit names from that row.
        models[index] = Object.assign({}, previous, {id: id, name: !previous.name || previous.name === previous.id ? selected[0].name || id : previous.name})
        return {models: models, defaultModel: !defaultModel || defaultModel === previous.id ? id : defaultModel}
    }
    models = models.filter(function(row) { return typeof row.id === "string" && row.id.trim().length > 0 })
    selected.forEach(function(row) {
        if (!row.id || models.some(function(existing) { return existing.id === row.id })) return
        models.push(newModel(kind, row.id, row.name))
    })
    return {models: models, defaultModel: defaultModel || selected[0].id}
}

function matchesProvider(provider, query) {
    var normalized = query.trim().toLowerCase()
    return !normalized || [provider.name, provider.id, provider.notes, provider.websiteUrl].join(" ").toLowerCase().indexOf(normalized) >= 0
}

function reorderedIds(providers, source, target) {
    var ids = providers.map(function(provider) { return provider.id })
    var from = ids.indexOf(source), to = ids.indexOf(target)
    if (from < 0 || to < 0 || from === to) return null
    ids.splice(to, 0, ids.splice(from, 1)[0])
    return ids
}
