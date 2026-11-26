import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type { UsageGranularity } from "./telemetry.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const RETENTION: Record<UsageGranularity, number> = {
  hour: 90 * DAY,
  day: 400 * DAY,
  week: 3 * 365 * DAY,
  fortnight: 3 * 365 * DAY,
  month: 5 * 366 * DAY,
};
const COHORT_RETENTION = 400 * DAY;
const stateFile = String(workerData.stateFile);
mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(stateFile);
try { chmodSync(stateFile, 0o600); } catch { /* Existing platform / filesystem may not expose POSIX modes. */ }
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS telemetry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS device_telemetry_consent (device_id TEXT PRIMARY KEY, enabled_at INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY,
    first_active_at INTEGER,
    last_active_at INTEGER,
    first_paired_at INTEGER,
    retention_offsets TEXT NOT NULL DEFAULT '[]'
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS host_profiles (host_hash TEXT PRIMARY KEY, first_registered_at INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS period_totals (
    granularity TEXT NOT NULL,
    bucket_start INTEGER NOT NULL,
    active_users INTEGER NOT NULL DEFAULT 0,
    new_users INTEGER NOT NULL DEFAULT 0,
    returning_users INTEGER NOT NULL DEFAULT 0,
    paired_devices INTEGER NOT NULL DEFAULT 0,
    new_host_registrations INTEGER NOT NULL DEFAULT 0,
    registration_starts INTEGER NOT NULL DEFAULT 0,
    pairing_codes INTEGER NOT NULL DEFAULT 0,
    sessions INTEGER NOT NULL DEFAULT 0,
    connected_ms INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0,
    upload_bytes INTEGER NOT NULL DEFAULT 0,
    download_bytes INTEGER NOT NULL DEFAULT 0,
    active_message_seconds INTEGER NOT NULL DEFAULT 0,
    upload_rate_histogram TEXT NOT NULL DEFAULT '{}',
    download_rate_histogram TEXT NOT NULL DEFAULT '{}',
    combined_rate_histogram TEXT NOT NULL DEFAULT '{}',
    upload_peak_bytes INTEGER NOT NULL DEFAULT 0,
    download_peak_bytes INTEGER NOT NULL DEFAULT 0,
    combined_peak_bytes INTEGER NOT NULL DEFAULT 0,
    website_page_views INTEGER NOT NULL DEFAULT 0,
    download_requests INTEGER NOT NULL DEFAULT 0,
    download_bytes_served INTEGER NOT NULL DEFAULT 0,
    downloads_windows INTEGER NOT NULL DEFAULT 0,
    downloads_macos INTEGER NOT NULL DEFAULT 0,
    downloads_android INTEGER NOT NULL DEFAULT 0,
    downloads_ios INTEGER NOT NULL DEFAULT 0,
    downloads_other INTEGER NOT NULL DEFAULT 0,
    resource_samples INTEGER NOT NULL DEFAULT 0,
    cpu_percent_sum REAL NOT NULL DEFAULT 0,
    cpu_percent_peak REAL NOT NULL DEFAULT 0,
    rss_bytes_sum INTEGER NOT NULL DEFAULT 0,
    rss_bytes_peak INTEGER NOT NULL DEFAULT 0,
    heap_used_bytes_sum INTEGER NOT NULL DEFAULT 0,
    heap_used_bytes_peak INTEGER NOT NULL DEFAULT 0,
    connected_devices_peak INTEGER NOT NULL DEFAULT 0,
    connected_hosts_peak INTEGER NOT NULL DEFAULT 0,
    event_loop_p95_ms_peak REAL NOT NULL DEFAULT 0,
    event_loop_max_ms_peak REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (granularity, bucket_start)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS user_periods (
    granularity TEXT NOT NULL,
    bucket_start INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    new_user INTEGER NOT NULL DEFAULT 0,
    returning_user INTEGER NOT NULL DEFAULT 0,
    paired_devices INTEGER NOT NULL DEFAULT 0,
    sessions INTEGER NOT NULL DEFAULT 0,
    connected_ms INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0,
    upload_bytes INTEGER NOT NULL DEFAULT 0,
    download_bytes INTEGER NOT NULL DEFAULT 0,
    active_message_seconds INTEGER NOT NULL DEFAULT 0,
    upload_rate_histogram TEXT NOT NULL DEFAULT '{}',
    download_rate_histogram TEXT NOT NULL DEFAULT '{}',
    combined_rate_histogram TEXT NOT NULL DEFAULT '{}',
    upload_peak_bytes INTEGER NOT NULL DEFAULT 0,
    download_peak_bytes INTEGER NOT NULL DEFAULT 0,
    combined_peak_bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (granularity, bucket_start, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS user_periods_user_time ON user_periods(user_id, granularity, bucket_start);
  CREATE TABLE IF NOT EXISTS daily_cohorts (
    cohort_date TEXT PRIMARY KEY,
    cohort_users INTEGER NOT NULL DEFAULT 0,
    day1_retained INTEGER NOT NULL DEFAULT 0,
    day7_retained INTEGER NOT NULL DEFAULT 0,
    day30_retained INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  INSERT OR IGNORE INTO telemetry_meta(key, value) VALUES ('coverage_started_at', CAST(strftime('%s','now') AS TEXT));
`);

// Before consent controls existed, device-level histories were collected by default.
// Keep service-level aggregates, but discard those identifiable histories exactly once.
if (!db.prepare("SELECT 1 FROM telemetry_meta WHERE key='device_consent_migration_v1'").get()) {
  db.exec(`
    DELETE FROM user_periods;
    DELETE FROM user_profiles;
    DELETE FROM daily_cohorts;
    UPDATE period_totals SET active_users=0,new_users=0,returning_users=0,paired_devices=0,sessions=0,
      connected_ms=0,messages=0,upload_bytes=0,download_bytes=0,active_message_seconds=0,
      upload_rate_histogram='{}',download_rate_histogram='{}',combined_rate_histogram='{}',
      upload_peak_bytes=0,download_peak_bytes=0,combined_peak_bytes=0;
    INSERT INTO telemetry_meta(key, value) VALUES ('device_consent_migration_v1', 'complete');
  `);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

const now = (): number => Date.now();
const dateStart = (at: number): number => {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};
const bucketStart = (granularity: UsageGranularity, at: number): number => {
  const day = dateStart(at);
  switch (granularity) {
    case "hour": return Math.floor(at / HOUR) * HOUR;
    case "day": return day;
    case "week": return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
    case "fortnight": {
      const mondayEpoch = Date.UTC(1970, 0, 5);
      const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
      return mondayEpoch + Math.floor((monday - mondayEpoch) / (14 * DAY)) * 14 * DAY;
    }
    case "month": {
      const date = new Date(day);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    }
  }
};
const granularities: UsageGranularity[] = ["hour", "day", "week", "fortnight", "month"];
const insertTotal = db.prepare("INSERT OR IGNORE INTO period_totals(granularity,bucket_start) VALUES (?,?)");
const insertUser = db.prepare("INSERT OR IGNORE INTO user_periods(granularity,bucket_start,user_id) VALUES (?,?,?)");
const insertProfile = db.prepare("INSERT INTO user_profiles(user_id,first_active_at,last_active_at,first_paired_at,retention_offsets) VALUES (?,NULL,NULL,?,'[]')");
const updateProfileActive = db.prepare("UPDATE user_profiles SET first_active_at=COALESCE(first_active_at,?),last_active_at=? WHERE user_id=?");
const selectUserPeriod = db.prepare("SELECT active,new_user,returning_user FROM user_periods WHERE granularity=? AND bucket_start=? AND user_id=?");
const updateUserActive = db.prepare("UPDATE user_periods SET active=1,new_user=?,returning_user=? WHERE granularity=? AND bucket_start=? AND user_id=?");
const updateTotalActive = db.prepare("UPDATE period_totals SET active_users=active_users+1,new_users=new_users+?,returning_users=returning_users+? WHERE granularity=? AND bucket_start=?");
const updateUserCounters = db.prepare("UPDATE user_periods SET sessions=sessions+?,messages=messages+?,upload_bytes=upload_bytes+?,download_bytes=download_bytes+?,paired_devices=paired_devices+? WHERE granularity=? AND bucket_start=? AND user_id=?");
const updateTotalCounters = db.prepare("UPDATE period_totals SET sessions=sessions+?,messages=messages+?,upload_bytes=upload_bytes+?,download_bytes=download_bytes+?,paired_devices=paired_devices+? WHERE granularity=? AND bucket_start=?");
const updateUserDuration = db.prepare("UPDATE user_periods SET connected_ms=connected_ms+? WHERE granularity=? AND bucket_start=? AND user_id=?");
const updateTotalDuration = db.prepare("UPDATE period_totals SET connected_ms=connected_ms+? WHERE granularity=? AND bucket_start=?");
const updateUserSample = db.prepare("UPDATE user_periods SET active_message_seconds=active_message_seconds+1,upload_rate_histogram=?,download_rate_histogram=?,combined_rate_histogram=?,upload_peak_bytes=MAX(upload_peak_bytes,?),download_peak_bytes=MAX(download_peak_bytes,?),combined_peak_bytes=MAX(combined_peak_bytes,?) WHERE granularity=? AND bucket_start=? AND user_id=?");
const updateTotalSample = db.prepare("UPDATE period_totals SET active_message_seconds=active_message_seconds+1,upload_rate_histogram=?,download_rate_histogram=?,combined_rate_histogram=?,upload_peak_bytes=MAX(upload_peak_bytes,?),download_peak_bytes=MAX(download_peak_bytes,?),combined_peak_bytes=MAX(combined_peak_bytes,?) WHERE granularity=? AND bucket_start=?");
const histKey = (bytes: number): string => String(bytes === 0 ? 0 : Math.ceil(Math.log2(bytes) * 16) + 1);
const ensureRows = (userId: string, at: number): Array<{ granularity: UsageGranularity; start: number }> => {
  const rows = granularities.map(granularity => ({ granularity, start: bucketStart(granularity, at) }));
  for (const row of rows) {
    insertTotal.run(row.granularity, row.start);
    insertUser.run(row.granularity, row.start, userId);
  }
  return rows;
};

const profiles = new Map<string, { firstActiveAt: number | null; lastActiveAt: number | null; retentionOffsets: Set<number> }>();
const sessions = new Map<string, { userId: string; lastAt: number }>();
const pendingRates = new Map<string, { second: number; upload: number; download: number }>();
const deviceRows = db.prepare("SELECT user_id,first_active_at,last_active_at,retention_offsets FROM user_profiles").all() as Array<{ user_id: string; first_active_at: number | null; last_active_at: number | null; retention_offsets: string }>;
for (const row of deviceRows) profiles.set(row.user_id, {
  firstActiveAt: row.first_active_at,
  lastActiveAt: row.last_active_at,
  retentionOffsets: new Set<number>(JSON.parse(row.retention_offsets || "[]")),
});

function markActive(userId: string, at: number): void {
  let profile = profiles.get(userId);
  const first = profile?.firstActiveAt ?? null;
  const isFirst = first === null;
  if (!profile) {
    profile = { firstActiveAt: null, lastActiveAt: null, retentionOffsets: new Set() };
    profiles.set(userId, profile);
    insertProfile.run(userId, null);
  }
  if (isFirst) profile.firstActiveAt = at;
  profile.lastActiveAt = at;
  updateProfileActive.run(profile.firstActiveAt, at, userId);
  const rows = ensureRows(userId, at);
  for (const { granularity, start } of rows) {
    const current = selectUserPeriod.get(granularity, start, userId) as { active: number; new_user: number; returning_user: number };
    if (current.active === 1) continue;
    const isNewForPeriod = first !== null ? bucketStart(granularity, first) === start : true;
    const isReturningForPeriod = !isNewForPeriod;
    updateUserActive.run(isNewForPeriod ? 1 : 0, isReturningForPeriod ? 1 : 0, granularity, start, userId);
    updateTotalActive.run(isNewForPeriod ? 1 : 0, isReturningForPeriod ? 1 : 0, granularity, start);
  }
  const firstDay = dateStart(profile.firstActiveAt!);
  const currentDay = dateStart(at);
  const cohortDate = new Date(firstDay).toISOString().slice(0, 10);
  if (isFirst) {
    db.prepare("INSERT INTO daily_cohorts(cohort_date,cohort_users) VALUES (?,1) ON CONFLICT(cohort_date) DO UPDATE SET cohort_users=cohort_users+1").run(cohortDate);
  } else {
    const daysSince = Math.floor((currentDay - firstDay) / DAY);
    if ([1, 7, 30].includes(daysSince) && !profile.retentionOffsets.has(daysSince)) {
      const column = daysSince === 1 ? "day1_retained" : daysSince === 7 ? "day7_retained" : "day30_retained";
      db.prepare(`UPDATE daily_cohorts SET ${column}=${column}+1 WHERE cohort_date=?`).run(cohortDate);
      profile.retentionOffsets.add(daysSince);
      db.prepare("UPDATE user_profiles SET retention_offsets=? WHERE user_id=?").run(JSON.stringify([...profile.retentionOffsets]), userId);
    }
  }
}

function addCounters(userId: string | null, at: number, values: { sessions?: number; messages?: number; uploadBytes?: number; downloadBytes?: number; pairedDevices?: number }): void {
  const rows = userId === null ? granularities.map(granularity => ({ granularity, start: bucketStart(granularity, at) })) : ensureRows(userId, at);
  for (const { granularity, start } of rows) {
    insertTotal.run(granularity, start);
    const sessionsCount = values.sessions ?? 0;
    const messageCount = values.messages ?? 0;
    const up = values.uploadBytes ?? 0;
    const down = values.downloadBytes ?? 0;
    const pairs = values.pairedDevices ?? 0;
    updateTotalCounters.run(sessionsCount, messageCount, up, down, pairs, granularity, start);
    if (userId !== null) updateUserCounters.run(sessionsCount, messageCount, up, down, pairs, granularity, start, userId);
  }
}

function addDuration(session: { userId: string; lastAt: number }, until: number): void {
  if (!Number.isFinite(until) || until <= session.lastAt) return;
  let cursor = session.lastAt;
  while (cursor < until) {
    const end = Math.min(until, Math.floor(cursor / HOUR) * HOUR + HOUR);
    const amount = end - cursor;
    markActive(session.userId, cursor);
    for (const { granularity, start } of ensureRows(session.userId, cursor)) {
      updateUserDuration.run(amount, granularity, start, session.userId);
      updateTotalDuration.run(amount, granularity, start);
    }
    cursor = end;
  }
  session.lastAt = until;
}

function completeRate(deviceId: string, sample: { second: number; upload: number; download: number }): void {
  const at = sample.second * 1000;
  const rows = ensureRows(deviceId, at);
  const uploadKey = histKey(sample.upload), downloadKey = histKey(sample.download), combinedBytes = sample.upload + sample.download, combinedKey = histKey(combinedBytes);
  for (const { granularity, start } of rows) {
    const user = db.prepare("SELECT upload_rate_histogram,download_rate_histogram,combined_rate_histogram FROM user_periods WHERE granularity=? AND bucket_start=? AND user_id=?").get(granularity, start, deviceId) as { upload_rate_histogram: string; download_rate_histogram: string; combined_rate_histogram: string };
    const oldUpload = JSON.parse(user.upload_rate_histogram || "{}") as Record<string, number>;
    const oldDownload = JSON.parse(user.download_rate_histogram || "{}") as Record<string, number>;
    const oldCombined = JSON.parse(user.combined_rate_histogram || "{}") as Record<string, number>;
    oldUpload[uploadKey] = (oldUpload[uploadKey] ?? 0) + 1;
    oldDownload[downloadKey] = (oldDownload[downloadKey] ?? 0) + 1;
    oldCombined[combinedKey] = (oldCombined[combinedKey] ?? 0) + 1;
    updateUserSample.run(JSON.stringify(oldUpload), JSON.stringify(oldDownload), JSON.stringify(oldCombined), sample.upload, sample.download, combinedBytes, granularity, start, deviceId);
    updateTotalSample.run(JSON.stringify(oldUpload), JSON.stringify(oldDownload), JSON.stringify(oldCombined), sample.upload, sample.download, combinedBytes, granularity, start);
  }
}

const totalUpdates: Record<string, ReturnType<typeof db.prepare>> = {
  "site-view": db.prepare("UPDATE period_totals SET website_page_views=website_page_views+1 WHERE granularity=? AND bucket_start=?"),
  "registration-start": db.prepare("UPDATE period_totals SET registration_starts=registration_starts+1 WHERE granularity=? AND bucket_start=?"),
  "pairing-code": db.prepare("UPDATE period_totals SET pairing_codes=pairing_codes+1 WHERE granularity=? AND bucket_start=?"),
  "host-registered": db.prepare("UPDATE period_totals SET new_host_registrations=new_host_registrations+1 WHERE granularity=? AND bucket_start=?"),
  "download-request": db.prepare("UPDATE period_totals SET download_requests=download_requests+1,download_bytes_served=download_bytes_served+?,downloads_windows=downloads_windows+?,downloads_macos=downloads_macos+?,downloads_android=downloads_android+?,downloads_ios=downloads_ios+?,downloads_other=downloads_other+? WHERE granularity=? AND bucket_start=?"),
};
function recordTotalEvent(type: string, at: number, values: Record<string, unknown> = {}): void {
  for (const granularity of granularities) {
    const start = bucketStart(granularity, at);
    insertTotal.run(granularity, start);
    const statement = totalUpdates[type];
    if (!statement) continue;
    if (type === "download-request") {
      const platform = String(values.platform ?? "other");
      statement.run(Number(values.bytes ?? 0), Number(platform === "windows"), Number(platform === "macos"), Number(platform === "android"), Number(platform === "ios"), Number(!["windows", "macos", "android", "ios"].includes(platform)), granularity, start);
    } else statement.run(granularity, start);
  }
}

function recordHostRegistration(hostId: string, at: number): void {
  const hostHash = createHash("sha256").update(hostId).digest("hex");
  const inserted = db.prepare("INSERT OR IGNORE INTO host_profiles(host_hash,first_registered_at) VALUES (?,?)").run(hostHash, at).changes > 0;
  if (inserted) recordTotalEvent("host-registered", at);
}
function recordResource(sample: Record<string, unknown>): void {
  const at = Number(sample.sampledAt);
  const values: [number, number, number, number, number, number, number] = [Number(sample.cpuPercent), Number(sample.rssBytes), Number(sample.heapUsedBytes), Number(sample.connectedDevices), Number(sample.connectedHosts), Number(sample.eventLoopP95Ms), Number(sample.eventLoopMaxMs)];
  const statement = db.prepare(`UPDATE period_totals SET resource_samples=resource_samples+1,cpu_percent_sum=cpu_percent_sum+?,cpu_percent_peak=MAX(cpu_percent_peak,?),rss_bytes_sum=rss_bytes_sum+?,rss_bytes_peak=MAX(rss_bytes_peak,?),heap_used_bytes_sum=heap_used_bytes_sum+?,heap_used_bytes_peak=MAX(heap_used_bytes_peak,?),connected_devices_peak=MAX(connected_devices_peak,?),connected_hosts_peak=MAX(connected_hosts_peak,?),event_loop_p95_ms_peak=MAX(event_loop_p95_ms_peak,?),event_loop_max_ms_peak=MAX(event_loop_max_ms_peak,?) WHERE granularity=? AND bucket_start=?`);
  for (const { granularity, start } of granularities.map(granularity => ({ granularity, start: bucketStart(granularity, at) }))) {
    insertTotal.run(granularity, start);
    statement.run(values[0], values[0], values[1], values[1], values[2], values[2], values[3], values[4], values[5], values[6], granularity, start);
  }
}

function rateSummary(histogramJson: string, count: number, peakBytes: number, exactBytes: number): { meanBps: number; p95Bps: number; peakBps: number } {
  const histogram = JSON.parse(histogramJson || "{}") as Record<string, number>;
  let remaining = Math.ceil(count * 0.95);
  let p95 = 0;
  for (const key of Object.keys(histogram).map(Number).sort((a, b) => a - b)) {
    remaining -= histogram[String(key)]!;
    if (remaining <= 0) { p95 = key === 0 ? 0 : Math.floor(2 ** ((key - 1) / 16)); break; }
  }
  return { meanBps: count ? exactBytes * 8 / count : 0, p95Bps: Math.min(p95, peakBytes) * 8, peakBps: peakBytes * 8 };
}
function bucketEnd(granularity: UsageGranularity, start: number): number {
  switch (granularity) {
    case "hour": return start + HOUR;
    case "day": return start + DAY;
    case "week": return start + 7 * DAY;
    case "fortnight": return start + 14 * DAY;
    case "month": { const date = new Date(start); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1); }
  }
}
function serialize(row: Record<string, any>, granularity: UsageGranularity, isTotal: boolean): Record<string, unknown> {
  const count = Number(row.active_message_seconds ?? 0);
  const uploadPeak = Number(row.upload_peak_bytes ?? 0), downloadPeak = Number(row.download_peak_bytes ?? 0), combinedPeak = Number(row.combined_peak_bytes ?? 0);
  const common = {
    bucketStart: Number(row.bucket_start), bucketEnd: bucketEnd(granularity, Number(row.bucket_start)),
    activeUsers: Number(row.active_users ?? row.active ?? 0), newUsers: Number(row.new_users ?? row.new_user ?? 0),
    returningUsers: Number(row.returning_users ?? row.returning_user ?? 0), sessions: Number(row.sessions ?? 0),
    connectedSeconds: Math.floor(Number(row.connected_ms ?? 0) / 1000), messages: Number(row.messages ?? 0),
    uploadBytes: Number(row.upload_bytes ?? 0), downloadBytes: Number(row.download_bytes ?? 0),
    totalBytes: Number(row.upload_bytes ?? 0) + Number(row.download_bytes ?? 0), activeMessageSeconds: count,
    bandwidth: {
      upload: rateSummary(String(row.upload_rate_histogram ?? "{}"), count, uploadPeak, Number(row.upload_bytes ?? 0)),
      download: rateSummary(String(row.download_rate_histogram ?? "{}"), count, downloadPeak, Number(row.download_bytes ?? 0)),
      combined: rateSummary(String(row.combined_rate_histogram ?? "{}"), count, combinedPeak, Number(row.upload_bytes ?? 0) + Number(row.download_bytes ?? 0)),
    },
    pairedDevices: Number(row.paired_devices ?? 0),
  };
  if (!isTotal) return common;
  const samples = Number(row.resource_samples ?? 0);
  return {
    ...common,
    newHostRegistrations: Number(row.new_host_registrations ?? 0), registrationStarts: Number(row.registration_starts ?? 0), pairingCodes: Number(row.pairing_codes ?? 0),
    websitePageViews: Number(row.website_page_views ?? 0), downloadRequests: Number(row.download_requests ?? 0), downloadBytesServed: Number(row.download_bytes_served ?? 0),
    downloads: { windows: Number(row.downloads_windows ?? 0), macos: Number(row.downloads_macos ?? 0), android: Number(row.downloads_android ?? 0), ios: Number(row.downloads_ios ?? 0), other: Number(row.downloads_other ?? 0) },
    resources: {
      sampleCount: samples, cpuPercentAverage: samples ? Number(row.cpu_percent_sum) / samples : 0, cpuPercentPeak: Number(row.cpu_percent_peak ?? 0),
      rssBytesAverage: samples ? Number(row.rss_bytes_sum) / samples : 0, rssBytesPeak: Number(row.rss_bytes_peak ?? 0),
      heapUsedBytesAverage: samples ? Number(row.heap_used_bytes_sum) / samples : 0, heapUsedBytesPeak: Number(row.heap_used_bytes_peak ?? 0),
      connectedDevicesPeak: Number(row.connected_devices_peak ?? 0), connectedHostsPeak: Number(row.connected_hosts_peak ?? 0),
      eventLoopP95MsPeak: Number(row.event_loop_p95_ms_peak ?? 0), eventLoopMaxMsPeak: Number(row.event_loop_max_ms_peak ?? 0),
    },
  };
}
function snapshot(granularity: UsageGranularity, deviceId?: string): Record<string, unknown> {
  const timestamp = now();
  const limit: Record<UsageGranularity, number> = { hour: 168, day: 90, week: 104, fortnight: 52, month: 36 };
  const aggregateRows = db.prepare("SELECT * FROM period_totals WHERE granularity=? ORDER BY bucket_start DESC LIMIT ?").all(granularity, limit[granularity]) as Array<Record<string, any>>;
  const currentStart = bucketStart(granularity, timestamp);
  insertTotal.run(granularity, currentStart);
  const userRows = deviceId
    ? db.prepare("SELECT * FROM user_periods WHERE granularity=? AND user_id=? ORDER BY bucket_start DESC LIMIT ?").all(granularity, deviceId, limit[granularity]) as Array<Record<string, any>>
    : db.prepare("SELECT * FROM user_periods WHERE granularity=? AND bucket_start=? ORDER BY user_id").all(granularity, currentStart) as Array<Record<string, any>>;
  const coverage = db.prepare("SELECT value FROM telemetry_meta WHERE key='coverage_started_at'").get() as { value: string };
  const cohorts = db.prepare("SELECT cohort_date,cohort_users,day1_retained,day7_retained,day30_retained FROM daily_cohorts ORDER BY cohort_date DESC LIMIT 30").all() as Array<Record<string, any>>;
  const users = userRows.map(row => ({ deviceId: row.user_id, ...serialize(row, granularity, false) }));
  const cohortRows = cohorts.map(row => ({ date: row.cohort_date, users: row.cohort_users, day1Retained: row.day1_retained, day7Retained: row.day7_retained, day30Retained: row.day30_retained }));
  return {
    featureId: "X12", generatedAt: timestamp, timezone: "UTC", granularity,
    coverageStartedAt: Number(coverage.value) * 1000,
    retention: Object.fromEntries(Object.entries(RETENTION).map(([key, value]) => [key, Math.floor(value / DAY)])),
    preAggregated: true,
    selectedBucketStart: deviceId ? null : currentStart,
    aggregate: aggregateRows.reverse().map(row => ({ granularity, ...serialize(row, granularity, true) })),
    users,
    deviceHistory: deviceId ? users : undefined,
    cohorts: cohortRows,
    privacy: { identity: "relay-device-id", siteVisitors: "not-uniquely-identified", storesIp: false, storesPayload: false },
  };
}

const activeSessions = () => sessions.size;
function prune(at: number): void {
  for (const granularity of granularities) {
    const cutoff = at - RETENTION[granularity];
    db.prepare("DELETE FROM period_totals WHERE granularity=? AND bucket_start<?").run(granularity, cutoff);
    db.prepare("DELETE FROM user_periods WHERE granularity=? AND bucket_start<?").run(granularity, cutoff);
  }
  const cohortCutoff = new Date(at - COHORT_RETENTION).toISOString().slice(0, 10);
  db.prepare("DELETE FROM daily_cohorts WHERE cohort_date<?").run(cohortCutoff);
  const profileCutoff = at - 5 * 366 * DAY;
  db.prepare("DELETE FROM user_profiles WHERE COALESCE(last_active_at,first_paired_at) IS NOT NULL AND COALESCE(last_active_at,first_paired_at)<?").run(profileCutoff);
  db.prepare("DELETE FROM host_profiles WHERE first_registered_at<?").run(profileCutoff);
  for (const [id, profile] of profiles) {
    if (profile.lastActiveAt !== null && profile.lastActiveAt < profileCutoff) profiles.delete(id);
  }
}

let lastPrunedDate = "";
const transactional = (work: () => void): void => {
  db.exec("BEGIN IMMEDIATE");
  try { work(); db.exec("COMMIT"); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
};
const port = parentPort!;
port.on("message", (message: Record<string, any>) => {
  const id = Number(message.id ?? 0);
  try {
    transactional(() => {
      const at = Number(message.at ?? message.sample?.sampledAt ?? now());
      if (new Date(at).toISOString().slice(0, 10) !== lastPrunedDate) { prune(at); lastPrunedDate = new Date(at).toISOString().slice(0, 10); }
      switch (message.type) {
        case "traffic": {
          const deviceId = String(message.deviceId);
          const direction = message.direction === "upload" ? "upload" : "download";
          const bytes = Number(message.bytes);
          markActive(deviceId, at);
          addCounters(deviceId, at, { messages: 1, ...(direction === "upload" ? { uploadBytes: bytes } : { downloadBytes: bytes }) });
          const second = Math.floor(at / 1000);
          const pending = pendingRates.get(deviceId);
          if (pending && pending.second !== second) {
            completeRate(deviceId, pending);
            pendingRates.delete(deviceId);
          }
          const current = pendingRates.get(deviceId) ?? { second, upload: 0, download: 0 };
          if (direction === "upload") current.upload += bytes; else current.download += bytes;
          pendingRates.set(deviceId, current);
          break;
        }
        case "session-start": {
          const deviceId = String(message.deviceId), sessionId = String(message.sessionId);
          markActive(deviceId, at);
          sessions.set(sessionId, { userId: deviceId, lastAt: at });
          addCounters(deviceId, at, { sessions: 1 });
          break;
        }
        case "session-checkpoint":
        case "session-end": {
          const sessionId = String(message.sessionId);
          const session = sessions.get(sessionId);
          if (session) {
            addDuration(session, at);
            if (message.type === "session-end") {
              sessions.delete(sessionId);
              if (![...sessions.values()].some(active => active.userId === session.userId)) {
                const pending = pendingRates.get(session.userId);
                if (pending) { completeRate(session.userId, pending); pendingRates.delete(session.userId); }
              }
            }
          }
          break;
        }
        case "set-device-consent": {
          const deviceId = String(message.deviceId);
          if (message.enabled === true) {
            db.prepare("INSERT INTO device_telemetry_consent(device_id, enabled_at) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET enabled_at=excluded.enabled_at").run(deviceId, at);
          } else {
            db.prepare("DELETE FROM device_telemetry_consent WHERE device_id=?").run(deviceId);
            db.prepare("DELETE FROM user_periods WHERE user_id=?").run(deviceId);
            db.prepare("DELETE FROM user_profiles WHERE user_id=?").run(deviceId);
            for (const [sessionId, session] of sessions) if (session.userId === deviceId) sessions.delete(sessionId);
            pendingRates.delete(deviceId);
          }
          break;
        }
        case "forget-device": {
          const deviceId = String(message.deviceId);
          db.prepare("DELETE FROM device_telemetry_consent WHERE device_id=?").run(deviceId);
          db.prepare("DELETE FROM user_periods WHERE user_id=?").run(deviceId);
          db.prepare("DELETE FROM user_profiles WHERE user_id=?").run(deviceId);
          for (const [sessionId, session] of sessions) if (session.userId === deviceId) sessions.delete(sessionId);
          pendingRates.delete(deviceId);
          break;
        }
        case "host-registered": recordHostRegistration(String(message.hostId), at); break;
        case "registration-start": recordTotalEvent("registration-start", at); break;
        case "pairing-code": recordTotalEvent("pairing-code", at); break;
        case "site-view": recordTotalEvent("site-view", at); break;
        case "download": recordTotalEvent("download-request", at, { platform: message.platform, bytes: message.bytes }); break;
        case "resource": recordResource(message.sample as Record<string, unknown>); break;
        case "snapshot": {
          // Close only completed per-second samples. Current second traffic totals
          // are already durable and will be sampled when the next second arrives.
          const currentSecond = Math.floor(now() / 1000);
          for (const [deviceId, sample] of pendingRates) {
            if (sample.second < currentSecond) { completeRate(deviceId, sample); pendingRates.delete(deviceId); }
          }
          prune(at);
          break;
        }
        case "flush":
          break;
        case "close":
          for (const [deviceId, sample] of pendingRates) completeRate(deviceId, sample);
          pendingRates.clear();
          for (const session of sessions.values()) addDuration(session, at);
          sessions.clear();
          break;
      }
    });
    if (message.type === "flush") db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    if ((message.type === "set-device-consent" && message.enabled !== true) || message.type === "forget-device") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (message.type === "close") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (id) {
      const value = message.type === "snapshot"
        ? snapshot(message.granularity as UsageGranularity, typeof message.deviceId === "string" ? message.deviceId : undefined)
        : message.type === "close" ? { activeSessions: activeSessions() }
        : message.type === "consented-devices" ? (db.prepare("SELECT device_id FROM device_telemetry_consent WHERE enabled_at IS NOT NULL").all() as Array<{ device_id: string }>).map(row => row.device_id)
        : undefined;
      port.postMessage({ id, ok: true, value });
    }
    if (message.type === "close") { db.close(); port.close(); }
  } catch (error) {
    if (id) port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : "telemetry_error" });
  }
});
