/**
 * Lettura di "config" e "impostazioni". Aggiungere un cliente = aggiungere una riga.
 */

var DL_DEFAULT_SETTINGS = [
  ['avvisi_destinatari', '', 'Email (separate da virgola) per gli avvisi sui token. Vuoto = chi esegue lo script.'],
  ['avviso_token_giorni', 14, 'Giorni di anticipo con cui avvisare che un token richiede un intervento manuale.'],
  ['storico_giorni_default', 90, 'Giorni di storico da scaricare se "inizio_storico" è vuoto in config.'],
  ['tempo_massimo_secondi', 270, 'Durata massima di una esecuzione prima di fermarsi e riprendere (limite Apps Script: 360).'],
  ['accessi_frequenza_giorni', 7, 'Ogni quanti giorni rilevare gli utenti con accesso.'],
  ['http_tentativi', 5, 'Numero massimo di tentativi per ogni richiesta.'],
  ['errori_massimi_giorno', 3, 'Dopo quanti errori consecutivi un lavoro viene sospeso fino al giorno dopo.']
];

function dl_settings_() {
  if (DL_MEM_.settings) return DL_MEM_.settings;
  var out = {};
  DL_DEFAULT_SETTINGS.forEach(function (d) { out[d[0]] = d[1]; });
  var sh = dl_configSs_().getSheetByName(DL_SHEET.IMPOSTAZIONI);
  if (sh) dl_readObjects_(sh).forEach(function (r) {
    if (r.chiave !== '' && r.valore !== '') out[String(r.chiave).trim()] = r.valore;
  });
  DL_MEM_.settings = out;
  return out;
}

function dl_setting_(key, fallback) {
  var v = dl_settings_()[key];
  return v === undefined || v === '' ? fallback : v;
}

function dl_setSetting_(key, value, description) {
  var sh = dl_sheet_(dl_configSs_(), DL_SHEET.IMPOSTAZIONI, DL_HEADERS.impostazioni);
  dl_upsert_(sh, function (o) { return String(o.chiave); },
    [{ chiave: key, valore: value, descrizione: description || '' }],
    function (old, neu) { neu.descrizione = neu.descrizione || old.descrizione; return neu; });
  if (DL_MEM_.settings) DL_MEM_.settings[key] = value;
}

/**
 * Clienti attivi. Ogni connettore dichiara la propria colonna in config
 * (es. "meta_ads_account"); più ID nella stessa cella si separano con virgola.
 * @return {Array<{cliente:string, inizio_storico:string, accounts:Object<string,string[]>, riga:Object}>}
 */
function dl_clients_() {
  var sh = dl_configSs_().getSheetByName(DL_SHEET.CONFIG);
  if (!sh) throw dl_error_('CONFIG', 'Foglio "config" mancante: esegui setup().');
  var connectors = dl_connectors_();
  return dl_readObjects_(sh).filter(function (r) {
    return String(r.cliente).trim() !== '' && dl_truthy_(r.attivo);
  }).map(function (r) {
    var accounts = {};
    Object.keys(connectors).forEach(function (id) {
      var raw = r[connectors[id].configColumn];
      if (raw === undefined || raw === null || raw === '') return;
      var ids = String(raw).split(/[,;\n]/).map(function (s) { return s.trim(); }).filter(String);
      if (ids.length) accounts[id] = ids;
    });
    return { cliente: String(r.cliente).trim(), inizio_storico: dl_ymd_(r.inizio_storico), accounts: accounts, riga: r };
  });
}

/**
 * Crea (o completa) file, fogli, colonne e valori predefiniti. Si può rieseguire
 * senza rischi: non cancella e non sovrascrive nulla di già compilato.
 */
function dl_setup_() {
  var props = dl_props_();
  var id = props.getProperty(DL_PROP.CONFIG_SS);
  var ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create('Livello dati');
    ss.setSpreadsheetTimeZone(Session.getScriptTimeZone());
    props.setProperty(DL_PROP.CONFIG_SS, ss.getId());
  }
  DL_MEM_.ss = ss;

  var connectors = dl_connectors_();
  var configHeaders = DL_HEADERS.config.concat(Object.keys(connectors).map(function (k) { return connectors[k].configColumn; }));
  dl_sheet_(ss, DL_SHEET.CONFIG, configHeaders);
  [DL_SHEET.CAMPAGNE, DL_SHEET.ACCESSI, DL_SHEET.STATO, DL_SHEET.LOG].forEach(function (n) {
    dl_sheet_(ss, n, DL_HEADERS[n]);
  });

  // Impostazioni: aggiungo solo le chiavi mancanti.
  var shSet = dl_sheet_(ss, DL_SHEET.IMPOSTAZIONI, DL_HEADERS.impostazioni);
  var have = {};
  dl_readObjects_(shSet).forEach(function (r) { have[String(r.chiave)] = true; });
  var extra = [];
  Object.keys(connectors).forEach(function (k) {
    extra.push(['ricalcolo_giorni_' + k, connectors[k].lookbackDays, 'Finestra di ricalcolo (conversioni tardive) per ' + connectors[k].label + '.']);
    (connectors[k].settings || []).forEach(function (x) { if (!extra.some(function (e) { return e[0] === x[0]; })) extra.push(x); });
  });
  dl_append_(shSet, DL_DEFAULT_SETTINGS.concat(extra).filter(function (d) { return !have[d[0]]; })
    .map(function (d) { return { chiave: d[0], valore: d[1], descrizione: d[2] }; }));
  DL_MEM_.settings = null;

  // Mappatura nomi nativi -> normalizzati: aggiungo solo le coppie mancanti.
  var shMap = dl_sheet_(ss, DL_SHEET.MAPPA, DL_HEADERS.mappa_metriche);
  var seen = {};
  dl_readObjects_(shMap).forEach(function (r) { seen[r.piattaforma + '|' + r.nome_nativo + '|' + r.nome_normalizzato] = true; });
  var rows = [];
  Object.keys(connectors).forEach(function (k) {
    (connectors[k].defaultMappings || []).forEach(function (m) {
      if (!seen[k + '|' + m[0] + '|' + m[1]]) rows.push({ piattaforma: k, nome_nativo: m[0], nome_normalizzato: m[1], trasformazione: m[2] || '' });
    });
  });
  dl_append_(shMap, rows);
  DL_MEM_.mappa = null;

  var def = ss.getSheetByName('Foglio1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  return ss.getUrl();
}
