// Test dello strato comune con un connettore finto. Uso: node tests/run.js
const { ctx, vm, assert, files, props, clock, mails, triggers, setFetch } = require('./mock');
// Connettore finto: API con paginazione "nextUrl", un 429 iniziale, ID a 19 cifre.
const ACCOUNT = '7300000000000000123';
let throttleOnce = true, apiCalls = [];
vm.runInContext(`
function Connector_meta_ads_() {
  return {
    label: 'Meta Ads (finto)', auth: 'meta', chunkDays: 4, lookbackDays: 3,
    defaultMappings: [['impressions','impression'],['clicks','clic'],['spend_micros','spesa','div:1000000'],['lead_a','lead'],['lead_b','lead']],
    mapObjective: function (n) { return n === 'OUTCOME_LEADS' ? 'Lead Generation' : ''; },
    listAccounts: function () { return [{ account: '${ACCOUNT}', nome: 'Test' }]; },
    getMetrics: function (account, range, level) {
      return dl_paginate_({ url: 'https://api.test/insights', auth: 'meta', query: { account: account, since: range.start, until: range.end, level: level } },
        dl_pager_.nextUrl('data', 'paging.next'));
    },
    getAccessUsers: function () { return dl_unsupported_('Non esposto dall\\'API finta.'); }
  };
}`, ctx);
const days = (a, b) => { const o = []; for (let d = a; d <= b; d = ctx.dl_addDays_(d, 1)) o.push(d); return o; };
let fetchHandler; setFetch((u, p) => fetchHandler(u, p));
fetchHandler = (url, params) => {
  apiCalls.push(url);
  if (url.includes('debug_token')) return { status: 200, body: { data: { is_valid: true, expires_at: 0 } } };
  if (url.includes('linkedin.com/oauth')) return { status: 200, body: { access_token: 'li-new', expires_in: 5184000, refresh_token: 'r2' } };
  assert.strictEqual(params.headers.Authorization, 'Bearer meta-secret-token');
  if (throttleOnce) { throttleOnce = false; return { status: 429, headers: { 'Retry-After': '1' }, body: { error: 'slow down' } }; }
  const q = Object.fromEntries(new URL(url).searchParams);
  const all = [];
  days(q.since, q.until).forEach(d => (q.level === 'campaign' ? ['c1', 'c2'] : ['']).forEach(c => all.push({
    data: d, campagna_id: c ? '120200000000000' + c.slice(1) + '99' : '', campagna: c && 'Campagna ' + c, obiettivo_nativo: c && 'OUTCOME_LEADS', valuta: 'EUR',
    metriche: { impressions: '1000', clicks: 10, spend_micros: 12340000, lead_a: 1, lead_b: 2, ignota: 5 } })));
  const page = +(q.p || 0), size = 3;
  const next = (page + 1) * size < all.length ? `https://api.test/insights?account=${q.account}&since=${q.since}&until=${q.until}&level=${q.level}&p=${page + 1}` : undefined;
  return { status: 200, body: { data: all.slice(page * size, (page + 1) * size), paging: { next } } };
};

const sheet = n => files[props.DL_CONFIG_SPREADSHEET_ID].getSheetByName(n);
const objs = sh => vm.runInContext('dl_readObjects_', ctx)(sh);
const reset = () => vm.runInContext('DL_MEM_ = { calls: 0, logs: [] };', ctx);
const metrics = () => objs(Object.values(files).find(f => f.name.includes('metriche')).getSheetByName('metriche'));
const today = ctx.dl_today_ ? null : null;

// 1. setup
ctx.setup(); ctx.setup();
assert.deepStrictEqual(files[props.DL_CONFIG_SPREADSHEET_ID].sheets.map(s => s.name).sort(), ['accessi', 'campagne', 'config', 'impostazioni', 'log', 'mappa_metriche', 'stato']);
assert(objs(sheet('config')).length === 0 && sheet('config').d[0].includes('meta_ads_account'));
assert.strictEqual(objs(sheet('mappa_metriche')).length, 5, 'mappatura non duplicata al secondo setup');
props.DL_TOKEN_meta = 'meta-secret-token';
const T = vm.runInContext('dl_today_()', ctx), add = (d, n) => ctx.dl_addDays_(d, n);
const hdr = sheet('config').d[0];
const row = h => hdr.map(x => h[x] === undefined ? '' : h[x]);
sheet('config').d.push(row({ cliente: 'Cliente A', attivo: 'sì', inizio_storico: add(T, -10), meta_ads_account: ACCOUNT }));
sheet('config').d.push(row({ cliente: 'Spento', attivo: '', meta_ads_account: '1' }));

// 2. prima esecuzione: 10 giorni, retry su 429, paginazione
reset();
let r = ctx.run();
assert.strictEqual(r.errori, 0); assert.strictEqual(r.sospeso, false); assert.strictEqual(r.lavori, 3);
let m = metrics();
assert.strictEqual(m.filter(x => x.livello === 'account').length, 10);
assert.strictEqual(m.filter(x => x.livello === 'campaign').length, 20);
assert(clock.slept >= 1000, 'attesa dopo 429');
const one = m.find(x => x.livello === 'campaign');
assert.strictEqual(one.account, ACCOUNT, 'ID lungo conservato come testo');
assert.strictEqual(one.impression, 1000); assert.strictEqual(one.spesa, 12.34); assert.strictEqual(one.lead, 3);
assert.strictEqual(one.conversioni, '', 'metrica non fornita resta vuota');
assert.strictEqual(one.tipo, 'paid');
const camp = objs(sheet('campagne'));
assert.strictEqual(camp.length, 2); assert.strictEqual(camp[0].obiettivo, 'Lead Generation');
const acc = objs(sheet('accessi'));
assert.strictEqual(acc.length, 1); assert.strictEqual(acc[0].ruolo, 'NON DISPONIBILE VIA API');
assert(objs(sheet('log')).some(l => l.lavoro === 'accessi' && l.esito === 'non_supportato'));
assert.strictEqual(triggers.length, 0);

// 3. stessa giornata: niente da fare
reset(); apiCalls = [];
r = ctx.run();
assert.strictEqual(r.lavori, 0); assert.strictEqual(apiCalls.length, 0);

// 4. giorno dopo: solo finestra di ricalcolo (3 giorni), nessun duplicato, classificazione manuale conservata
const st = sheet('stato'), sh = st.d[0];
st.d.slice(1).forEach(x => { x[sh.indexOf('ultimo_run')] = add(T, -1) + ' 09:00:00'; if (x[sh.indexOf('completato_fino_al')]) x[sh.indexOf('completato_fino_al')] = add(T, -2); });
const cs = sheet('campagne'), ch = cs.d[0];
cs.d[1][ch.indexOf('obiettivo')] = 'Vendite'; cs.d[1][ch.indexOf('blocco_manuale')] = 'x'; cs.d[1][ch.indexOf('segmento')] = 'B2B';
reset(); apiCalls = [];
r = ctx.run();
assert.strictEqual(r.lavori, 2, 'accessi non ripetuti prima di 7 giorni');
assert(apiCalls.every(u => u.includes('since=' + add(T, -3))), 'scarica solo la finestra di ricalcolo');
m = metrics();
assert.strictEqual(m.length, 30, 'nessun duplicato dopo il ricalcolo');
assert.strictEqual(new Set(m.map(x => [ctx.dl_ymd_(x.data), x.livello, x.campagna_id].join('|'))).size, 30);
assert.strictEqual(objs(cs)[0].obiettivo, 'Vendite'); assert.strictEqual(objs(cs)[0].segmento, 'B2B');

// 5. limite di tempo: si ferma, programma la ripresa, poi completa
sheet('config').d.push(row({ cliente: 'Cliente B', attivo: true, inizio_storico: add(T, -40), meta_ads_account: '555' }));
clock.perCall = 20000; reset();
r = ctx.run();
assert.strictEqual(r.sospeso, true); assert.strictEqual(triggers.length, 1); assert.strictEqual(triggers[0].fn, 'run');
const partial = metrics().filter(x => x.cliente === 'Cliente B').length;
assert(partial > 0 && partial < 120, 'scrittura parziale: ' + partial);
clock.perCall = 0;
for (let i = 0; i < 5 && r.sospeso !== false || i === 0; i++) { reset(); r = ctx.run(); }
assert.strictEqual(r.sospeso, false); assert.strictEqual(triggers.length, 0, 'ripresa rimossa');
m = metrics().filter(x => x.cliente === 'Cliente B');
assert.strictEqual(m.length, 120, 'storico completo dopo la ripresa: ' + m.length);
assert.strictEqual(new Set(m.map(x => [ctx.dl_ymd_(x.data), x.livello, x.campagna_id].join('|'))).size, 120);

// 6. errore API: registrato, gli altri lavori proseguono, sospensione dopo 3 errori
const realHandler = fetchHandler;
fetchHandler = (u, p) => u.includes('account=555') ? { status: 400, body: { error: { message: 'bad access_token=abc123' } } } : realHandler(u, p);
st.d.slice(1).forEach(x => { x[sh.indexOf('ultimo_run')] = add(T, -1) + ' 09:00:00'; });
for (let i = 0; i < 4; i++) { reset(); r = ctx.run(); }
const errs = objs(sheet('log')).filter(l => l.esito === 'errore' && l.cliente === 'Cliente B');
assert.strictEqual(errs.length, 6, 'due lavori × tre tentativi, poi sospesi: ' + errs.length);
assert(!errs[0].messaggio.includes('abc123'), 'token oscurato nel log');
assert(objs(st).filter(s => s.cliente === 'Cliente A').every(s => s.ultimo_esito !== 'errore'));
fetchHandler = realHandler;

// 7. token: rinnovo automatico e avviso
props.DL_CRED_linkedin_ads = JSON.stringify({ client_id: 'a', client_secret: 'b' });
props.DL_TOKEN_linkedin_ads = JSON.stringify({ access_token: 'li-old', expires_at: Date.now() + 86400000, refresh_token: 'r1', refresh_expires_at: Date.now() + 10 * 86400000 });
reset();
assert.strictEqual(vm.runInContext("dl_accessToken_('linkedin_ads')", ctx), 'li-new');
assert.strictEqual(JSON.parse(props.DL_TOKEN_linkedin_ads).refresh_token, 'r2');
ctx.checkTokens(); ctx.checkTokens();
assert.strictEqual(mails.length, 1, 'un solo avviso al giorno'); assert(mails[0].s.includes('LinkedIn Ads'));
assert(!JSON.stringify(mails).includes('li-new'));
props.DL_TOKEN_tiktok = JSON.stringify({ access_token: 'x', expires_at: Date.now() - 1000 });
assert.throws(() => vm.runInContext("dl_accessToken_('tiktok')", ctx), e => e.kind === 'AUTH');

// 8. API pubblica
reset();
assert.strictEqual(ctx.getMetrics('meta_ads', ACCOUNT, { start: add(T, -5), end: add(T, -1) }, 'account').length, 5);
assert.strictEqual(ctx.getAccessUsers('meta_ads', ACCOUNT).supported, false);
assert.strictEqual(ctx.readMetrics({ cliente: 'Cliente A', dal: add(T, -3), al: T, livello: 'account' }).length, 3);
assert.strictEqual(ctx.readAccess('Cliente A').length, 1);
assert.strictEqual(ctx.getClients().length, 2);
console.log('TUTTI I TEST SUPERATI');
