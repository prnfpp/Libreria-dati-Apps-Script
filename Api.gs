/**
 * Funzioni pubbliche. Sono le uniche che i tre strumenti (mappatura privacy,
 * reportistica, forecast) devono chiamare: DataLayer.<funzione>(...).
 */

/* ---------- Installazione e manutenzione (da eseguire nell'editor di questo progetto) ---------- */

/** Crea file, fogli e valori predefiniti. Rieseguibile. Restituisce l'URL del file di configurazione. */
function setup() { var url = dl_setup_(); console.log(url); return url; }

/** Aggiornamento incrementale di tutti i clienti attivi. È la funzione collegata al trigger orario. */
function run() { return dl_run_(); }

/** Controllo scadenze dei token con avviso via mail. È la funzione collegata al trigger giornaliero. */
function checkTokens() { return dl_checkTokens_(); }

/** Installa i trigger: aggiornamento ogni ora, controllo token ogni giorno alle 8. */
function installTriggers() { dl_installTriggers_(); }

/** Link da aprire nel browser per autorizzare una piattaforma OAuth (linkedin_ads, linkedin_community, tiktok). */
function getAuthorizationUrl(authId) { var url = dl_authorizationUrl_(authId); console.log(url); return url; }

/** URL di reindirizzamento da registrare nelle app LinkedIn e TikTok. */
function getRedirectUri() { var u = dl_redirectUri_(); console.log(u); return u; }

/** Destinazione del reindirizzamento OAuth: non chiamare a mano. */
function authCallback(request) { return dl_authCallback_(request); }

/** Stato dei token senza mostrarne il valore. */
function getTokenStatus() { var s = dl_tokenStatus_(); console.log(JSON.stringify(s, null, 2)); return s; }

/* ---------- Connettori: stessa firma per ogni piattaforma ---------- */

/** Piattaforme disponibili e cosa supporta ciascuna. */
function getConnectors() {
  var c = dl_connectors_();
  return Object.keys(c).map(function (id) {
    return { id: id, label: c[id].label, tipo: c[id].tipo, livelli: c[id].levels, colonna_config: c[id].configColumn };
  });
}

/**
 * Account o proprietà raggiungibili con le credenziali configurate.
 * @param {string} connectorId  es. 'meta_ads'
 * @return {Array<{account, nome, valuta, fuso, stato}>|{supported:false, reason:string}}
 */
function listAccounts(connectorId) { return dl_connector_(connectorId).listAccounts(); }

/**
 * Metriche normalizzate scaricate in diretta dall'API (non passa dai fogli).
 * @param {string} connectorId
 * @param {string} account
 * @param {{start:string, end:string}} range  date yyyy-MM-dd incluse
 * @param {string} livello  'account' | 'campaign'
 * @return {Array<Object>|{supported:false, reason:string}}  righe con le colonne del foglio "metriche"
 */
function getMetrics(connectorId, account, range, livello) {
  var conn = dl_connector_(connectorId);
  livello = livello || 'account';
  if (conn.levels.indexOf(livello) === -1) return dl_unsupported_(conn.label + ' non espone il livello "' + livello + '".');
  var out = [];
  var chunks = dl_chunks_(range.start, range.end, conn.chunkDays);
  for (var i = 0; i < chunks.length; i++) {
    var res = conn.getMetrics(account, chunks[i], livello);
    if (dl_isUnsupported_(res)) return res;
    (res || []).forEach(function (r) { out.push(dl_metricRow_(conn, '', account, livello, r)); });
  }
  return out;
}

/**
 * Utenti con accesso all'account e relativo ruolo.
 * @return {Array<{utente, utente_id, ruolo_nativo, ruolo}>|{supported:false, reason:string}}
 */
function getAccessUsers(connectorId, account) { return dl_connector_(connectorId).getAccessUsers(account); }

/* ---------- Lettura dei dati già scaricati ---------- */

/** Clienti attivi con i rispettivi account per piattaforma. */
function getClients() {
  return dl_clients_().map(function (c) {
    return { cliente: c.cliente, accounts: c.accounts, obiettivi: c.riga.obiettivi,
      kpi_principali: c.riga.kpi_principali, kpi_secondari: c.riga.kpi_secondari };
  });
}

/**
 * Righe del foglio "metriche".
 * @param {{cliente?:string, piattaforma?:string, livello?:string, dal:string, al:string}} f
 */
function readMetrics(f) {
  var out = [];
  for (var y = +f.dal.slice(0, 4); y <= +f.al.slice(0, 4); y++) {
    if (!dl_settings_()['metriche_file_' + y]) continue;
    dl_readObjects_(dl_metricsSheet_(y)).forEach(function (r) {
      r.data = dl_ymd_(r.data);
      if (r.data < f.dal || r.data > f.al) return;
      if (f.cliente && r.cliente !== f.cliente) return;
      if (f.piattaforma && r.piattaforma !== f.piattaforma) return;
      if (f.livello && r.livello !== f.livello) return;
      out.push(r);
    });
  }
  return out;
}

/** Ultima rilevazione degli accessi per cliente (tutti i clienti se omesso). */
function readAccess(cliente) {
  var rows = dl_readObjects_(dl_sheet_(dl_configSs_(), DL_SHEET.ACCESSI, DL_HEADERS.accessi));
  var latest = {};
  rows.forEach(function (r) {
    r.data_rilevazione = dl_ymd_(r.data_rilevazione);
    var k = [r.cliente, r.piattaforma, r.account].join('|');
    if (!latest[k] || r.data_rilevazione > latest[k]) latest[k] = r.data_rilevazione;
  });
  return rows.filter(function (r) {
    return (!cliente || r.cliente === cliente) && r.data_rilevazione === latest[[r.cliente, r.piattaforma, r.account].join('|')];
  });
}

/** Anagrafica campagne con obiettivo e segmento. */
function readCampaigns(cliente) {
  return dl_readObjects_(dl_sheet_(dl_configSs_(), DL_SHEET.CAMPAGNE, DL_HEADERS.campagne))
    .filter(function (r) { return !cliente || r.cliente === cliente; });
}
