import { generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { makeRequest, makeRequestToken, makeToken, runExternal } from './ios-testflight-external.mjs';

const app = '6829381852';
const group = 'fe9fb1a0-8fbe-4818-86af-f8897c2ac1b4';
const groupPath = `/v1/betaGroups/${group}/relationships/builds`;
const buildId = 'candidate-build';
const buildPath = `/v1/builds/${buildId}`;
const version = '0.1.3';
const build = '11';
const notes = '验证会话列表、消息滚动和重新连接。';
const options = { action: 'distribute', version, build, notes };

// Model the externally visible transitions and record writes. An upload needs separate verification.
function store(initial = {}) {
  const state = { internal: false, audience: 'APP_STORE_ELIGIBLE', encryption: false, processing: 'VALID',
    externalState: 'READY_FOR_BETA_SUBMISSION', review: null, visible: true, occupied: false,
    member: false, notify: false, notes: null, reviewInfoComplete: true, ...initial };
  const writes = [];
  function request(method, link, body) {
    const u = new URL(link, 'https://api.appstoreconnect.apple.com');
    const p = u.pathname;
    if (method !== 'GET') writes.push([method, p, body]);
    if (p === `/v1/apps/${app}`) return { data: { id: app, attributes: { bundleId: 'com.orbising.orbis.ios' } } };
    if (p === `/v1/apps/${app}/betaGroups`) return { data: [{ id: group, attributes: { isInternalGroup: state.internal } }] };
    if (p === '/v1/builds') {
      expect(Object.fromEntries(u.searchParams)).toMatchObject({ 'filter[app]': app, 'filter[version]': build,
        'filter[preReleaseVersion.version]': version, 'filter[preReleaseVersion.platform]': 'IOS' });
      return { data: state.visible ? [{ id: buildId, attributes: { version: build, expired: false, buildAudienceType: state.audience,
        usesNonExemptEncryption: state.encryption, processingState: state.processing } }] : [] };
    }
    if (p === `/v1/apps/${app}/buildUploads`) return { data: state.occupied ? [{ id: 'previous' }] : [] };
    if (p === `${buildPath}/buildBetaDetail`) return { data: { id: 'detail-id', attributes: { externalBuildState: state.externalState, autoNotifyEnabled: state.notify } } };
    if (p === groupPath) {
      if (method === 'GET') return { data: state.member ? [{ id: buildId }] : [] };
      expect(body).toEqual({ data: [{ type: 'builds', id: buildId }] });
      state.member = true;
      return {};
    }
    if (p === `${buildPath}/betaAppReviewSubmission`) return { data: state.review ? { id: 'review-id', attributes: { betaReviewState: state.review } } : null };
    if (p === `/v1/apps/${app}/betaAppReviewDetail`) return { data: { attributes: state.reviewInfoComplete ? {
      contactEmail: 'review@example.test', contactFirstName: 'A', contactLastName: 'B', contactPhone: '123', notes: 'Private reviewer sandbox',
    } : {} } };
    if (p === `/v1/apps/${app}/betaAppLocalizations`) return { data: [{ attributes: { description: state.reviewInfoComplete ? 'Orbis' : '' } }] };
    if (p === `${buildPath}/betaBuildLocalizations`) return { data: state.notes ? [{ id: 'notes-id', attributes: { locale: 'zh-Hans', whatsNew: state.notes } }] : [] };
    if (p === '/v1/betaBuildLocalizations' || p === '/v1/betaBuildLocalizations/notes-id') {
      state.notes = body.data.attributes.whatsNew;
      return {};
    }
    if (p === '/v1/buildBetaDetails/detail-id') {
      state.notify = body.data.attributes.autoNotifyEnabled;
      return {};
    }
    if (p === '/v1/betaAppReviewSubmissions') {
      expect(state.member && state.notify && state.notes === notes).toBe(true);
      expect(body.data.relationships.build.data).toEqual({ type: 'builds', id: buildId });
      state.externalState = 'WAITING_FOR_BETA_REVIEW';
      state.review = 'WAITING_FOR_REVIEW';
      return { data: { id: 'review-id', attributes: { betaReviewState: state.review } } };
    }
    if (p === '/v1/buildBetaNotifications') {
      state.externalState = 'IN_BETA_TESTING';
      return {};
    }
    throw new Error(`Unexpected fixture request ${method} ${p}`);
  }
  return { state, writes, request };
}

describe('external TestFlight release', () => {
  it('accepts the upload-only preflight option in the CLI', () => {
    const script = fileURLToPath(new URL('./ios-testflight-external.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, 'preflight', '--upload-only', '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('preflight [--upload-only]');
    expect(result.stderr).toBe('');
  });

  it('adds the exact build, enables automatic notifications, and submits once', async () => {
    const { request, writes } = store();
    expect(await runExternal(request, options)).toMatchObject({ inExternalGroup: true, reviewSubmissionAccepted: true,
      reviewState: 'WAITING_FOR_REVIEW', availableToExternalGroup: false });
    expect(writes.map(([method, path]) => [method, path])).toEqual([
      ['POST', '/v1/betaBuildLocalizations'], ['PATCH', '/v1/buildBetaDetails/detail-id'],
      ['POST', groupPath], ['POST', '/v1/betaAppReviewSubmissions'],
    ]);
    expect(await runExternal(request, options)).toMatchObject({ inExternalGroup: true, reviewState: 'WAITING_FOR_REVIEW' });
    expect(writes).toHaveLength(4);
  });

  it.each([
    [{ internal: true }, /external group/],
    [{ audience: 'INTERNAL_ONLY' }, /internal-only/],
    [{ externalState: 'MISSING_EXPORT_COMPLIANCE' }, /MISSING_EXPORT_COMPLIANCE/],
    [{ encryption: null }, /compliance/],
    [{ externalState: 'BETA_REJECTED', review: 'REJECTED' }, /BETA_REJECTED/],
    [{ processing: 'PROCESSING' }, /not ready/],
  ])('does not write to Apple when blocked (%j)', async (initial, error) => {
    const { request, writes } = store(initial);
    await expect(runExternal(request, options)).rejects.toThrow(error);
    expect(writes).toEqual([]);
  });

  it('checks both completed builds and reserved/processing uploads before archiving', async () => {
    const preflight = { ...options, action: 'preflight' };
    await expect(runExternal(store().request, preflight)).rejects.toThrow(/already exists/);
    await expect(runExternal(store({ visible: false, occupied: true }).request, preflight)).rejects.toThrow(/already exists/);
    expect(await runExternal(store({ visible: false }).request, preflight)).toMatchObject({ uploadNumberFree: true, reviewMetadataChecked: true });
    const missingInfo = store({ visible: false, reviewInfoComplete: false });
    await expect(runExternal(missingInfo.request, preflight)).rejects.toThrow(/review contact/);
    expect(await runExternal(missingInfo.request, { ...preflight, uploadOnly: true })).toMatchObject({ uploadNumberFree: true, reviewMetadataChecked: false });
  });

  it('separates review approval from availability and only sends manual notifications with opt-in', async () => {
    const { request, writes } = store({ member: true, externalState: 'BETA_APPROVED', review: 'APPROVED' });
    expect(await runExternal(request, { ...options, action: 'status' })).toMatchObject({ reviewState: 'APPROVED', availableToExternalGroup: false });
    expect(await runExternal(request, options)).toMatchObject({ notificationMayBeNeeded: true });
    expect(writes).toEqual([]);
    expect(await runExternal(request, { ...options, notifyApproved: true })).toMatchObject({ availableToExternalGroup: true });
    expect(writes.map(([, path]) => path)).toEqual(['/v1/buildBetaNotifications']);
    await runExternal(request, { ...options, notifyApproved: true });
    expect(writes).toHaveLength(1);
  });

  it('does not put the private reviewer URL in tester-facing notes', async () => {
    const { request, writes } = store();
    await expect(runExternal(request, { ...options, notes: 'https://example.test/beta-review/private/' })).rejects.toThrow(/private review links/);
    expect(writes).toEqual([]);
  });
});

it('signs ES256 JWTs with raw JOSE signatures and does not follow off-origin pagination', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const token = makeToken('DEMO123456', 'issuer', privateKey, 1_000);
  const [header, payload, signature] = token.split('.');
  expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'DEMO123456', typ: 'JWT' });
  expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ iss: 'issuer', iat: 1_000, exp: 1_600, aud: 'appstoreconnect-v1' });
  const scoped = JSON.parse(Buffer.from(makeToken('DEMO123456', 'issuer', privateKey, 1_000, 'GET /v1/apps/6829381852?fields%5Bapps%5D=bundleId').split('.')[1], 'base64url').toString());
  expect(scoped.scope).toEqual(['GET /v1/apps/6829381852?fields%5Bapps%5D=bundleId']);
  expect(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
  const request = makeRequest(() => token, () => { throw new Error('Should not send off-origin.'); });
  await expect(request('GET', 'https://example.test/v1/builds')).rejects.toThrow(/Unexpected App Store Connect API URL/);
});

// Apple accepts scope entries only for GET. A PATCH with a scoped token
// failed before the external-group and Beta submission writes ran.
it('scopes read tokens without adding write scopes to mutations', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const token = makeRequestToken('DEMO123456', 'issuer', privateKey);
  const claims = (method, path) => JSON.parse(Buffer.from(token(method, path).split('.')[1], 'base64url').toString());
  expect(claims('GET', buildPath).scope).toEqual([`GET ${buildPath}`]);
  expect(claims('PATCH', '/v1/betaBuildLocalizations/notes-id')).not.toHaveProperty('scope');
  expect(claims('POST', '/v1/betaAppReviewSubmissions')).not.toHaveProperty('scope');
});
