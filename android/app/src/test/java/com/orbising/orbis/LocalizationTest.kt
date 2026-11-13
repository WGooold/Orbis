package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

class LocalizationTest {
    @Test fun resolvesPreferredLanguagesAndUnsupportedFallback() {
        listOf("zh", "zh-CN", "zh-TW", "zh-Hant-HK", "ZH_hans_CN").forEach {
            assertEquals(AppLanguage.Chinese, AppLanguage.System.resolved(listOf(it)))
        }
        assertEquals(AppLanguage.English, AppLanguage.System.resolved(listOf("en-GB", "zh-CN")))
        assertEquals(AppLanguage.Chinese, AppLanguage.System.resolved(listOf("fr-FR", "zh-TW", "en-US")))
        assertEquals(AppLanguage.English, AppLanguage.System.resolved(listOf("ar", "ja")))
        assertEquals(AppLanguage.English, AppLanguage.System.resolved(emptyList()))
    }

    @Test fun explicitChoiceOverridesDeviceAndInvalidChoiceFollowsSystem() {
        assertEquals(AppLanguage.Chinese, AppLanguage.Chinese.resolved(listOf("en")))
        assertEquals(AppLanguage.English, AppLanguage.English.resolved(listOf("zh")))
        assertEquals(AppLanguage.System, AppLanguage.preference(null))
        assertEquals(AppLanguage.System, AppLanguage.preference("unsupported"))
    }

    @Test fun interpolationPreservesOpaqueTextAndDoesNotReparseArguments() {
        val literal = "设置 {1} \$HOME /中文/code.swift 100% \\n"
        assertEquals("Latest question, $literal", L10n.format("最近提问，{0}", listOf(literal), AppLanguage.English))
        assertEquals("$literal 不是合法的 base64url", L10n.format("{0} 不是合法的 base64url", listOf(literal), AppLanguage.Chinese))
        assertEquals("source message / code", L10n.format("source message / code", language = AppLanguage.English))
    }

    @Test fun formattingSupportsReorderingAndMalformedPlaceholdersSafely() {
        assertEquals("{1} / 100%", L10n.format("{0} / {1}", listOf("{1}", "100%"), AppLanguage.English))
        assertEquals("{9} {99999999999999999999999}", L10n.format("{9} {99999999999999999999999}", listOf("a"), AppLanguage.English))
        assertEquals("Question 1 / 3, Your text", L10n.format("第 {0} / {1} 题，{2}", listOf("1", "3", "Your text"), AppLanguage.English))
    }

    @Test fun principalSurfacesHaveEnglishCopy() {
        mapOf("设置" to "Settings", "语言" to "Language", "跟随系统" to "Follow system",
            "发送消息" to "Send message", "历史与分支" to "History and branches",
            "连接你的电脑" to "Connect your computer", "下载" to "Downloads").forEach { (key, expected) ->
            assertEquals(expected, L10n.format(key, language = AppLanguage.English))
            assertEquals(key, L10n.format(key, language = AppLanguage.Chinese))
        }
    }

    @Test fun storedFailureChecksSurviveALanguageChange() {
        val key = "已读取内容达到 2 MiB 缓存上限，可清空已读内容后继续"
        assertTrue(L10n.matches(key, key))
        assertTrue(L10n.matches(L10n.format(key, language = AppLanguage.English), key))
        assertFalse(L10n.matches(null, key))
        assertFalse(L10n.matches("User text mentioning a cache", key))
        assertTrue(L10n.hasPrefix("Invalid Host model domain: identity", "Host 模型领域格式无效："))
    }

    @Test fun englishCountsUseSingularAndPlural() {
        assertEquals("1 file changed", L10n.format("{0} 个文件已更改", listOf("1"), AppLanguage.English))
        assertEquals("0 files changed", L10n.format("{0} 个文件已更改", listOf("0"), AppLanguage.English))
        assertEquals("2 files changed", L10n.format("{0} 个文件已更改", listOf("2"), AppLanguage.English))
        assertEquals("1 个文件已更改", L10n.format("{0} 个文件已更改", listOf("1"), AppLanguage.Chinese))
    }

    @Test fun hostUiCopyPreservesUnknownTextAndOpaqueValues() {
        // SC85: permission recovery is not presented as an active conversation.
        assertEquals("Permissions are unconfirmed. Try again shortly.", L10n.hostText("权限设置尚未确认，请稍后重试", AppLanguage.English))
        assertEquals("Permission settings are being saved. Try again shortly.", L10n.hostText("权限设置正在保存，请稍后重试", AppLanguage.English))
        assertEquals("Workspace write, Ask when needed", L10n.hostSummary("工作区可写 · 按需询问", AppLanguage.English))
        assertEquals("选择此 Codex 会话的模型", L10n.hostText("Select the model for this Codex session", AppLanguage.Chinese))
        val path = "/工作区可写/设置 {1}/file.swift 100% 🧪"
        assertEquals("Native readable directories: $path.", L10n.hostText("原生报告的可读目录：$path。", AppLanguage.English))
        assertEquals("切换模型（当前 $path）", L10n.hostText("Switch model (current: $path)", AppLanguage.Chinese))
        assertEquals("Network: access allowed.\nVendor-only detail", L10n.hostText("网络：允许联网。\nVendor-only detail", AppLanguage.English))
        assertEquals("设置", L10n.hostText("设置", AppLanguage.English))
        assertEquals("Vendor custom 工作区可写 label", L10n.hostText("Vendor custom 工作区可写 label", AppLanguage.English))
    }
}
