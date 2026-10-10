# Relay load tests

This directory contains a standalone load generator for the Orbis Relay. It is intentionally outside `packages/relay/src`: it uses the public WebSocket protocol but is never part of the Relay runtime.

## Safety

The runner refuses `orbising.com` unless `ORBIS_LOAD_ALLOW_PRODUCTION=1` is set. Do not set that variable for normal work. Use a dedicated Relay with test credentials and a disposable state directory.

The runner does not create credentials. Configure the Relay with the credentials used by the test:

- `runtimeCredential` must be present in `PI_REMOTE_RUNTIME_CREDENTIAL`.
- Every generated device credential is `load-device-load-host-N-device-M` and must be present in the Relay device store, or supplied through a test-only provisioning fixture.

The load frames contain an opaque JSON string in `envelope.ct`. They are valid Relay-routable v2 frames, but they are not application E2E ciphertext. This is deliberate: the first layer measures Relay routing, queues, parsing and WebSocket behavior. It must not be used to claim that Host/Android crypto or business semantics were tested.

## Run

Start a dedicated Relay configured for the test credentials, then run:

```bash
npm run load:smoke
npm run load:capacity
npm run load:soak
```

Override the scenario or duration:

```bash
node scripts/load/run.mjs --config scripts/load/configs/smoke.json --scenario reconnect --duration 60
```

Write a JSON summary:

```bash
set ORBIS_LOAD_REPORT=reports/smoke.json
npm run load:smoke
```

On PowerShell:

```powershell
$env:ORBIS_LOAD_REPORT = "scripts/load/reports/smoke.json"
npm run load:smoke
```

Summarize reports:

```bash
npm run load:report -- scripts/load/reports/smoke.json
```

## Scenarios

- `control`: sends control frames at `messageRatePerDevice`.
- `mixed`: sends control and bulk frames, exercising mux priority and queueing.
- `backpressure`: uses the same mixed traffic model and marks the first `slowDevices` devices as slow readers.
- `reconnect`: randomly closes clients during the run to exercise close handling.

The current runner is intentionally a first Relay-layer harness. It records counters and control-frame latency, but OS-level RSS, event-loop delay, Nginx metrics and exact network throughput must be collected by the test environment. Keep those measurements alongside the JSON summary.

## Test order

1. Run `load:smoke` against one dedicated Relay.
2. Verify `protocolErrors` is zero and `framesReceived` is plausible.
3. Run control-only capacity steps before mixed traffic.
4. Run `backpressure` separately and graph Relay RSS, `bufferedAmount` and `relay.bulk.*` logs.
5. Run `reconnect` only after normal traffic is stable.
6. Run the soak configuration on a clean host and retain the commit, config, logs and report together.

Never run capacity or soak configurations from a developer laptop against the production Relay.
