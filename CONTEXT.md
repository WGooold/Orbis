# Orbis

Orbis lets a paired mobile device observe and operate the coding agents a resident computer-side Host manages — today Pi, Codex and DeepSeek Harness — without becoming a terminal emulator, remote desktop, or process manager.

## Runtime and routing

**Mobile client**:
A native phone UI that acts as the remote frontend for the agent sessions a Host serves.
_Avoid_: Terminal emulator, remote desktop

**Host**:
The resident computer-side process that owns the pairing identity, device records, encrypted channels, transport paths, file serving, and the aggregated session directory. It does not interpret any agent's business semantics.
_Avoid_: Relay proxy, desktop gateway

**Agent backend**:
One computer-side agent integration behind the Host, addressed by an `agentKind`; it discovers, activates, drives, and reports the sessions of exactly one agent product.
_Avoid_: Generic agent abstraction

**Agent kind**:
The `pi` | `codex` | `dsh` discriminator that labels a session and selects a backend. It never selects a display-projection rule. DSH connects to the authenticated local Web service and reads canonical events through its native RPC; see ADR-0020.
_Avoid_: Backend branch in UI logic

**Pi runtime**:
One already-running Pi process attached to the Host over the loopback endpoint. It owns its Session, agent, loaded resources, and command semantics.
_Avoid_: Desktop gateway, managed process

**Runtime ID**:
A connection-level identifier for exactly one runtime connection and the routing key for requests to it. A Host is one such connection.
_Avoid_: Session ID

**Runtime role**:
The `agent` | `host` discriminator a runtime declares when it authenticates. The Relay accepts `host` only, so it never holds an agent connection.
_Avoid_: Runtime kind

**Session ID**:
Diagnostic identity owned by an agent backend for a Session; it is not a remote routing key.

**Relay**:
The authenticated forwarding boundary between paired devices and exactly one Host. It reads only the routing header, carries an opaque ciphertext, and owns no agent or Session semantics.
_Avoid_: Backend runtime, session server

**Relay operator console**:
The server-hosted administrative UI for Relay health, Host registration visibility, Relay-side Host disablement, device credential revocation, and audit events. It uses a short-lived browser session derived from the administrator token and never exposes decrypted Session content or replaces Host-side pairing management. See ADR-0015.
_Avoid_: Host management server, conversation dashboard

**Device**:
A paired phone installation identified by a unique, revocable pairing record held by the Host.

**Runtime event**:
An ordered state update emitted for one runtime connection toward its paired devices.

**Runtime command**:
An authenticated request addressed to one runtime, such as a chat message, Slash invocation, stop request, interaction response, download, upload, or session activation.
_Avoid_: Runtime action

## Transport and pairing

**Host registration**:
A QQ mailbox ownership verification that issues a Relay credential bound to exactly one Host ID. It enables the Windows Host to connect and request pairing codes for its own devices; it is separate from Session activation and from phone pairing. SMTP credentials and Relay administrator tokens remain server-side. See ADR-0014.
The operator may make QQ verification optional for new activations; the Host-bound credential and routing restrictions remain. See ADR-0016.


**Path**:
One replaceable transport that carries envelopes between the Host and a device: `lan`, `p2p`, or `relay`. The loopback endpoint is not a Path — it connects the computer's own agent processes to the Host.
_Avoid_: Connection, channel, loopback

**Active path**:
The single Path a device's outbound traffic currently uses. The Host chooses it and announces it with `device.path`; the device follows rather than deciding.
_Avoid_: Primary connection

**Secure session**:
The end-to-end encrypted channel between a Host and one device, derived from that device's pairing record. Its lifetime is independent of any Path connection.
_Avoid_: Encrypted connection, TLS session

**Envelope**:
The single encrypted message shape carried over every Path; it pairs a plaintext routing header with an opaque ciphertext.
_Avoid_: Packet, message

**Routing header**:
The only part of an Envelope the Relay can read: frame kind, opaque room, sender, recipient, and sequence.
_Avoid_: Message header, metadata

**Pairing window**:
A short-lived, single-use interval during which the Host accepts one new device. It is opened explicitly on the computer and renders a QR code; there is no standing "listening for pairing" state.
_Avoid_: Pairing mode

**Pairing QR**:
The payload that carries the Host public key, a one-time pairing secret, the Relay URL and code, and the optional LAN endpoints. The Host public key arriving through the screen-to-camera channel is the root of trust; a QR without cryptographic material is rejected rather than reinterpreted.
_Avoid_: Pairing code, connection string

**Loopback endpoint**:
The Host's local, in-machine endpoint that speaks the same runtime messages as the Relay path, so a computer-side agent process only swaps URL and credential.
_Avoid_: Local Relay, IPC channel

**Loopback discovery file**:
The `~/.pi-remote/loopback.json` descriptor — URL, token, host id, pid — that an agent process reads to find the local Host. Its token guards against stale files and duplicate Hosts, not against other local processes.
_Avoid_: Port file, lock file

## Conversation, commands, and activation

**Chat snapshot**:
A bounded range of canonical Session Entries returned by `session.sync` for preview, older history, or forward catch-up. Its replace/append/prepend mode describes range and display behavior, not permission to overwrite canonical Entries.
_Avoid_: Full history

**Canonical Session Entry**:
A stable node identified by Session ID and Entry ID within one paired Host's cache namespace. Its parent relation and content do not change between preview, history, and catch-up responses; conflicting versions are rejected rather than selected by arrival order.

**Session Tree Cache**:
The persistent collection of canonical Session Entries. All three synchronization ranges use one transactional ingestion path; branches are queries along parent relationships, not separate copies of shared ancestors. See ADR-0013.

**Continuous coverage**:
The ancestor chain the persistent cache has verified as complete. Cached nodes beyond a missing parent are useful partial data but do not advance this fact until the gap is filled and committed.
_Avoid_: Last received Entry, display leaf

**Runtime operational control**:
Control exercised over conversation, queue, Session, context, model, commands, interactions, file transfer, and session activation, without authority to run arbitrary commands or to manage processes the Host did not start.
_Avoid_: Machine control

**Session activation**:
The Host starting an agent CLI for one session — either continuing a session that already exists, or creating a new one in a directory the device picked. The Host constructs argv and environment.
_Avoid_: Process control, remote exec

**Activation level**:
The deliberately bounded scope of Session activation. L1 continues a session that already exists and takes only a `sessionId`; L2 creates a new session in a device-chosen directory. L3 — accepting a phone-supplied command line — is permanently excluded.
_Avoid_: Permission tier

**Spawn mode**:
The `auto` | `tui` | `headless` choice for how an activated session starts. `auto` prefers a visible terminal window and degrades to headless where no desktop session exists; the Host reports what it actually did instead of what was asked.
_Avoid_: Attach mode

**Directory browse**:
A read-only listing of computer directories and regular files. The shared mobile browser selects a directory for a new session or a file for a path-addressed download. It has no root restriction and no allowlist.

**Steer delivery**:
A working-state message delivery mode that places a user message ahead of follow-up work at an agent-loop boundary; it does not promise interruption of work already executing.
_Avoid_: Immediate interrupt, context append

**Follow-up delivery**:
A working-state message delivery mode that defers a user message until the current agent work can finish and then starts subsequent work.
_Avoid_: Immediate queue, context append

**Queue operation ID**:
The stable remote identity for one requested steer or follow-up delivery, used to correlate terminal queue states and retries; it is not the agent's own message-entry ID.
_Avoid_: Message ID

**Runtime queue state**:
The delivery fact reported by the computer side for a remote queue operation; the mobile client displays it but does not infer or execute it. The Host may maintain a shadow projection because Pi does not expose the queue contents through its extension API.
_Avoid_: Mobile queue state, optimistic delivery, independent execution queue

**Slash command menu**:
The runtime-owned catalog of remotely invocable built-ins, Skills, Prompt Templates, extension commands, and MCP tools currently available to the mobile client. Each backend publishes only the subset it can honor.
_Avoid_: Runtime action menu, Android command allowlist

**Slash invocation**:
A structured request for one command selected from the current Slash command menu, including its selected or entered arguments.
_Avoid_: Free-form command text

**Capability envelope**:
The models, credentials, trust decisions, tools, extensions, working directory, and operating-system permissions an agent runtime already holds.
_Avoid_: Feature flags

## Files and machine boundary

**Path-addressed file download**:
A read-only transfer of a regular file the Host can open, identified by a computer path supplied by the paired device.
_Avoid_: Runtime download

**Range request**:
A device-issued request for one chunk of a download at an explicit byte offset. The next request's offset is the progress report, so a range request carries no separate acknowledgement.
_Avoid_: ACK, chunk acknowledgement

**Durable prefix**:
The longest contiguous prefix of a download already written to the device's `.part` file. It is the only authoritative progress fact and the resume point.
_Avoid_: Received offset, download progress

**Receive window**:
The bytes a device permits to be requested but not yet durably written. It bounds in-flight download data and supplies disk/backpressure.
_Avoid_: Sender window, transfer window

**Pull scheduler**:
The device-side component that owns a download's progress, receive window, retransmission, and reorder buffering.
_Avoid_: Mobile queue, transfer manager

**Range responder**:
The near-stateless Host-side component that serves a device's requested byte ranges; it keeps no window, acknowledgement, or retry state.
_Avoid_: Streaming sender, download pump

**Upload task**:
A device-to-Host transfer of a file the phone picked, addressed by a directory plus a single file name.
_Avoid_: File push (removed in ADR-0008: computer-to-device push no longer exists), attachment

**Upload credit**:
The durable prefix the Host reports for an upload. It is the only authoritative progress fact for an upload and the resume point; the phone is the sender, so it cannot be the authority.
_Avoid_: Progress ACK, upload acknowledgement

**Attachment path**:
An absolute computer path carried on a message so the agent can read the file itself. Not a descriptor, and not a content part.
_Avoid_: File attachment, image attachment, upload descriptor

**Direct machine control**:
Remote authority that bypasses the agent to run arbitrary commands or to manage processes, packages, credentials, trust, files, or arbitrary network destinations.
_Avoid_: Admin access

## Extension interaction

**Portable extension interaction**:
A declarative interaction whose business logic remains in a computer-side extension while SDK-defined state can be rendered locally or on the mobile client.
_Avoid_: Remote UI

**Structured interaction**:
An SDK-owned confirm, select, multi-select, or input request that local and remote UI may race to answer exactly once.
_Avoid_: Dialog

**Local interaction**:
A native extension UI prompt that does not use the Remote Interaction SDK and therefore cannot be answered by the mobile client.
_Avoid_: Unsupported interaction
