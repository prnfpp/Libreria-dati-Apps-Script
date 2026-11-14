// Servizi Apps Script simulati, condivisi dai test.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.join(__dirname, '..');
const clock = { offset: 0 };
const mails = [], triggers = [], props = {}, files = {};
let fetchHandler = () => { throw new Error('no handler'); };
const setFetch = f => { fetchHandler = f; };

class Sheet {
  constructor(name) { this.name = name; this.d = []; this.maxR = 1000; this.maxC = 26; this.fmt = {}; }
  getLastRow() { for (let i = this.d.length - 1; i >= 0; i--) if (this.d[i].some(v => v !== '' && v != null)) return i + 1; return 0; }
  getLastColumn() { let m = 0; this.d.forEach(r => r.forEach((v, i) => { if (v !== '' && v != null) m = Math.max(m, i + 1); })); return m; }
  getMaxRows() { return this.maxR; } getMaxColumns() { return this.maxC; }
  insertRowsAfter(_, n) { this.maxR += n; } insertColumnsAfter(_, n) { this.maxC += n; }
  deleteColumns(_, n) { this.maxC -= n; }
  deleteRows(r, n) { assert(r >= 2); assert(this.maxR - n >= 2, 'non si può cancellare tutte le righe'); this.d.splice(r - 1, n); this.maxR -= n; }
  setFrozenRows() {}
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    assert(r + nr - 1 <= sh.maxR && c + nc - 1 <= sh.maxC, `range fuori griglia ${sh.name} ${r},${c},${nr},${nc} max ${sh.maxR}x${sh.maxC}`);
    return {
      getValues() { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (sh.d[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } o.push(row); } return o; },
      setValues(v) { assert.strictEqual(v.length, nr); v.forEach((row, i) => { assert.strictEqual(row.length, nc); while (sh.d.length < r + i) sh.d.push([]); row.forEach((x, j) => { sh.d[r - 1 + i][c - 1 + j] = x; }); }); return this; },
      clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (sh.d[r - 1 + i]) sh.d[r - 1 + i][c - 1 + j] = ''; return this; },
      setNumberFormat(f) { sh.fmt[c] = f; return this; }
    };
  }
}
class SS {
  constructor(name) { this.id = 'ss' + (Object.keys(files).length + 1); this.name = name; this.sheets = [new Sheet('Foglio1')]; files[this.id] = this; }
  getId() { return this.id; } getUrl() { return 'https://sheets/' + this.id; }
  getSpreadsheetTimeZone() { return 'Europe/Rome'; } setSpreadsheetTimeZone() {}
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; } deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
}
const fmt = (d, tz, f) => { const p = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' }).format(d); return f.length === 10 ? p.slice(0, 10) : p; };
const ctx = {
  console, JSON, Math, Object, Array, String, Number, Error, encodeURIComponent, isNaN,
  SpreadsheetApp: { openById: id => files[id], create: n => new SS(n) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
  Utilities: { formatDate: fmt, sleep: ms => { clock.offset += ms; clock.slept = (clock.slept || 0) + ms; } },
  Session: { getScriptTimeZone: () => 'Europe/Rome', getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) },
  MailApp: { sendEmail: (to, s, b) => mails.push({ to, s, b }) },
  ScriptApp: {
    getOAuthToken: () => 'google-token', getScriptId: () => 'SCRIPT',
    getProjectTriggers: () => triggers.slice(), deleteTrigger: t => triggers.splice(triggers.indexOf(t), 1),
    newTrigger: fn => { const t = { fn, id: 't' + Math.random(), getUniqueId() { return this.id; }, getHandlerFunction() { return fn; } }; const b = { timeBased: () => b, after: () => b, everyHours: () => b, everyDays: () => b, atHour: () => b, create: () => { triggers.push(t); return t; } }; return b; }
  },
  UrlFetchApp: { fetch: (url, params) => { clock.offset += clock.perCall || 0; const r = fetchHandler(url, params || {}); return { getResponseCode: () => r.status, getHeaders: () => r.headers || {}, getContentText: () => typeof r.body === 'string' ? r.body : JSON.stringify(r.body) }; } },
  HtmlService: { createHtmlOutput: s => s }
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var __now = Date.now; ', ctx);
ctx.__offset = () => clock.offset;
vm.runInContext('Date.now = function () { return __now() + __offset(); };', ctx);
fs.readdirSync(root).filter(f => f.endsWith('.gs')).forEach(f => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f }));

module.exports = { ctx, vm, assert, files, props, clock, mails, triggers, setFetch };
