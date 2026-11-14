/**
 * Registro dei connettori e contratto comune.
 *
 * Ogni connettore è un file Connector_<id>.gs con una funzione
 *   function Connector_<id>_() { return { ...definizione... }; }
 *
 * Definizione:
 *   label           nome leggibile
 *   tipo            'paid' | 'organico' | 'web' | 'ricerca'
 *   configColumn    colonna di "config" con gli ID account (default: <id>_account)
 *   auth            id del provider in Auth.gs
 *   levels          livelli supportati, es. ['account', 'campaign']
 *   chunkDays       giorni massimi per richiesta (default 30)
 *   lookbackDays    finestra di ricalcolo predefinita (default 7)
 *   delayDays       ritardo dei dati: 1 = fino a ieri (default 1)
 *   defaultMappings [[nome_nativo, nome_normalizzato, trasformazione], ...]
 *   settings        [[chiave, valore_predefinito, descrizione], ...]  aggiunte a "impostazioni"
 *   mapObjective    fn(obiettivo_nativo) -> uno dei cinque obiettivi, o ''
 *
 *   listAccounts()                               -> [{account, nome, valuta, fuso, stato}]
 *   getMetrics(account, {start, end}, livello)   -> righe native: {data, campagna_id, campagna,
 *                                                   obiettivo_nativo, valuta, metriche: {nativo: valore}}
 *   getAccessUsers(account)                      -> [{utente, utente_id, ruolo_nativo, ruolo}]
 *
 * Una funzione non disponibile via API restituisce dl_unsupported_('motivo').
 */

var DL_CONNECTOR_IDS_ = [
  'meta_ads', 'meta_organico', 'linkedin_ads', 'linkedin_organico',
  'ga4', 'search_console', 'google_ads', 'tiktok_ads', 'tiktok_organico'
];

function dl_unsupported_(reason) {
  return { supported: false, reason: reason };
}

function dl_isUnsupported_(v) {
  return !!v && !Array.isArray(v) && v.supported === false;
}

function dl_connectors_() {
  if (DL_MEM_.connectors) return DL_MEM_.connectors;
  var out = {};
  DL_CONNECTOR_IDS_.forEach(function (id) {
    var factory = globalThis['Connector_' + id + '_'];
    if (typeof factory !== 'function') return;          // connettore non ancora presente
    var c = factory();
    ['listAccounts', 'getMetrics', 'getAccessUsers'].forEach(function (fn) {
      if (typeof c[fn] !== 'function') throw dl_error_('CONFIG', 'Connettore ' + id + ': manca ' + fn + '().');
    });
    c.id = id;
    c.label = c.label || id;
    c.tipo = c.tipo || 'paid';
    c.configColumn = c.configColumn || id + '_account';
    c.levels = c.levels || ['account', 'campaign'];
    c.chunkDays = c.chunkDays || 30;
    c.lookbackDays = c.lookbackDays === undefined ? 7 : c.lookbackDays;
    c.delayDays = c.delayDays === undefined ? 1 : c.delayDays;
    out[id] = c;
  });
  DL_MEM_.connectors = out;
  return out;
}

function dl_connector_(id) {
  var c = dl_connectors_()[id];
  if (!c) throw dl_error_('CONFIG', 'Connettore sconosciuto o non installato: ' + id);
  return c;
}

/* ---------- Normalizzazione ---------- */

/** Mappa {piattaforma: {nome_nativo: [{col, op, n}]}} letta dal foglio "mappa_metriche". */
function dl_mappa_() {
  if (DL_MEM_.mappa) return DL_MEM_.mappa;
  var out = {};
  var sh = dl_configSs_().getSheetByName(DL_SHEET.MAPPA);
  var rows = sh ? dl_readObjects_(sh) : [];
  rows.forEach(function (r) {
    var col = String(r.nome_normalizzato).trim();
    if (!r.piattaforma || !r.nome_nativo || DL_METRIC_COLS.indexOf(col) === -1) return;
    var t = String(r.trasformazione || '').trim().split(':');
    var plat = out[r.piattaforma] = out[r.piattaforma] || {};
    var nat = String(r.nome_nativo).trim();
    (plat[nat] = plat[nat] || []).push({ col: col, op: t[0] || '', n: Number(t[1]) || 1 });
  });
  DL_MEM_.mappa = out;
  return out;
}

/**
 * Converte le metriche native in colonne normalizzate.
 * Più nomi nativi sulla stessa colonna vengono sommati; lo stesso nome nativo può
 * alimentare più colonne (una riga di mappatura per colonna). Trasformazioni: "div:N", "mul:N".
 * Le colonne non fornite dalla piattaforma restano vuote (non zero).
 */
function dl_normalize_(connectorId, native) {
  var map = dl_mappa_()[connectorId] || {};
  var out = {};
  Object.keys(native || {}).forEach(function (k) {
    var raw = Number(native[k]);
    if (!map[k] || native[k] === '' || native[k] === null || native[k] === undefined || isNaN(raw)) return;
    map[k].forEach(function (m) {
      var v = m.op === 'div' ? raw / m.n : (m.op === 'mul' ? raw * m.n : raw);
      out[m.col] = (out[m.col] || 0) + v;
    });
  });
  return out;
}

/** Riga del foglio "metriche" a partire da una riga nativa del connettore. */
function dl_metricRow_(connector, cliente, account, livello, r) {
  var row = {
    data: dl_ymd_(r.data), cliente: cliente, piattaforma: connector.id, account: String(account),
    livello: livello, campagna_id: r.campagna_id === undefined ? '' : String(r.campagna_id),
    tipo: connector.tipo, campagna: r.campagna || '', valuta: r.valuta || '', scaricato_il: dl_now_()
  };
  var n = dl_normalize_(connector.id, r.metriche);
  for (var k in n) row[k] = Math.round(n[k] * 1e6) / 1e6;
  return row;
}
