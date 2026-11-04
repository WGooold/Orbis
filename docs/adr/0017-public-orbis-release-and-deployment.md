# ADR-0017: Public Orbis repository and service origin

LAN / Relay routing follows [ADR-0050](0050-fixed-lan-relay-routing.md).

Date: 2026-09-23

Orbis original source is published under MIT in `WGooold/Orbis`. A fresh public history excludes operational records, credentials, runtime/device data and local experiments. Third-party components retain their own terms. Future issues, documentation and releases use this repository.

The official website and console use `orbising.com`; the compatible Relay base is `wss://orbising.com/relay`. Existing package names, on-disk identities and Android application ID stay compatible.

Server application deployment remains GitHub Actions-only with Windows validation, `git archive HEAD`, the production environment, pinned SSH host keys and commit verification. Server initialization and private state migration are separate operator operations. The previous hostname can proxy to the new server for clients that still store it; only one Relay state copy is writable after cutover.

2026-11-04 validation correction: retain the full Windows gate and macOS Host
checks, and require a Linux review integration job before Relay deployment.
Review process cleanup and portal tests run on all three systems with a pinned
Node 22.23.2 and retained JUnit results. Fixtures must use platform-correct owned
process-tree termination, verify exit, attempt all cleanup steps and surface
failures without contaminating the next test. Details are in `docs/deployment.md`.
