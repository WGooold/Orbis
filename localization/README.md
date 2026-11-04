# Mobile app text

`mobile.json` is the shared Chinese → English catalog for iOS and Android. `{0}`, `{1}`, etc. are positional values, never translated or parsed again. `mobile-plurals.json` supplies the English singular form when the first argument is one. Keep user content, file paths, protocol values and Agent output outside this API.

`mobile-host.json` is a finite allowlist for Host-owned permission UI and built-in command descriptions. `L10n.hostText` recognizes only those exact strings or complete, anchored templates with one opaque argument; `hostSummary` handles the Host's summary separator. Known English wording can also render in Chinese. Unknown backend text stays original. Never call these helpers on transcripts, custom commands, model names or paths, and never derive permissions or control identities from translated text.

Use `L10n.tr("设置")` or `L10n.tr("还有 {0} 个文件", count)` at the presentation point. Compute translated labels on access; do not store them in enum constructors, global constants, identity keys or state-machine conditions. Any cached UI projection that contains translated labels must include the language in its presentation cache dependencies. Keep navigation, drafts and message identity independent of language.

After editing the catalogs, run `python3 scripts/generate-mobile-localizations.py`. Run with `--check` to verify generated sources, duplicate keys, positional / printf parameters, plural keys and literal lookup coverage. The generated Swift and Kotlin catalogs are committed so native builds need no extra build-time dependency.

Preference values are `system`, `zh-Hans` and `en`. The default is `system`; the first supported phone language wins, with English as fallback. All Chinese variants use Simplified Chinese. Settings, system-change notifications and foreground entry update observable presentation state without replacing the page or its connection. System-owned permission prompts use their native localized resources and follow the OS language.

Rules and device regression requirements: [ADR-0063](../docs/adr/0063-mobile-app-language.md), R62 in [UI regression](../docs/testing/ui-regression.md).
