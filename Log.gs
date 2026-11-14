/**
 * Foglio "log": una riga per lavoro eseguito. Le righe si accumulano in memoria
 * e vengono scritte in blocco (dl_logFlush_), anche in caso di errore.
 */

function dl_log_(entry) {
  DL_MEM_.logs.push({
    quando: dl_now_(),
    lavoro: entry.lavoro || '',
    cliente: entry.cliente || '',
    piattaforma: entry.piattaforma || '',
    account: entry.account || '',
    esito: entry.esito || 'ok',
    righe: entry.righe === undefined ? '' : entry.righe,
    chiamate: entry.chiamate === undefined ? '' : entry.chiamate,
    durata_ms: entry.durata_ms === undefined ? '' : entry.durata_ms,
    messaggio: String(entry.messaggio || '').slice(0, 2000)
  });
  if (DL_MEM_.logs.length >= 200) dl_logFlush_();
}

function dl_logFlush_() {
  if (!DL_MEM_.logs.length) return;
  var rows = DL_MEM_.logs;
  DL_MEM_.logs = [];
  try {
    dl_append_(dl_sheet_(dl_configSs_(), DL_SHEET.LOG, DL_HEADERS.log), rows);
  } catch (e) {
    console.error('Log non scritto: ' + e.message + '\n' + JSON.stringify(rows));
  }
}

/** Rimuove dai messaggi qualunque cosa somigli a un token prima di loggarla. */
function dl_redact_(text) {
  return String(text)
    .replace(/(access_token|refresh_token|client_secret|secret|input_token|Authorization|Access-Token)(["'=:\s]+)(Bearer\s+)?[^\s"'&,}]+/gi, '$1$2***')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer ***');
}
