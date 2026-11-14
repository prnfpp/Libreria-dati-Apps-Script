// Test del connettore Meta Ads con risposte Graph API simulate. Uso: node tests/meta.js
const { ctx, vm, assert, files, props, clock, setFetch } = require('./mock');
const calls = [];
let throttled = false;
const day = (d, camp) => Object.assign({ date_start: d, date_stop: d, account_currency: 'EUR', impressions: '1500', reach: '900', clicks: '80',
  inline_link_clicks: '40', inline_post_engagement: '55', spend: '25.50',
  actions: [{ action_type: 'lead', value: '3' }, { action_type: 'purchase', value: '2' }, { action_type: 'video_view', value: '300' }, { action_type: 'link_click', value: '40' }],
  action_values: [{ action_type: 'purchase', value: '180.40' }] },
  camp ? { campaign_id: '120210000000000' + camp, campaign_name: 'Camp ' + camp, objective: camp === '1' ? 'OUTCOME_LEADS' : 'OUTCOME_SALES' } : {});
setFetch((url, params) => {
  calls.push(url);
  const u = new URL(url), q = Object.fromEntries(u.searchParams);
  assert.strictEqual(params.headers.Authorization, 'Bearer SYS-TOKEN');
  assert(u.pathname.startsWith('/v26.0/'), u.pathname);
  if (u.pathname.endsWith('/me/adaccounts')) return { status: 200, body: { data: [{ account_id: '1234567890123456', name: 'Cliente A', currency: 'EUR', timezone_name: 'Europe/Rome', account_status: 1 }] } };
  if (u.pathname.endsWith('/insights')) {
    assert(u.pathname.includes('/act_1234567890123456/'));
    assert.strictEqual(q.time_increment, '1'); assert.strictEqual(q.use_unified_attribution_setting, 'true');
    const tr = JSON.parse(q.time_range);
    if (!throttled) { throttled = true; return { status: 400, headers: { 'x-business-use-case-usage': JSON.stringify({ 1: [{ estimated_time_to_regain_access: 1 }] }) }, body: { error: { code: 80000, message: 'too many calls', error_subcode: 2446079 } } }; }
    if (q.after) return { status: 200, body: { data: [day(tr.until, q.level === 'campaign' ? '2' : '')], paging: {} } };
    return { status: 200, body: { data: [day(tr.since, q.level === 'campaign' ? '1' : '')], paging: { next: url + '&after=X' } } };
  }
  if (u.pathname.endsWith('/business_users')) return { status: 200, body: { data: [{ id: 'u1', name: 'Utente Uno', email: 'utente@example.com', role: 'ADMIN' }] } };
  if (u.pathname.endsWith('/assigned_users')) { assert.strictEqual(q.business, '999'); return { status: 200, body: { data: [{ id: 'u1', name: 'Utente Uno', tasks: ['MANAGE', 'ADVERTISE', 'ANALYZE'] }, { id: 's1', name: 'API Agenzia', tasks: ['ANALYZE'] }] } }; }
  throw new Error('chiamata inattesa ' + url);
});
props.DL_TOKEN_meta = 'SYS-TOKEN';
ctx.setup();
const cfg = files[props.DL_CONFIG_SPREADSHEET_ID];
assert(cfg.getSheetByName('config').d[0].includes('meta_ads_account'));
assert(cfg.getSheetByName('impostazioni').d.some(r => r[0] === 'meta_business_id'));

assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.listAccounts('meta_ads'))), [{ account: '1234567890123456', nome: 'Cliente A', valuta: 'EUR', fuso: 'Europe/Rome', stato: 'attivo' }]);

let rows = ctx.getMetrics('meta_ads', '1234567890123456', { start: '2026-11-01', end: '2026-11-05' }, 'campaign');
assert.strictEqual(rows.length, 2);
assert(clock.slept >= 60000, 'attesa indicata da Meta dopo il limite di frequenza');
const r = rows[0];
assert.strictEqual(r.data, '2026-11-01'); assert.strictEqual(r.campagna_id, '1202100000000001'); assert.strictEqual(r.valuta, 'EUR');
assert.strictEqual(r.impression, 1500); assert.strictEqual(r.copertura, 900); assert.strictEqual(r.clic, 40, 'clic = clic sul link');
assert.strictEqual(r.spesa, 25.5); assert.strictEqual(r.lead, 3); assert.strictEqual(r.acquisti, 2);
assert.strictEqual(r.conversioni, 5, 'lead + acquisti'); assert.strictEqual(r.valore_conversioni, 180.4);
assert.strictEqual(r.visualizzazioni_video, 300); assert.strictEqual(r.interazioni, 55);
rows = ctx.getMetrics('meta_ads', 'act_1234567890123456', { start: '2026-11-01', end: '2026-11-02' }, 'account');
assert.strictEqual(rows[0].campagna_id, '');

// utenti: senza business id dichiara il motivo, con business id unisce le email
let acc = ctx.getAccessUsers('meta_ads', '1234567890123456');
assert.strictEqual(acc.supported, false);
vm.runInContext("dl_setSetting_('meta_business_id', '999')", ctx);
acc = ctx.getAccessUsers('meta_ads', '1234567890123456');
assert.strictEqual(acc.length, 2);
assert.strictEqual(acc[0].utente, 'utente@example.com'); assert.strictEqual(acc[0].ruolo, 'Amministratore');
assert.strictEqual(acc[1].utente, 'API Agenzia'); assert.strictEqual(acc[1].ruolo, 'Analista');

// errori: token non valido -> AUTH, permesso mancante -> HTTP non ritentato
setFetch(() => ({ status: 400, body: { error: { code: 190, message: 'Invalid OAuth access token' } } }));
assert.throws(() => ctx.listAccounts('meta_ads'), e => e.kind === 'AUTH');
let n = 0;
setFetch(() => { n++; return { status: 400, body: { error: { code: 200, message: 'Permissions error' } } }; });
assert.throws(() => ctx.listAccounts('meta_ads'), e => e.kind === 'HTTP' && /Meta 200/.test(e.message));
assert.strictEqual(n, 1);

// giro completo dal foglio config
const c = vm.runInContext('Connector_meta_ads_()', ctx);
assert.strictEqual(c.mapObjective('OUTCOME_SALES'), 'Vendite'); assert.strictEqual(c.mapObjective('STORE_VISITS'), 'Drive to Store');
console.log('TEST META SUPERATI');
