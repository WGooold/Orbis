# ADR-0017: Public Orbis repository and service origin

LAN / Relay routing follows [ADR-0050](0050-fixed-lan-relay-routing.md).

Date: 2026-09-23

Orbis original source is published under MIT in `WGooold/Orbis`. A fresh public history excludes operational records, credentials, runtime/device data and local experiments. Third-party components retain their own terms. Future issues, documentation and releases use this repository.

The official website and console use `orbising.com`; the compatible Relay base is `wss://orbising.com/relay`. Existing package names, on-disk identities and Android application ID stay compatible.

Server application deployment remains GitHub Actions-only with Windows validation, `git archive HEAD`, the production environment, pinned SSH host keys and commit verification. Server initialization and private state migration are separate operator operations. The previous hostname can proxy to the new server for clients that still store it; only one Relay state copy is writable after cutover.
