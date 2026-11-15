// Test del connettore LinkedIn Ads con risposte simulate. Uso: node tests/linkedin.js
const { ctx, vm, assert, props, setFetch } = require('./mock');
const calls = [];
let analyticsMode = 'normal';
const el = (y, m, d, camp, extra) => Object.assign({ dateRange: { start: { year: y, month: m, day: d }, end: { year: y, month: m, day: d } },
  pivotValues: [camp ? 'urn:li:sponsoredCampaign:' + camp : 'urn:li:sponsoredAccount:5001'],
  impressions: 2000, clicks: 30, landingPageClicks: 18, costInLocalCurrency: '41.275', externalWebsiteConversions: 2, oneClickLeads: 3,
  conversionValueInLocalCurrency: '0.0', videoViews: 120, totalEngagements: 44 }, extra || {});
setFetch((url, params) => {
  calls.push(url);
  assert.strictEqual(params.headers.Authorization, 'Bearer LI-TOKEN');
  assert.strictEqual(params.headers['Linkedin-Version'], '202610');
  assert.strictEqual(params.headers['X-Restli-Protocol-Version'], '2.0.0');
  const path = url.split('?')[0].replace('https://api.linkedin.com/rest/', ''), qs = url.split('?')[1] || '';
  if (path === 'adAccounts' && qs.includes('q=search')) {
    return qs.includes('pageToken=T2')
      ? { status: 200, body: { elements: [{ id: 5002, name: 'Due', currency: 'USD', status: 'DRAFT' }], metadata: {} } }
      : { status: 200, body: { elements: [{ id: 5001, name: 'Uno', currency: 'EUR', status: 'ACTIVE' }], metadata: { nextPageToken: 'T2' } } };
  }
  if (path === 'adAccounts/5001') return { status: 200, body: { id: 5001, currency: 'EUR' } };
  if (path === 'adAnalytics') {
    assert(qs.includes('accounts=List(urn%3Ali%3AsponsoredAccount%3A5001)'), qs);
    assert(/dateRange=\(start:\(year:2026,month:\d+,day:\d+\),end:\(year:2026,month:\d+,day:\d+\)\)/.test(qs), 'sintassi Rest.li non codificata: ' + qs);
    assert(qs.includes('timeGranularity=DAILY') && qs.includes('fields=dateRange,pivotValues,impressions'));
    if (analyticsMode === 'huge') {
      const m = qs.match(/start:\(year:2026,month:(\d+),day:(\d+)\),end:\(year:2026,month:(\d+),day:(\d+)\)/);
      const single = m[1] === m[3] && m[2] === m[4];
      return { status: 200, body: { elements: single ? [el(2026, +m[1], +m[2], '', {})] : new Array(15000).fill(el(2026, 1, 1, '')) } };
    }
    if (qs.includes('pivot=CAMPAIGN')) return { status: 200, body: { elements: [el(2026, 11, 3, '777'), el(2026, 11, 3, '888'), el(2026, 11, 4, '777')], paging: { links: [] } } };
    assert(qs.includes('pivot=ACCOUNT'));
    return { status: 200, body: { elements: [el(2026, 11, 3, '')] } };
  }
  if (path === 'adAccounts/5001/adCampaigns') {
    assert(qs.includes('search=(id:(values:List(urn%3Ali%3AsponsoredCampaign%3A777,urn%3Ali%3AsponsoredCampaign%3A888)))'), qs);
    return { status: 200, body: { elements: [{ id: 777, name: 'Lead form', objectiveType: 'LEAD_GENERATION' }, { id: 888, name: 'Video', objectiveType: 'VIDEO_VIEWS' }], metadata: {} } };
  }
  if (path === 'adAccountUsers') {
    assert(qs.includes('accounts=urn%3Ali%3AsponsoredAccount%3A5001'));
    return { status: 200, body: { elements: [{ account: 'urn:li:sponsoredAccount:5001', role: 'ACCOUNT_BILLING_ADMIN', user: 'urn:li:person:AAA' }, { role: 'VIEWER', user: 'urn:li:person:BBB' }], paging: { total: 2 } } };
  }
  throw new Error('chiamata inattesa ' + url);
});
props.DL_TOKEN_linkedin_ads = JSON.stringify({ access_token: 'LI-TOKEN', expires_at: Date.now() + 40 * 86400000 });
ctx.setup();

const accounts = JSON.parse(JSON.stringify(ctx.listAccounts('linkedin_ads')));
assert.deepStrictEqual(accounts.map(a => [a.account, a.valuta, a.stato]), [['5001', 'EUR', 'attivo'], ['5002', 'USD', 'bozza']]);

let rows = ctx.getMetrics('linkedin_ads', 'urn:li:sponsoredAccount:5001', { start: '2026-11-01', end: '2026-11-07' }, 'campaign');
assert.strictEqual(rows.length, 3);
const r = rows[0];
assert.strictEqual(r.data, '2026-11-03'); assert.strictEqual(r.campagna_id, '777'); assert.strictEqual(r.campagna, 'Lead form'); assert.strictEqual(r.valuta, 'EUR');
assert.strictEqual(r.impression, 2000); assert.strictEqual(r.clic, 18); assert.strictEqual(r.spesa, 41.275);
assert.strictEqual(r.lead, 3); assert.strictEqual(r.conversioni, 5); assert.strictEqual(r.valore_conversioni, 0);
assert.strictEqual(r.visualizzazioni_video, 120); assert.strictEqual(r.interazioni, 44); assert.strictEqual(r.copertura, undefined);
const before = calls.length;
ctx.getMetrics('linkedin_ads', '5001', { start: '2026-11-01', end: '2026-11-07' }, 'campaign');
assert.strictEqual(calls.length - before, 1, 'campagne e valuta già in memoria: una sola chiamata');

rows = ctx.getMetrics('linkedin_ads', '5001', { start: '2026-11-01', end: '2026-11-07' }, 'account');
assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].campagna_id, '');

// risposta al tetto di 15.000 elementi: l'intervallo viene suddiviso fino al singolo giorno
analyticsMode = 'huge';
rows = ctx.getMetrics('linkedin_ads', '5001', { start: '2026-11-01', end: '2026-11-04' }, 'account');
assert.strictEqual(rows.length, 4); assert.strictEqual(rows.map(x => x.data).join(), '2026-11-01,2026-11-02,2026-11-03,2026-11-04');
analyticsMode = 'normal';

const users = ctx.getAccessUsers('linkedin_ads', '5001');
assert.strictEqual(users.length, 2);
assert.strictEqual(users[0].utente_id, 'AAA'); assert.strictEqual(users[0].ruolo, 'Amministratore fatturazione'); assert.strictEqual(users[1].ruolo, 'Visualizzatore');

const c = vm.runInContext('Connector_linkedin_ads_()', ctx);
assert.strictEqual(c.mapObjective('BRAND_AWARENESS'), 'Awareness'); assert.strictEqual(c.mapObjective('JOB_APPLICANTS'), '');

setFetch(() => ({ status: 403, body: { status: 403, code: 'USER_NOT_AUTHORIZED', message: 'Not enough permissions' } }));
assert.throws(() => ctx.getAccessUsers('linkedin_ads', '5001'), e => e.kind === 'HTTP' && /USER_NOT_AUTHORIZED/.test(e.message));
console.log('TEST LINKEDIN SUPERATI');
