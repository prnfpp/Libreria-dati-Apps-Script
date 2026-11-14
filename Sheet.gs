/**
 * Scrittura e lettura su Google Sheet. Tutto a blocchi (una chiamata per blocco).
 */

function dl_props_() { return PropertiesService.getScriptProperties(); }

function dl_configSs_() {
  if (!DL_MEM_.ss) {
    var id = dl_props_().getProperty(DL_PROP.CONFIG_SS);
    if (!id) throw dl_error_('CONFIG', 'File di configurazione non impostato: esegui setup().');
    DL_MEM_.ss = SpreadsheetApp.openById(id);
  }
  return DL_MEM_.ss;
}

/**
 * Restituisce il foglio, creandolo se manca, e garantisce che tutte le colonne
 * di `headers` esistano (quelle nuove vengono aggiunte in coda).
 */
function dl_sheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    if (sh.getMaxColumns() > headers.length) sh.deleteColumns(headers.length + 1, sh.getMaxColumns() - headers.length);
    dl_formatCols_(sh, headers, 1);
    return sh;
  }
  var current = dl_headers_(sh);
  var missing = headers.filter(function (h) { return current.indexOf(h) === -1; });
  if (missing.length) {
    var first = current.length + 1;
    var need = first + missing.length - 1;
    if (need > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
    sh.getRange(1, first, 1, missing.length).setValues([missing]);
    dl_formatCols_(sh, missing, first);
  }
  return sh;
}

function dl_formatCols_(sh, headers, firstCol) {
  var rows = sh.getMaxRows();
  headers.forEach(function (h, i) {
    var fmt = DL_TEXT_COLS.indexOf(h) !== -1 || /_id$/.test(h) ? '@' : (DL_DATE_COLS.indexOf(h) !== -1 ? 'yyyy-mm-dd' : null);
    if (fmt) sh.getRange(1, firstCol + i, rows, 1).setNumberFormat(fmt);
  });
}

function dl_headers_(sh) {
  var n = sh.getLastColumn();
  if (!n) return [];
  return sh.getRange(1, 1, 1, n).getValues()[0].map(function (h) { return String(h).trim(); });
}

/** Legge il foglio come array di oggetti {intestazione: valore}. */
function dl_readObjects_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var headers = dl_headers_(sh);
  var values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  return values.map(function (r) {
    var o = {};
    headers.forEach(function (h, i) { if (h) o[h] = r[i]; });
    return o;
  });
}

function dl_toRows_(headers, objects) {
  return objects.map(function (o) {
    return headers.map(function (h) {
      var v = o[h];
      return v === undefined || v === null ? '' : v;
    });
  });
}

/** Aggiunge righe in fondo con una sola scrittura. */
function dl_append_(sh, objects) {
  if (!objects.length) return 0;
  var headers = dl_headers_(sh);
  var rows = dl_toRows_(headers, objects);
  var first = sh.getLastRow() + 1;
  var need = first + rows.length - 1;
  if (need > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  sh.getRange(first, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}

/** Sostituisce tutto il contenuto (intestazioni escluse). */
function dl_overwrite_(sh, objects) {
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
  return dl_append_(sh, objects);
}

/**
 * Cancella le righe che soddisfano `match` e poi aggiunge `objects`.
 * `match` riceve solo le prime `keyCols` colonne (array), per non leggere
 * tutto il foglio. È l'upsert usato per la finestra di ricalcolo.
 */
function dl_replaceRows_(sh, keyCols, match, objects) {
  var last = sh.getLastRow();
  if (last >= 2) {
    var keys = sh.getRange(2, 1, last - 1, keyCols).getValues();
    var groups = [];           // [rigaIniziale, numeroRighe], righe del foglio
    var removed = 0;
    for (var i = 0; i < keys.length; i++) {
      if (!match(keys[i])) continue;
      removed++;
      var g = groups[groups.length - 1];
      if (g && g[0] + g[1] === i + 2) g[1]++; else groups.push([i + 2, 1]);
    }
    if (removed && groups.length > 40) {
      // Troppe cancellazioni sparse: riscrivo il foglio in un colpo solo.
      var width = sh.getLastColumn();
      var all = sh.getRange(2, 1, last - 1, width).getValues();
      var keep = all.filter(function (r) { return !match(r.slice(0, keyCols)); });
      sh.getRange(2, 1, last - 1, width).clearContent();
      if (keep.length) sh.getRange(2, 1, keep.length, width).setValues(keep);
    } else {
      for (var j = groups.length - 1; j >= 0; j--) {
        // Non si può cancellare l'ultima riga non bloccata di un foglio.
        if (groups[j][0] === 2 && groups[j][1] === sh.getMaxRows() - 1) sh.insertRowsAfter(sh.getMaxRows(), 1);
        sh.deleteRows(groups[j][0], groups[j][1]);
      }
    }
  }
  return dl_append_(sh, objects);
}

/**
 * Upsert per chiave su fogli piccoli (campagne, stato): legge tutto, unisce,
 * riscrive. `merge(esistente, nuovo)` decide cosa tenere.
 */
function dl_upsert_(sh, keyFn, objects, merge) {
  if (!objects.length) return 0;
  var existing = dl_readObjects_(sh);
  var index = {};
  existing.forEach(function (o, i) { index[keyFn(o)] = i; });
  objects.forEach(function (o) {
    var k = keyFn(o);
    if (k in index) existing[index[k]] = merge ? merge(existing[index[k]], o) : o;
    else { index[k] = existing.length; existing.push(o); }
  });
  dl_overwrite_(sh, existing);
  return objects.length;
}

/* ---------- File "metriche", uno per anno ---------- */

function dl_metricsSheet_(year) {
  DL_MEM_.metrics = DL_MEM_.metrics || {};
  if (DL_MEM_.metrics[year]) return DL_MEM_.metrics[year];
  var key = 'metriche_file_' + year;
  var id = dl_settings_()[key];
  var ss;
  if (id) {
    ss = SpreadsheetApp.openById(String(id));
  } else {
    ss = SpreadsheetApp.create('Livello dati · metriche ' + year);
    ss.setSpreadsheetTimeZone(dl_tz_());
    dl_setSetting_(key, ss.getId(), 'ID del file con le metriche del ' + year);
  }
  var sh = dl_sheet_(ss, DL_SHEET.METRICHE, DL_HEADERS.metriche);
  DL_MEM_.metrics[year] = sh;
  return sh;
}

/**
 * Scrive righe di metriche sostituendo la finestra [start, end] per
 * cliente + piattaforma + account + livello. Gestisce i blocchi a cavallo d'anno.
 */
function dl_writeMetrics_(scope, range, rows) {
  var byYear = {};
  for (var y = +range.start.slice(0, 4); y <= +range.end.slice(0, 4); y++) byYear[y] = [];
  rows.forEach(function (r) {
    var y = +String(r.data).slice(0, 4);
    (byYear[y] = byYear[y] || []).push(r);
  });
  var written = 0;
  Object.keys(byYear).forEach(function (y) {
    var sh = dl_metricsSheet_(y);
    written += dl_replaceRows_(sh, DL_METRICHE_KEY_COLS, function (k) {
      var d = dl_ymd_(k[0]);
      return String(k[1]) === scope.cliente && String(k[2]) === scope.piattaforma &&
        String(k[3]) === scope.account && String(k[4]) === scope.livello &&
        d >= range.start && d <= range.end;
    }, byYear[y]);
  });
  return written;
}
