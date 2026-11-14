/**
 * Livello dati — costanti, errori, date.
 *
 * Convenzione: le funzioni che finiscono con "_" sono interne (non visibili a
 * chi usa il progetto come libreria). Le funzioni pubbliche stanno in Api.gs.
 */

var DL_VERSION = '0.1.0';

/** Chiavi delle Script Properties. Nessun segreto sta altrove. */
var DL_PROP = {
  CONFIG_SS: 'DL_CONFIG_SPREADSHEET_ID',
  TOKEN: 'DL_TOKEN_',        // + authId  -> JSON {access_token, expires_at, refresh_token, refresh_expires_at}
  CRED: 'DL_CRED_',          // + authId  -> JSON {client_id, client_secret}
  ALERT: 'DL_ALERT_',        // + authId  -> data dell'ultimo avviso inviato
  CONT_TRIGGER: 'DL_CONT_TRIGGER'
};

var DL_SHEET = {
  CONFIG: 'config',
  CAMPAGNE: 'campagne',
  METRICHE: 'metriche',
  ACCESSI: 'accessi',
  MAPPA: 'mappa_metriche',
  IMPOSTAZIONI: 'impostazioni',
  STATO: 'stato',
  LOG: 'log'
};

/** Colonne metriche normalizzate: stessi nomi e stesse unità per ogni piattaforma. */
var DL_METRIC_COLS = [
  'impression', 'copertura', 'clic', 'spesa', 'conversioni', 'valore_conversioni',
  'lead', 'acquisti', 'visualizzazioni_video', 'interazioni', 'sessioni', 'utenti',
  'follower', 'posizione_media'
];

/** Le prime 7 colonne di "metriche" sono la chiave: non cambiarne l'ordine. */
var DL_METRICHE_KEY_COLS = 7;

var DL_HEADERS = {
  config: ['cliente', 'attivo', 'obiettivi', 'kpi_principali', 'kpi_secondari', 'inizio_storico'],
  campagne: ['cliente', 'piattaforma', 'account', 'campagna_id', 'campagna', 'obiettivo_nativo',
    'obiettivo', 'segmento', 'blocco_manuale', 'aggiornato_il'],
  metriche: ['data', 'cliente', 'piattaforma', 'account', 'livello', 'campagna_id', 'tipo',
    'campagna', 'valuta'].concat(DL_METRIC_COLS).concat(['scaricato_il']),
  accessi: ['cliente', 'piattaforma', 'account', 'data_rilevazione', 'utente', 'utente_id',
    'ruolo_nativo', 'ruolo', 'nota'],
  mappa_metriche: ['piattaforma', 'nome_nativo', 'nome_normalizzato', 'trasformazione'],
  impostazioni: ['chiave', 'valore', 'descrizione'],
  stato: ['chiave', 'cliente', 'piattaforma', 'account', 'lavoro', 'completato_fino_al',
    'ultimo_run', 'ultimo_esito', 'errori_consecutivi', 'messaggio'],
  log: ['quando', 'lavoro', 'cliente', 'piattaforma', 'account', 'esito', 'righe', 'chiamate',
    'durata_ms', 'messaggio']
};

/** Colonne da tenere come testo: gli ID lunghi perdono cifre se diventano numeri. */
var DL_TEXT_COLS = ['account', 'campagna_id', 'utente_id', 'chiave', 'cliente'];
var DL_DATE_COLS = ['data', 'data_rilevazione', 'completato_fino_al', 'inizio_storico'];

var DL_OBIETTIVI = ['Awareness', 'Interazioni', 'Lead Generation', 'Drive to Store', 'Vendite'];

/** Memoria della singola esecuzione (cache di fogli, impostazioni, contatori). */
var DL_MEM_ = { calls: 0, logs: [] };

/* ---------- Errori ---------- */

/**
 * Tipi: AUTH (serve intervento sul token), DEADLINE (tempo finito, si riprende),
 * HTTP (errore API non recuperabile), CONFIG (configurazione mancante).
 */
function dl_error_(kind, message, extra) {
  var e = new Error(message);
  e.kind = kind;
  if (extra) for (var k in extra) e[k] = extra[k];
  return e;
}

/* ---------- Date (sempre stringhe yyyy-MM-dd) ---------- */

function dl_tz_() {
  if (!DL_MEM_.tz) {
    try { DL_MEM_.tz = dl_configSs_().getSpreadsheetTimeZone(); } catch (e) { DL_MEM_.tz = Session.getScriptTimeZone(); }
  }
  return DL_MEM_.tz;
}

function dl_isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]'; }

function dl_ymd_(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (dl_isDate_(v)) return Utilities.formatDate(v, dl_tz_(), 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}

function dl_today_() { return Utilities.formatDate(new Date(), dl_tz_(), 'yyyy-MM-dd'); }

function dl_now_() { return Utilities.formatDate(new Date(), dl_tz_(), 'yyyy-MM-dd HH:mm:ss'); }

function dl_addDays_(ymd, n) {
  var p = ymd.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)).toISOString().slice(0, 10);
}

function dl_daysBetween_(a, b) {
  var pa = a.split('-'), pb = b.split('-');
  return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
}

/** Divide [start, end] in blocchi di al più `size` giorni. */
function dl_chunks_(start, end, size) {
  var out = [];
  var s = start;
  while (s <= end) {
    var e = dl_addDays_(s, size - 1);
    if (e > end) e = end;
    out.push({ start: s, end: e });
    s = dl_addDays_(e, 1);
  }
  return out;
}

function dl_truthy_(v) {
  if (v === true) return true;
  var s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  return s === 'true' || s === 'si' || s === 'sì' || s === 'x' || s === '1' || s === 'yes' || s === 'vero';
}
