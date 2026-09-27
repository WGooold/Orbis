// Shared by the QML editor and its behavioral tests. No Host/native writes.
/* eslint-disable @typescript-eslint/no-unused-vars -- QML imports these functions as a namespace. */
function mergeDiscoveredModels(kind, current, selected, defaultModel) {
    var key = kind === "codex" ? "model" : "id"
    var models = current.filter(function(row) { return typeof row[key] === "string" && row[key].trim().length > 0 }).slice()
    selected.forEach(function(row) {
        if (!row.id || models.some(function(existing) { return existing[key] === row.id })) return
        models.push(kind === "codex" ? {model: row.id, displayName: row.name || row.id} : {id: row.id, name: row.name || row.id, input: ["text"]})
    })
    return {models: models, defaultModel: defaultModel || (selected.length ? selected[0].id : "")}
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
