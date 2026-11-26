/* global AbortSignal */
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

// Production app and its existing external group. Never infer either from the newest upload.
const appId = '6829381852';
const bundleId = 'com.orbising.orbis.ios';
const groupId = 'fe9fb1a0-8fbe-4818-86af-f8897c2ac1b4';
const origin = 'https://api.appstoreconnect.apple.com';
const groupPath = `/v1/betaGroups/${groupId}/relationships/builds`;
const ready = new Set(['BETA_APPROVED', 'READY_FOR_BETA_TESTING']);
const reviewing = new Set(['WAITING_FOR_BETA_REVIEW', 'IN_BETA_REVIEW']);
const blocked = new Set(['MISSING_EXPORT_COMPLIANCE', 'IN_EXPORT_COMPLIANCE_REVIEW', 'PROCESSING_EXCEPTION', 'EXPIRED', 'BETA_REJECTED', 'NOT_APPLICABLE']);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function makeToken(keyId, issuerId, key, now = Math.floor(Date.now() / 1000), scope) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const body = `${encode({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${encode({ iss: issuerId, iat: now, exp: now + 600, aud: 'appstoreconnect-v1', ...(scope ? { scope: [scope] } : {}) })}`;
  return `${body}.${sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

export function makeRequest(token, transport = fetch) {
  return async (method, path, body) => {
    const url = new URL(path, origin);
    requireCondition(url.origin === origin && url.pathname.startsWith('/v1/'), 'Unexpected App Store Connect API URL.');
    let response;
    try {
      response = await transport(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token(method, `${url.pathname}${url.search}`)}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`${method} ${url.pathname}: connection failed; run status to reconcile before retrying any write.`);
    }
    if (response.status === 204) return {};
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      // Error detail, response bodies and query parameters can contain private metadata.
      const codes = (Array.isArray(payload?.errors) ? payload.errors : []).map(x => x.code).filter(x => typeof x === 'string' && /^[A-Z][A-Z_0-9.]{0,99}$/.test(x));
      const error = new Error(`${method} ${url.pathname}: HTTP ${response.status}${codes.length ? ` (${codes.join(', ')})` : ''}.`);
      error.status = response.status;
      throw error;
    }
    requireCondition(payload && typeof payload === 'object', `${method} ${url.pathname}: invalid JSON response; reconcile before retrying.`);
    return payload;
  };
}

const query = (path, fields) => `${path}?${new URLSearchParams(fields)}`;
const buildRelation = (id) => ({ type: 'builds', id });

async function list(request, path, matches) {
  for (let page = 0; path && page < 100; page++) {
    const data = await request('GET', path);
    requireCondition(Array.isArray(data.data), 'App Store Connect returned an invalid collection.');
    if (matches) {
      const found = data.data.find(matches);
      if (found) return found;
    } else {
      // Exact build queries use limit=2 and must be unique across all pages.
      requireCondition(!data.links?.next && data.data.length <= 1, 'The version/build selector is ambiguous.');
      return data.data[0] ?? null;
    }
    path = data.links?.next;
    if (!path) return null;
  }
  throw new Error('App Store Connect collection pagination limit reached.');
}

async function readTarget(request) {
  const app = (await request('GET', query(`/v1/apps/${appId}`, { 'fields[apps]': 'bundleId' }))).data;
  requireCondition(app?.id === appId && app.attributes?.bundleId === bundleId, 'App ID does not match the production Orbis bundle.');
  const group = await list(request, query(`/v1/apps/${appId}/betaGroups`, { 'fields[betaGroups]': 'name,isInternalGroup', limit: '200' }), item => item.id === groupId);
  requireCondition(group?.attributes?.isInternalGroup === false, 'The configured external group is missing or is internal.');
}

async function findBuild(request, version, build) {
  const candidate = await list(request, query('/v1/builds', {
    'filter[app]': appId, 'filter[version]': build, 'filter[preReleaseVersion.version]': version,
    'filter[preReleaseVersion.platform]': 'IOS',
    'fields[builds]': 'version,expired,processingState,buildAudienceType,usesNonExemptEncryption', limit: '2',
  }));
  requireCondition(!candidate || (candidate.id && candidate.attributes?.version === build), 'App Store Connect returned the wrong build number.');
  return candidate;
}

async function findUploads(request, version, build) {
  const result = await request('GET', query(`/v1/apps/${appId}/buildUploads`, {
    'filter[cfBundleShortVersionString]': version, 'filter[cfBundleVersion]': build, 'filter[platform]': 'IOS', limit: '1',
  }));
  requireCondition(Array.isArray(result.data), 'App Store Connect returned an invalid upload collection.');
  return result.data.length > 0;
}

async function submissionState(request, id) {
  try {
    return (await request('GET', `/v1/builds/${id}/betaAppReviewSubmission`)).data?.attributes?.betaReviewState ?? null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function readBuildStatus(request, candidate) {
  const a = candidate.attributes;
  const snapshot = {
    buildId: candidate.id, processing: a.processingState, audience: a.buildAudienceType ?? null,
    nonExemptEncryption: a.usesNonExemptEncryption ?? null, expired: a.expired, inExternalGroup: false,
    externalState: null, reviewState: null, autoNotifyEnabled: null, availableToExternalGroup: false,
  };
  if (a.processingState !== 'VALID') return snapshot;
  const detail = (await request('GET', `/v1/builds/${candidate.id}/buildBetaDetail`)).data;
  requireCondition(detail?.id && detail.attributes?.externalBuildState, 'The build has no usable beta details yet.');
  const externalState = detail.attributes.externalBuildState;
  const inExternalGroup = Boolean(await list(request, query(groupPath, { limit: '200' }), item => item.id === candidate.id));
  const reviewState = a.buildAudienceType === 'INTERNAL_ONLY' ? null : await submissionState(request, candidate.id);
  return { ...snapshot, detailId: detail.id, inExternalGroup, externalState, reviewState,
    autoNotifyEnabled: detail.attributes.autoNotifyEnabled ?? null,
    availableToExternalGroup: inExternalGroup && externalState === 'IN_BETA_TESTING' && a.expired === false };
}

async function ensureNotes(request, id, locale, notes) {
  const existing = await list(request, `/v1/builds/${id}/betaBuildLocalizations`, item => item.attributes?.locale === locale);
  if (!existing) {
    await request('POST', '/v1/betaBuildLocalizations', { data: { type: 'betaBuildLocalizations', attributes: { locale, whatsNew: notes }, relationships: { build: { data: buildRelation(id) } } } });
  } else if (existing.attributes.whatsNew !== notes) {
    await request('PATCH', `/v1/betaBuildLocalizations/${existing.id}`, { data: { type: 'betaBuildLocalizations', id: existing.id, attributes: { whatsNew: notes } } });
  }
}

async function checkReviewMetadata(request) {
  const { data } = await request('GET', `/v1/apps/${appId}/betaAppReviewDetail`);
  const fields = data?.attributes ?? {};
  requireCondition(['contactEmail', 'contactFirstName', 'contactLastName', 'contactPhone', 'notes'].every(k => fields[k]?.trim()), 'Complete the private Beta review contact information and notes in App Store Connect.');
  requireCondition(!fields.demoAccountRequired || (fields.demoAccountName?.trim() && fields.demoAccountPassword?.trim()), 'The private Beta review login details are incomplete.');
  const path = query(`/v1/apps/${appId}/betaAppLocalizations`, { 'fields[betaAppLocalizations]': 'description', limit: '200' });
  const missingDescription = await list(request, path, item => !item.attributes?.description?.trim());
  requireCondition(!missingDescription, 'Complete the Beta App Description for every locale in App Store Connect.');
}

export async function runExternal(request, options, pause = delay) {
  const { action, version, build, notes, locale = 'zh-Hans', wait = 0, notifyApproved = false, uploadOnly = false } = options;
  requireCondition(['preflight', 'status', 'distribute'].includes(action), 'Choose preflight, status or distribute.');
  requireCondition(/^\d+(?:\.\d+){1,2}$/.test(version ?? '') && /^[1-9]\d*$/.test(build ?? ''), 'Pass the exact iOS --version (e.g. 0.1.3) and numeric --build.');
  requireCondition(Number.isInteger(wait) && wait >= 0 && wait <= 1800, '--wait must be 0–1800 seconds.');
  requireCondition(!notifyApproved || action === 'distribute', '--notify-approved requires distribute.');
  if (action === 'distribute' || notes !== undefined) {
    requireCondition(notes?.trim() && !/\/beta-review\//i.test(notes), 'Provide tester-facing notes; keep private review links in Beta App Review Information.');
  }
  await readTarget(request);
  const context = { version, build, groupId };
  let candidate = await findBuild(request, version, build);
  if (action === 'preflight') {
    requireCondition(!candidate && !await findUploads(request, version, build), 'A build or upload already exists for this version/build. Resume distribution with the same build, or choose a new number for a new archive.');
    if (!uploadOnly) await checkReviewMetadata(request);
    return { ...context, uploadNumberFree: true, reviewMetadataChecked: !uploadOnly };
  }

  // Wait only for Apple to process the upload, never hold a CI runner for Beta Review.
  const deadline = Date.now() + wait * 1000;
  let fresh;
  for (;;) {
    fresh = candidate ? await readBuildStatus(request, candidate) : { processing: 'NOT_VISIBLE', availableToExternalGroup: false };
    if (action === 'status' || fresh.processing === 'FAILED' || fresh.processing === 'INVALID' ||
        (fresh.processing === 'VALID' && fresh.externalState !== 'PROCESSING') || Date.now() >= deadline) break;
    await pause(Math.min(15_000, Math.max(0, deadline - Date.now())));
    candidate = await findBuild(request, version, build);
  }

  if (action === 'status') return { ...context, ...fresh };
  requireCondition(fresh.processing === 'VALID' && fresh.externalState !== 'PROCESSING', `Build not ready (${fresh.processing}/${fresh.externalState ?? 'unknown'}); run status, then resume distribution with this build.`);
  requireCondition(fresh.audience === 'APP_STORE_ELIGIBLE' && fresh.expired === false, 'Build is internal-only, expired, or external eligibility could not be confirmed.');
  requireCondition(typeof fresh.nonExemptEncryption === 'boolean' && !blocked.has(fresh.externalState), `Build cannot enter external testing (${fresh.externalState}); resolve the actual encryption/export compliance or review issue first.`);
  const allowed = new Set(['READY_FOR_BETA_SUBMISSION', 'IN_BETA_TESTING', ...ready, ...reviewing]);
  requireCondition(allowed.has(fresh.externalState), `Unknown external state ${fresh.externalState}; no write made.`);
  requireCondition(fresh.reviewState !== 'REJECTED', 'Apple rejected this build. Check the review feedback before retrying.');
  if (fresh.inExternalGroup && (fresh.availableToExternalGroup || reviewing.has(fresh.externalState) ||
      ['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(fresh.reviewState))) return { ...context, ...fresh };

  const id = fresh.buildId;
  const beforeSubmission = fresh.externalState === 'READY_FOR_BETA_SUBMISSION' && fresh.reviewState === null;
  if (beforeSubmission) await checkReviewMetadata(request);
  if (beforeSubmission || !fresh.inExternalGroup) {
    await ensureNotes(request, id, locale, notes);
    if (fresh.autoNotifyEnabled !== true && fresh.externalState !== 'IN_BETA_TESTING') {
      await request('PATCH', `/v1/buildBetaDetails/${fresh.detailId}`, { data: { type: 'buildBetaDetails', id: fresh.detailId, attributes: { autoNotifyEnabled: true } } });
    }
  }
  if (!fresh.inExternalGroup) await request('POST', groupPath, { data: [buildRelation(id)] });

  // Adding the build can change its review state. Re-read before deciding to submit.
  fresh = await readBuildStatus(request, candidate);
  requireCondition(fresh.inExternalGroup, 'Group membership not visible yet. Run status and resume with the same build; do not re-upload.');
  requireCondition(!blocked.has(fresh.externalState) && fresh.reviewState !== 'REJECTED', `Build is blocked (${fresh.externalState}/${fresh.reviewState ?? 'no review'}).`);
  if (fresh.externalState === 'READY_FOR_BETA_SUBMISSION' && fresh.reviewState === null) {
    requireCondition(beforeSubmission, 'Build became eligible to submit during distribution; rerun to verify private review metadata before sending.');
    const { data } = await request('POST', '/v1/betaAppReviewSubmissions', { data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: buildRelation(id) } } } });
    requireCondition(data?.id, 'Submission outcome not visible; run status before retrying.');
    const submitted = await readBuildStatus(request, candidate);
    return { ...context, ...submitted, reviewSubmissionAccepted: true, reviewState: submitted.reviewState ?? data.attributes?.betaReviewState ?? null };
  }
  requireCondition(fresh.availableToExternalGroup || ready.has(fresh.externalState) || reviewing.has(fresh.externalState) || ['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(fresh.reviewState),
    `No actionable external status (${fresh.externalState}/${fresh.reviewState ?? 'no review'}); read status before retrying.`);
  // The notification endpoint is build-wide, not group-specific. Require explicit opt-in.
  if (notifyApproved && ready.has(fresh.externalState)) {
    await request('POST', '/v1/buildBetaNotifications', { data: { type: 'buildBetaNotifications', relationships: { build: { data: buildRelation(id) } } } });
    fresh = await readBuildStatus(request, candidate);
  }
  return { ...context, ...fresh, notificationMayBeNeeded: ready.has(fresh.externalState) && !fresh.availableToExternalGroup };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    version: { type: 'string' }, build: { type: 'string' }, 'notes-file': { type: 'string' }, locale: { type: 'string', default: 'zh-Hans' },
    wait: { type: 'string', default: '0' }, 'notify-approved': { type: 'boolean' }, 'upload-only': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || positionals.length !== 1) {
    console.log('Usage: node scripts/ios-testflight-external.mjs preflight|status|distribute --version 0.1.3 --build 11\nDistribute: --notes-file <file> or ASC_TESTFLIGHT_NOTES, [--locale zh-Hans] [--wait 720] [--notify-approved]; preflight [--upload-only]\nAuth: ASC_KEY_ID, ASC_ISSUER_ID, and ASC_KEY_PATH or ASC_KEY_P8_BASE64 (team key).');
    return values.help ? 0 : 2;
  }
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH, ASC_KEY_P8_BASE64, ASC_TESTFLIGHT_NOTES } = process.env;
  requireCondition(/^[A-Z0-9]{10}$/.test(ASC_KEY_ID ?? '') && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(ASC_ISSUER_ID ?? '') && Boolean(ASC_KEY_PATH) !== Boolean(ASC_KEY_P8_BASE64),
    'Set a valid ASC_KEY_ID, ASC_ISSUER_ID and exactly one of ASC_KEY_PATH / ASC_KEY_P8_BASE64.');
  let key;
  try {
    key = createPrivateKey(ASC_KEY_PATH ? readFileSync(ASC_KEY_PATH) : Buffer.from(ASC_KEY_P8_BASE64, 'base64'));
    requireCondition(key.asymmetricKeyDetails?.namedCurve === 'prime256v1', 'Invalid ASC key curve.');
  } catch {
    throw new Error('Cannot read the ASC team signing key (requires a P-256 .p8 key).');
  }
  const action = positionals[0];
  const result = await runExternal(makeRequest((method, path) => makeToken(ASC_KEY_ID, ASC_ISSUER_ID, key, undefined, `${method} ${path}`)), {
    action, version: values.version, build: values.build, locale: values.locale, wait: Number(values.wait),
    notifyApproved: values['notify-approved'], uploadOnly: values['upload-only'], notes: action === 'status' ? undefined : values['notes-file'] ? readFileSync(values['notes-file'], 'utf8') : ASC_TESTFLIGHT_NOTES || undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
