# Orbis

Orbis lets a paired mobile device observe and operate the coding agents a resident computer-side Host manages — today Pi, Codex and DeepSeek Harness.

## Runtime and routing

**Mobile client**:
A native phone UI that acts as the remote frontend for the agent sessions a Host serves.

**Host**:
The resident computer-side process that owns the pairing identity, device records, encrypted channels, transport paths, file serving, and the aggregated session directory. ADR-0032 additionally makes it the owner of the unified Agent state model and the client-facing projections of shared Host services; that architecture decision is accepted, and the model now carries real facts for the Host-side domains (the per-module migration state lives in `packages/protocol/src/agent-state.test.ts`). Agent backends interpret native business semantics; the common Host model manager validates and publishes their standardized facts.

**Agent backend**:
One computer-side agent integration behind the Host, addressed by an `agentKind`; it discovers, activates, drives, and reports the sessions of one agent product and integration path. It owns native interpretation, verified recovery, and the standardized facts supplied to the Host Agent state model (ADR-0032).

**Agent kind**:
The `pi` | `codex` | `codexDesktop` | `dsh` | `dshDesktop` discriminator that labels a Session and selects its backend. Codex terminal and desktop are separate integration paths for the same agent product. DSH uses its authenticated local Web service and native event RPC; see ADR-0020. `dshDesktop` attaches to the backend owned by DeepSeek Harness Desktop and is sent only to devices that declare it; see ADR-0076.

**Agent state model**:
The Host-managed logical state for one agent Session, keyed by Host, agent kind and Session identity. It covers history and head, live messages and tools, execution, delivery, interactions, permissions, model and context, capabilities and resources, notifications, and references to providers, workspace, artifacts and diagnostic records. Native execution and history remain source authority; the Host owns the standardized client-facing projection. See ADR-0032 for the accepted architecture and the implementation status of each domain.

**Device view**:
A Host-owned, device-scoped projection of shared Agent facts, notification dismissals, private command receipts and operations. See ADR-0032.

**Tool summary**:
A bounded, deterministic execution projection keyed by Host, agent kind, Session and tool-call identity. It contains verified phase/status, ordering and references to available arguments, execution output and final result. Raw tool content is removed before common Host state, Registry and Pi loopback publication; native execution/history keep their own complete content. See ADR-0045.

**Tool inventory**:
The current Session's executing and finished-but-uncommitted tool summaries, versioned by an independent epoch/revision. Checkpoints reference its exact source dependency; fixed pages and continuous patches establish the applied baseline. Committed tools move atomically into historical summary Entries. See ADR-0045 §5/§9.

**Tool content read**:
A device-private, bounded UTF-8 range read of arguments, execution output or final result. A leased identity fixes the tool part, content epoch and range. Missing ranges and expired versions have explicit outcomes, and cancellation ends the read. See ADR-0045 §4/§6/§7.

**Client-local state**:
Device-owned pairing and selection, cache and applied baselines, logical read operations, outbox, local transfer files and scheduling, drafts, aliases, viewport and preferences. These remain local while remote domain facts come from the Host model. See ADR-0032.

**Pi runtime**:
One already-running Pi process attached to the Host over the loopback endpoint. It owns its Session, agent, loaded resources, and command semantics.

**Runtime ID**:
A connection-level identifier for exactly one runtime connection and the routing key for requests to it. A Host is one such connection.

**Runtime role**:
The `agent` | `host` discriminator declared at authentication. Relay connections use the `host` role.

**Session ID**:
An agent-backend-owned diagnostic identity for a Session.

**Relay**:
The authenticated forwarding boundary between paired devices and one Host. It routes opaque ciphertext using the routing header.

**Relay operator console**:
The server-hosted administrative UI for Relay health, Host registration, Relay-side disablement, device credential revocation and audit events. A short-lived browser session derives from the administrator token. See ADR-0015.

**Device**:
A paired phone installation identified by a unique, revocable pairing record held by the Host.

**Paired Host**:
One computer a phone installation holds a pairing record for. A phone may hold several at once; `hostId` is the identity that dedupes them, and re-pairing a computer replaces its record instead of adding another.

**Current Host**:
The paired Host addressed by the phone's interactive screens. Other paired Hosts retain their independent connections.

**Runtime event**:
An ordered state update emitted for one runtime connection toward its paired devices.

**Runtime notification**:
A condition or operation outcome standardized by its Agent backend or Pi RuntimeBridge. The source owns native meaning and recovery; the Host owns identity, outcome expiration, device-local dismissal and an independently versioned projection. See ADR-0028.

**Runtime command**:
An authenticated request addressed to one runtime, such as a chat message, Slash invocation, stop request, interaction response, download, upload, or session activation.

## Transport and pairing

**Host registration**:
A QQ mailbox ownership verification that issues a Relay credential bound to exactly one Host ID. It enables the Windows Host to connect and request pairing codes for its own devices; it is separate from Session activation and from phone pairing. SMTP credentials and Relay administrator tokens remain server-side. See ADR-0014.
The operator may make QQ verification optional for new activations; the Host-bound credential and routing restrictions remain. See ADR-0014.


**Path**:
A replaceable `lan` or `relay` transport between the Host and a device. The Host prefers authenticated LAN and falls back to Relay (ADR-0050). Local agent processes connect through the loopback endpoint.

**Active path**:
The Path selected by the Host and announced to the device through `device.path`.

**Secure session**:
The end-to-end encrypted channel between a Host and one device, derived from that device's pairing record. Its lifetime is independent of any Path connection.

**Envelope**:
The single encrypted message shape carried over every Path; it pairs a plaintext routing header with an opaque ciphertext.

**Routing header**:
The only part of an Envelope the Relay can read: frame kind, opaque room, sender, recipient, and sequence.

**Pairing window**:
An explicitly opened, short-lived, single-use interval in which the Host accepts a new device through a displayed QR code.

**Pairing QR**:
The Host public key, one-time pairing secret, Relay URL and code, and optional LAN endpoints. The screen-to-camera delivery of cryptographic material establishes the root of trust.

**Loopback endpoint**:
The Host's local, in-machine endpoint that speaks the same runtime messages as the Relay path, so a computer-side agent process only swaps URL and credential.

**Loopback discovery file**:
The `~/.orbis/loopback.json` descriptor containing URL, token, Host ID and PID. Local agents use it to locate the current Host; the token identifies stale files and duplicate Hosts.

## Conversation, commands, and activation

**Chat snapshot**:
A bounded response returned by `session.sync` for current-state reconciliation, older history, or forward catch-up. The source selects an unchanged acknowledgement, live checkpoint, missing Entry suffix, or recovery tail from the client's applied baseline; see ADR-0026. Its replace/append/prepend mode describes range and display behavior; authority and source versions determine cache updates.

**Canonical Session Entry**:
A native-history node identified by Session ID and Entry ID within one paired Host's cache namespace. Verified source versions govern cached parent relations and content. See ADR-0025 for the Codex versioned path.

**Session Tree Cache**:
The persistent canonical Entry collection. Synchronization ranges share one transactional ingestion path; branches are queries along parent relationships. See ADR-0013.

**Continuous coverage**:
The ancestor chain verified complete by the persistent cache. Coverage advances when missing parents are filled and committed.

**Applied Session state**:
The source epoch, sequence and head of the complete current state committed by the mobile client, including its referenced Entries. It supports conditional synchronization and remains distinct from historical coverage. See ADR-0026.

**Session sync transaction**:
A device-requested Session read or reconciliation goal with immutable parameters, identified by `commandId` and correlated through `syncId`. The Host coordinates its resources and outcome; device acknowledgement completes `committed`, while failure or lease expiry completes `aborted`. See ADR-0013 and ADR-0037.

**Session sync attempt**:
One dispatch of a Session sync transaction. Attempts may fail or be abandoned without changing the transaction's identity; only the transaction owner's lease can end the transaction. See ADR-0037.

**Session sync lease**:
The Host-owned progress deadline for a Session sync transaction. Observed progress renews the lease; expiry aborts the transaction and releases its reserved resources. See ADR-0037 §2/§7.

**Sent versus applied**:
`sent` records completion of the Host's transport write. `applied` records the device's cache commit and applied-baseline advance; its acknowledgement commits the transaction. See ADR-0026 and ADR-0037 §4.

**Session read operation**:
A mobile-client operation with a defined goal for reading a Session range or reconciling its current state. Its lifecycle spans the work needed for that goal; it is distinct from a network attempt, source version, or visible loading indicator. See ADR-0029.

**Runtime operational control**:
Agent-mediated control over conversation, queue, Session, context, model, commands, interactions, file transfer and Session activation.

**Session activation**:
The Host starting an agent CLI for one session — either continuing a session that already exists, or creating a new one in a directory the device picked. The Host constructs argv and environment.

**Activation level**:
L1 continues a Session by `sessionId`; L2 creates one in a device-selected directory. The Host constructs startup arguments and environment for supported backends.

**Spawn mode**:
The `auto` | `tui` | `headless` choice for how an activated session starts. `tui` is the default and requires a visible terminal window (Terminal on macOS; on Windows a console window opened through the system default terminal, never `wt.exe` directly); inability to open it is an activation error. Only `auto` may choose headless when no desktop session or supported terminal entry exists. The Host reports the mode it actually started.

**Directory browse**:
A read-only listing of computer directories and regular files. The shared mobile browser selects a directory for a new session or a file for a path-addressed download. It has no root restriction and no allowlist.

**Steer delivery**:
A working-state delivery mode that schedules a user message ahead of follow-up work at an agent-loop boundary.

**Follow-up delivery**:
A working-state message delivery mode that defers a user message until the current agent work can finish and then starts subsequent work.

**Queue operation ID**:
The stable remote identity for a steer or follow-up delivery, used to correlate terminal queue states and retries.

**Pending send**:
A client-local optimistic message record awaiting source confirmation. A matching source identity (`messageId`, `clientMessageId` or Host alias) reconciles and removes the record. See ADR-0049.

**Runtime queue state**:
The computer-side delivery fact for a remote queue operation, projected by the mobile client. The Host maintains a shadow projection where Pi's extension API omits queue contents.

**Slash command menu**:
The runtime-owned catalog of remotely invocable built-ins, Skills, Prompt Templates, extension commands, and MCP tools currently available to the mobile client. Each backend publishes only the subset it can honor.

**Slash invocation**:
A structured request for one command selected from the current Slash command menu, including its selected or entered arguments.

**Permission management**:
A Host projection of a Session's effective permission summary and backend-supported opaque settings. The backend owns semantics, validation and confirmation; clients render and submit typed updates. Single-operation approval uses a separate structured interaction. See ADR-0031.

**Capability envelope**:
The models, credentials, trust decisions, tools, extensions, working directory, and operating-system permissions an agent runtime already holds.

## Files and machine boundary

**Path-addressed file download**:
A read-only transfer of a regular file the Host can open, identified by a computer path supplied by the paired device.

**Range request**:
A device-issued request for one chunk of a download at an explicit byte offset. The next request's offset is the progress report, so a range request carries no separate acknowledgement.

**Durable prefix**:
The longest contiguous prefix of a download already written to the device's `.part` file. It is the only authoritative progress fact and the resume point.

**Receive window**:
The bytes a device permits to be requested but not yet durably written. It bounds in-flight download data and supplies disk/backpressure.

**Pull scheduler**:
The device-side component that owns a download's progress, receive window, retransmission, and reorder buffering.

**Range responder**:
The near-stateless Host-side component that serves a device's requested byte ranges; it keeps no window, acknowledgement, or retry state.

**Upload task**:
A device-to-Host transfer of a file the phone picked, addressed by a directory plus a single file name.

**Upload credit**:
The durable prefix the Host reports for an upload. It is the only authoritative progress fact for an upload and the resume point; the phone is the sender, so it cannot be the authority.

**Attachment path**:
An absolute computer path attached to a message for the agent to read.

**Image content reference**:
The unified Agent model's image descriptor: MIME type, byte length, optional dimensions, and a computer path or artifact reference. Clients display a placeholder and fetch the image through the download path. See ADR-0034.

**Direct machine control**:
Remote authority that bypasses the agent to run arbitrary commands or to manage processes, packages, credentials, trust, files, or arbitrary network destinations.

## Extension interaction

**Portable extension interaction**:
A declarative interaction whose business logic remains in a computer-side extension while SDK-defined state can be rendered locally or on the mobile client.

**Structured interaction**:
An SDK-owned confirm, select, multi-select, or input request that local and remote UI may race to answer exactly once.

**Local interaction**:
A native extension UI prompt that does not use the Remote Interaction SDK and therefore cannot be answered by the mobile client.
