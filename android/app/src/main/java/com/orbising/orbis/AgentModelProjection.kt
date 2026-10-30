package com.orbising.orbis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive

/** 只解释共同领域 schema；原生消息、日志和 runtimeId 前缀不参与业务事实。 */
internal fun RemoteState.applyAgentDomainProjection(
    runtimeId: String?,
    sessionId: String?,
    domains: Map<String, AgentStateDomainView>,
    json: Json,
    parseInteraction: (Json, JsonObject, PendingInteraction?) -> PendingInteraction?,
): RemoteState {
    val id = runtimeId ?: return this
    val existing = runtimes[id] ?: return this
    if (sessionId == null || existing.sessionId != sessionId) return this
    var runtime = existing
    var conversation = conversations[id] ?: RuntimeConversation()
    var commands = capabilities[id]
    var pending = pendingCommands
    try {
        for ((name, domain) in domains) {
            runtime = runtime.copy(domainAvailability = runtime.domainAvailability + (name to domain.availability))
            // unknown/unavailable 保留最后已知值；availability 本身仍已登记在镜像内。
            if (domain.availability != "ready") {
                if (name == "execution") runtime = runtime.copy(status = "unknown")
                continue
            }
            val value = domain.value?.takeUnless { it is JsonNull }
            when (name) {
                "identity" -> if (value != null) {
                    val identity = value as? JsonObject ?: error("identity 不是对象")
                    require(identity.text("hostId") == null || identity.text("hostId") == hostId)
                    val incoming = json.decodeFromJsonElement<RuntimeSummary>(identity)
                    require(incoming.runtimeId == id && incoming.sessionId == sessionId)
                    runtime = runtime.copy(name = incoming.name, cwd = incoming.cwd, hostname = incoming.hostname,
                        sessionName = incoming.sessionName, agentKind = incoming.agentKind)
                }
                "execution" -> {
                    val phase = (value as? JsonObject)?.text("phase") ?: error("execution 缺少 phase")
                    require(phase in setOf("idle", "running", "waiting_local_interaction"))
                    runtime = runtime.copy(status = phase)
                    conversation = conversation.copy(waitingLocalInteraction = phase == "waiting_local_interaction")
                }
                "model" -> runtime = if (value == null && domain.completeness == "complete") {
                    runtime.copy(model = null, thinkingLevel = null)
                } else if (value != null) {
                    val model = value as? JsonObject ?: error("model 不是对象")
                    runtime.copy(model = json.decodeFromJsonElement<RuntimeModelInfo>(model), thinkingLevel = model.text("thinkingLevel"))
                } else runtime
                "context" -> if (value != null || domain.completeness == "complete") {
                    runtime = runtime.copy(contextUsage = value?.let { json.decodeFromJsonElement<RuntimeContextUsage>(it) })
                }
                "permissions" -> if (value != null || domain.completeness == "complete") {
                    val management = (value as? JsonObject)?.get("management")?.takeUnless { it is JsonNull }
                    runtime = runtime.copy(permissions = null,
                        permissionManagement = management?.let { json.decodeFromJsonElement<RuntimePermissionManagement>(it) })
                }
                "capabilities" -> {
                    val rows = collection(value, domain) ?: continue
                    val incoming = rows.values.map { json.decodeFromJsonElement<RuntimeSlashCommand>(it) }
                    require(incoming.map { it.name }.distinct().size == incoming.size)
                    val all = if (domain.projectionComplete || domain.completeness == "complete") incoming
                        else commands?.commands.orEmpty().associateBy { it.name }.plus(incoming.associateBy { it.name }).values.toList()
                    commands = RuntimeCapabilities(all)
                }
                "interactions" -> {
                    val rows = collection(value, domain) ?: continue
                    val incoming = rows.map { (key, element) ->
                        val request = element as? JsonObject ?: error("交互不是对象")
                        val interaction = parseInteraction(json, request, conversation.interactions[key]) ?: error("交互缺少可回答字段")
                        require(interaction.requestId == key)
                        // 回答提交是本设备本地状态，不接受共享模型覆盖它。
                        val previous = conversation.interactions[key]
                        key to interaction.copy(submitted = previous?.submitted == true || interaction.submitted,
                            responseCommandId = previous?.responseCommandId, responseError = previous?.responseError)
                    }.toMap()
                    val next = if (domain.projectionComplete || domain.completeness == "complete") incoming else conversation.interactions + incoming
                    val removed = conversation.interactions.keys - next.keys
                    pending = pending - removed.mapNotNull { conversation.interactions[it]?.responseCommandId }.toSet()
                    conversation = conversation.copy(interactions = next,
                        interactionNotices = conversation.interactionNotices - removed - incoming.keys)
                }
                "delivery" -> {
                    val rows = collection(value, domain) ?: continue
                    val incoming = rows.map { (key, element) ->
                        val row = element as? JsonObject ?: error("队列项不是对象")
                        val queueId = row.text("queueId") ?: error("队列项缺少身份")
                        val delivery = row.text("delivery") ?: error("队列项缺少投递方式")
                        val state = row.text("state") ?: error("队列项缺少状态")
                        require(key == queueId && delivery in setOf("steer", "followUp") && state in setOf("accepted", "delivered", "cancelled", "rejected", "not_cancelable"))
                        key to QueuedMessage(key, row.text("text") ?: error("队列项缺少正文"), delivery, state, row.text("error"))
                    }.toMap()
                    val inventory = if (domain.projectionComplete || domain.completeness == "complete") incoming else conversation.queuedMessages + incoming
                    conversation = conversation.copy(queuedMessages = inventory.filterValues { it.state != "delivered" },
                        deliveredQueueIds = conversation.deliveredQueueIds + inventory.filterValues { it.state == "delivered" }.keys)
                }
            }
        }
    } catch (failure: Exception) {
        return copy(error = "Host 模型领域格式无效：${failure.message ?: "未知字段"}")
    }
    val identity = if (domains["identity"]?.availability == "ready") runtime.catalogEntry() else null
    val catalog = if (identity == null) sessions else sessions +
        (identity.sessionId to mergeSessionCatalogEntry(sessions[identity.sessionId], identity))
    return copy(runtimes = runtimes + (id to runtime), sessions = catalog, conversations = conversations + (id to conversation),
        capabilities = commands?.let { capabilities + (id to it) } ?: capabilities, pendingCommands = pending)
}

private fun collection(value: JsonElement?, domain: AgentStateDomainView): JsonObject? = when {
    value is JsonObject -> value
    value == null && (domain.projectionComplete || domain.completeness == "complete") -> JsonObject(emptyMap())
    value == null -> null
    else -> error("集合领域不是对象")
}

internal fun RemoteState.applyHostDomainProjection(domains: Map<String, AgentStateDomainView>, json: Json): RemoteState {
    var state = this
    domains["catalog"]?.takeIf { it.availability == "ready" }?.value?.let { element ->
        val value = element as? JsonObject ?: return@let
        val entries = value["sessions"]?.let { runCatching { json.decodeFromJsonElement<List<SessionCatalogEntry>>(it) }.getOrNull() }
            ?: return@let
        // 不完整目录只增加已知条目；失败后端的缺席不能删除缓存或归档状态。
        val listed = entries.map { it.sessionId }.toSet()
        val rangeComplete = value.text("nextCursor") == null && value["truncated"]?.jsonPrimitive?.booleanOrNull != true
        val completeKinds = if (!rangeComplete) emptySet() else (value["backends"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
            .filter { it["complete"]?.jsonPrimitive?.booleanOrNull == true }.mapNotNull { it.text("kind") }.toSet()
        val online = state.runtimes.values.mapNotNull { it.sessionId }.toSet()
        val merged = state.sessions.filterValues { entry -> entry.sessionId in listed || entry.hasHistoryCache ||
            entry.sessionId in online || entry.agentKind !in completeKinds }.toMutableMap()
        for (entry in entries) {
            val previous = merged[entry.sessionId]
            merged[entry.sessionId] = entry.copy(
                hasHistoryCache = previous?.hasHistoryCache == true || entry.hasHistoryCache,
                cachedDisplayName = previous?.cachedDisplayName,
            )
        }
        state = state.copy(sessions = merged)
    }
    domains["backends"]?.takeIf { it.availability == "ready" }?.value?.let { element ->
        val value = element as? JsonObject ?: return@let
        fun kinds(key: String) = (value[key] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }?.toSet()
        state = state.copy(supportedAgents = kinds("agents") ?: state.supportedAgents,
            launchableAgents = kinds("launchableAgents") ?: state.launchableAgents,
            codexDesktop = value["codexDesktop"]?.takeUnless { it is JsonNull }?.let {
                runCatching { json.decodeFromJsonElement<CodexDesktopAttach>(it) }.getOrNull()
            })
    }
    domains["providers"]?.takeIf { it.availability == "ready" }?.value?.let { element ->
        val rows = ((element as? JsonObject)?.get("providers") as? JsonArray) ?: return@let
        val current = mutableMapOf<String, String>()
        var providerState = state.agentProviders
        for (row in rows.filterIsInstance<JsonObject>()) {
            val kind = row.text("agentKind") ?: continue
            // current 是 Host 供应商 profile id；会话归属只与原生 modelProvider 比较。
            row.text("modelProvider")?.takeIf(String::isNotBlank)?.let { current[kind] = it }
            if (kind != providerState.kind) continue
            val profiles = row["profiles"] as? JsonArray ?: continue
            val providers = profiles.filterIsInstance<JsonObject>().mapNotNull { profile ->
                val id = profile.text("id") ?: return@mapNotNull null
                AgentProvider(id, kind, profile.text("name") ?: id, profile["enabled"]?.jsonPrimitive?.booleanOrNull == true,
                    profile.text("mode") == "additive", profile["globalDefault"]?.jsonPrimitive?.booleanOrNull == true)
            }
            providerState = providerState.copy(providers = providers,
                loading = providerState.requestId != null, error = null)
        }
        state = state.copy(currentProviders = current, agentProviders = providerState)
    }
    return state
}

private fun JsonObject.text(key: String): String? = (get(key) as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull
