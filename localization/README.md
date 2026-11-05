# Mobile app text

`mobile.json` is the shared Chinese → English catalog for application-owned text on iOS and Android. Positional arguments remain opaque values. `mobile-plurals.json` supplies the English singular form when the first argument is one.

`mobile-host.json` lists Host-owned permission UI and built-in command descriptions. `L10n.hostText` matches exact strings or complete, anchored templates with one opaque argument; `hostSummary` handles the summary separator. Known wording renders in either supported language, and unknown backend text stays original.

Use `L10n.tr("设置")` or `L10n.tr("还有 {0} 个文件", count)` at the presentation point. Compute labels on access and include language in presentation-cache dependencies. Keep business state and identity independent of language.

After editing the catalogs, run `python3 scripts/generate-mobile-localizations.py`. Run with `--check` to verify generated sources, duplicate keys, positional / printf parameters, plural keys and literal lookup coverage. The generated Swift and Kotlin catalogs are committed so native builds need no extra build-time dependency.

Preference values are `system`, `zh-Hans` and `en`. The default is `system`; the first supported phone language wins, with English as fallback. All Chinese variants use Simplified Chinese. Settings, system-change notifications and foreground entry update observable presentation state without replacing the page or its connection. System-owned permission prompts use their native localized resources and follow the OS language.

Language behavior: [ADR-0063](../docs/adr/0063-mobile-app-language.md); test rules: [AGENTS.md](../AGENTS.md#测试).
