# Documentation Guide

This directory is organized by authority and maintenance horizon. The root `README.md` remains the product and usage overview; `CONTEXT.md` is the domain vocabulary.

## Current references

- `docs/adr/`: accepted architecture decisions. ADRs preserve historical reasoning; a superseded ADR is marked in its header.
- `docs/deployment.md`: production Relay deployment and release checks.
- `docs/mail-server.md`: QQ verification mail configuration.
- `docs/deepseek-harness.md`: DeepSeek Harness installation, configuration and supported behavior.
- `docs/codex-permissions.md`: current Codex session permission and approval behavior.
- `android/docs/agent-icons.md`: bundled agent icon sources and notices.
- `android/docs/neumorphism-audit.md`: Android surface-material implementation audit.
- `android/docs/markdown-smoke.md`: manual Markdown rendering fixture.

## Reference snapshots

These documents describe a specific tool version or a past implementation review. They are useful background, but they are not the current contract by themselves:

- `docs/codex-app-server-protocol.md`: codex-cli 0.154.0 app-server schema snapshot.
- `docs/codex-vs-pi-feature-gap.md`: 2026-09-23 Pi/Codex capability comparison.
- `docs/pi-remote-ui-design-spec.md`: historical UI design tokens and material guidance. The source design file and exported images are intentionally not part of the repository.

When a snapshot conflicts with source code, an accepted ADR, or the current product README, use the current source and update the snapshot's status or date instead of treating it as authoritative.

## Agent documentation

- `docs/agents/domain.md`: required domain-context entry point.
- `docs/agents/issue-tracker.md`: issue-writing rules and privacy boundary.
- `docs/agents/triage-labels.md`: tracker label mapping.
