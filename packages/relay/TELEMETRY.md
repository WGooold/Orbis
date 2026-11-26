# Relay telemetry

Relay telemetry is implemented in this package and is visible in the Relay administrator console. Device-level reporting is disabled unless a paired device explicitly opts in from **Orbis App → Settings → Privacy → Device usage sharing**. New installations and upgrades default to off.

## Collected data

- **Service aggregates:** successful homepage requests; successful Relay-served download category and byte totals; registration starts; pairing-code generation; new Host registration cohorts; and once-per-minute CPU, RSS/heap memory, active Host/device counts, and event-loop delay measurements.
- **Opted-in device details:** Relay device ID, message byte counts by direction, message-active seconds, connection session count/duration, and derived per-second bandwidth summaries. Device identifiers are used to associate these detailed rows with the paired-device record in the administrator console.

The telemetry worker does not receive message payloads, credentials, IP addresses, cookies, email addresses, user-agent values, full URLs, URL query parameters, or complete download filenames. Download categories are derived from the filename extension/platform marker before recording; the filename itself is not stored. Host registration cohort identity is stored as a one-way SHA-256 hash.

Service aggregates are not controlled by the per-device switch. The setting controls only device-level traffic/session/bandwidth records. Turning it off immediately stops further device-level collection, removes that device's identifiable telemetry and bandwidth history, and retains only period-level aggregate totals. The Relay administrator can still see operational device/connection state in the ordinary device-management view.

## Retention and storage

- Detailed per-device bandwidth rows: 30 UTC days.
- Usage aggregates: hourly 90 days, daily 400 days, weekly/fortnightly 3 years, monthly 5 years.
- Relay telemetry SQLite: `${STATE_FILE}.telemetry.sqlite`; bandwidth detail: `${STATE_FILE}.bandwidth.json` (or `ORBIS_BANDWIDTH_STATE_FILE`).
- SQLite uses WAL, secure delete, and restrictive file permissions where supported. Disabling consent removes per-device rows and checkpoints the WAL. Period aggregates are not attributed to a device after detail removal.
- On first startup after consent support is introduced, legacy device-level histories collected before opt-in are discarded. Aggregate service metrics remain.

A self-hosted Relay operator controls its own service aggregate database and deployment. The app switch is a per-device control, not a global Relay telemetry kill switch.
