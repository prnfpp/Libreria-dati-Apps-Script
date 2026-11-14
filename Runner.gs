/**
 * Esecuzione a blocchi con ripresa.
 *
 * Il piano si ricava da "config": cliente × piattaforma × account × lavoro.
 * Per ogni lavoro il foglio "stato" ricorda fino a che giorno i dati sono completi.
 * Ogni esecuzione scarica i giorni nuovi più la finestra di ricalcolo, un blocco
 * di date alla volta; quando il tempo sta per finire si ferma e programma la ripresa.
 */

function dl_run_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { esito: 'già in esecuzione' };
  var summary = { lavori: 0, righe: 0, errori: 0, sospeso: false };
  try {
    DL_MEM_.deadline = Date.now() + Number(dl_setting_('tempo_massimo_secondi', 270)) * 1000;
    var state = dl_loadState_();
    var jobs = dl_plan_(state);
    for (var i = 0; i < jobs.length; i++) {
      if (dl_timeLeft_() < 30000) { summary.sospeso = true; break; }
      var r = dl_runJob_(jobs[i], state);
      summary.lavori++;
      summary.righe += r.righe;
      if (r.errore) summary.errori++;
      if (r.sospeso) { summary.sospeso = true; break; }
    }
    dl_scheduleContinuation_(summary.sospeso);
    dl_log_({ lavoro: 'esecuzione', esito: summary.sospeso ? 'sospeso' : (summary.errori ? 'con_errori' : 'ok'),
      righe: summary.righe, chiamate: DL_MEM_.calls, messaggio: summary.lavori + ' lavori, ' + summary.errori + ' errori' });
  } catch (e) {
    dl_log_({ lavoro: 'esecuzione', esito: 'errore', messaggio: dl_redact_(e.message) });
    throw e;
  } finally {
    dl_logFlush_();
    lock.releaseLock();
  }
  return summary;
}

/* ---------- Stato ---------- */

function dl_stateKey_(j) {
  return [j.cliente, j.connector, j.account, j.lavoro].join('|');
}

function dl_loadState_() {
  var sh = dl_sheet_(dl_configSs_(), DL_SHEET.STATO, DL_HEADERS.stato);
  var map = {};
  dl_readObjects_(sh).forEach(function (r) {
    r.completato_fino_al = dl_ymd_(r.completato_fino_al);
    r.ultimo_run = dl_isDate_(r.ultimo_run) ? Utilities.formatDate(r.ultimo_run, dl_tz_(), 'yyyy-MM-dd HH:mm:ss') : String(r.ultimo_run || '');
    r.errori_consecutivi = Number(r.errori_consecutivi) || 0;
    map[String(r.chiave)] = r;
  });
  return { sheet: sh, map: map };
}

function dl_saveState_(state) {
  dl_overwrite_(state.sheet, Object.keys(state.map).map(function (k) { return state.map[k]; }));
}

function dl_stateFor_(state, job) {
  var k = dl_stateKey_(job);
  if (!state.map[k]) {
    state.map[k] = { chiave: k, cliente: job.cliente, piattaforma: job.connector, account: job.account, lavoro: job.lavoro,
      completato_fino_al: '', ultimo_run: '', ultimo_esito: '', errori_consecutivi: 0, messaggio: '' };
  }
  return state.map[k];
}

/* ---------- Piano ---------- */

/**
 * Elenco dei lavori da fare adesso, dal meno recente al più recente, così un
 * lavoro lungo o in errore non blocca gli altri.
 */
function dl_plan_(state) {
  var connectors = dl_connectors_();
  var today = dl_today_();
  var maxErr = Number(dl_setting_('errori_massimi_giorno', 3));
  var jobs = [];
  dl_clients_().forEach(function (c) {
    Object.keys(c.accounts).forEach(function (cid) {
      var conn = connectors[cid];
      c.accounts[cid].forEach(function (account) {
        conn.levels.forEach(function (level) {
          jobs.push({ cliente: c.cliente, connector: cid, account: account, lavoro: 'metriche_' + level,
            livello: level, inizio_storico: c.inizio_storico });
        });
        jobs.push({ cliente: c.cliente, connector: cid, account: account, lavoro: 'accessi' });
      });
    });
  });
  return jobs.filter(function (j) {
    var s = state.map[dl_stateKey_(j)];
    if (!s) return true;
    var ranToday = s.ultimo_run.slice(0, 10) === today;
    if (ranToday && s.errori_consecutivi >= maxErr) return false;          // sospeso fino a domani
    if (j.lavoro === 'accessi') {
      if (s.ultimo_esito === 'errore') return true;
      return !s.ultimo_run || dl_daysBetween_(s.ultimo_run.slice(0, 10), today) >= Number(dl_setting_('accessi_frequenza_giorni', 7));
    }
    var end = dl_addDays_(today, -connectors[j.connector].delayDays);
    return !(ranToday && s.ultimo_esito === 'ok' && s.completato_fino_al >= end);
  }).sort(function (a, b) {
    var sa = state.map[dl_stateKey_(a)], sb = state.map[dl_stateKey_(b)];
    var ra = sa ? sa.ultimo_run : '', rb = sb ? sb.ultimo_run : '';
    return ra < rb ? -1 : (ra > rb ? 1 : 0);
  });
}

/** Intervallo da scaricare: giorni nuovi più finestra di ricalcolo. */
function dl_rangeFor_(job, s, conn) {
  var today = dl_today_();
  var end = dl_addDays_(today, -conn.delayDays);
  var start;
  if (!s.completato_fino_al) {
    start = job.inizio_storico || dl_addDays_(today, -Number(dl_setting_('storico_giorni_default', 90)));
  } else {
    var lookback = Number(dl_setting_('ricalcolo_giorni_' + conn.id, conn.lookbackDays));
    var next = dl_addDays_(s.completato_fino_al, 1);
    var recalcFrom = dl_addDays_(end, -(lookback - 1));
    start = next < recalcFrom ? next : recalcFrom;
    if (job.inizio_storico && start < job.inizio_storico) start = job.inizio_storico;
  }
  return start <= end ? { start: start, end: end } : null;
}

/* ---------- Esecuzione di un lavoro ---------- */

function dl_runJob_(job, state) {
  var conn = dl_connector_(job.connector);
  var s = dl_stateFor_(state, job);
  var t0 = Date.now(), calls0 = DL_MEM_.calls;
  var out = { righe: 0, errore: false, sospeso: false };
  var esito = 'ok', messaggio = '';
  try {
    if (job.lavoro === 'accessi') {
      var a = dl_runAccess_(job, conn);
      out.righe = a.righe; esito = a.esito; messaggio = a.messaggio;
    } else {
      var range = dl_rangeFor_(job, s, conn);
      var chunks = range ? dl_chunks_(range.start, range.end, conn.chunkDays) : [];
      for (var i = 0; i < chunks.length; i++) {
        if (dl_timeLeft_() < 30000) { out.sospeso = true; break; }
        out.righe += dl_runMetricsChunk_(job, conn, chunks[i]);
        if (chunks[i].end > s.completato_fino_al) s.completato_fino_al = chunks[i].end;
      }
      if (out.sospeso) { esito = 'sospeso'; messaggio = 'tempo esaurito: si riprende dal blocco successivo'; }
    }
    s.errori_consecutivi = 0;
  } catch (e) {
    if (e.kind === 'DEADLINE') {
      out.sospeso = true; esito = 'sospeso'; messaggio = e.message;
    } else {
      out.errore = true; esito = 'errore'; messaggio = dl_redact_(e.message);
      s.errori_consecutivi++;
      if (e.kind === 'AUTH') {
        try { dl_notifyAuthError_(e.authId || conn.auth, conn.label + ' · ' + job.cliente + ': ' + e.message); } catch (mailErr) { /* l'avviso non deve bloccare il resto */ }
      }
    }
  }
  s.ultimo_run = dl_now_();
  s.ultimo_esito = esito;
  s.messaggio = messaggio;
  dl_saveState_(state);
  dl_log_({ lavoro: job.lavoro, cliente: job.cliente, piattaforma: job.connector, account: job.account, esito: esito,
    righe: out.righe, chiamate: DL_MEM_.calls - calls0, durata_ms: Date.now() - t0, messaggio: messaggio });
  return out;
}

function dl_runMetricsChunk_(job, conn, range) {
  var res = conn.getMetrics(job.account, range, job.livello);
  if (dl_isUnsupported_(res)) return 0;
  var rows = (res || []).map(function (r) { return dl_metricRow_(conn, job.cliente, job.account, job.livello, r); })
    .filter(function (r) { return r.data >= range.start && r.data <= range.end; });
  var written = dl_writeMetrics_({ cliente: job.cliente, piattaforma: conn.id, account: String(job.account), livello: job.livello }, range, rows);
  if (job.livello === 'campaign') dl_upsertCampaigns_(job, conn, res || []);
  return written;
}

/**
 * Anagrafica campagne: la classificazione vive qui, a livello di campagna.
 * Nome e obiettivo nativo si aggiornano sempre; obiettivo e segmento non vengono
 * toccati se "blocco_manuale" è attivo o se sono già compilati.
 */
function dl_upsertCampaigns_(job, conn, nativeRows) {
  var seen = {}, items = [];
  nativeRows.forEach(function (r) {
    var id = r.campagna_id === undefined ? '' : String(r.campagna_id);
    if (!id || seen[id]) return;
    seen[id] = true;
    items.push({ cliente: job.cliente, piattaforma: conn.id, account: String(job.account), campagna_id: id,
      campagna: r.campagna || '', obiettivo_nativo: r.obiettivo_nativo || '',
      obiettivo: conn.mapObjective ? (conn.mapObjective(r.obiettivo_nativo, r) || '') : '',
      segmento: '', blocco_manuale: '', aggiornato_il: dl_now_() });
  });
  if (!items.length) return;
  var sh = dl_sheet_(dl_configSs_(), DL_SHEET.CAMPAGNE, DL_HEADERS.campagne);
  dl_upsert_(sh, function (o) { return [o.cliente, o.piattaforma, o.account, o.campagna_id].join('|'); }, items,
    function (old, neu) {
      var locked = dl_truthy_(old.blocco_manuale);
      old.campagna = neu.campagna || old.campagna;
      old.obiettivo_nativo = neu.obiettivo_nativo || old.obiettivo_nativo;
      if (!locked && !String(old.obiettivo || '').trim()) old.obiettivo = neu.obiettivo;
      old.aggiornato_il = neu.aggiornato_il;
      return old;
    });
}

function dl_runAccess_(job, conn) {
  var today = dl_today_();
  var res = conn.getAccessUsers(job.account);
  var rows, esito = 'ok', messaggio = '';
  if (dl_isUnsupported_(res)) {
    esito = 'non_supportato'; messaggio = res.reason;
    rows = [{ cliente: job.cliente, piattaforma: conn.id, account: String(job.account), data_rilevazione: today,
      utente: '', utente_id: '', ruolo_nativo: '', ruolo: 'NON DISPONIBILE VIA API', nota: res.reason }];
  } else {
    rows = (res || []).map(function (u) {
      return { cliente: job.cliente, piattaforma: conn.id, account: String(job.account), data_rilevazione: today,
        utente: u.utente || '', utente_id: u.utente_id === undefined ? '' : String(u.utente_id),
        ruolo_nativo: u.ruolo_nativo || '', ruolo: u.ruolo || u.ruolo_nativo || '', nota: u.nota || '' };
    });
  }
  var sh = dl_sheet_(dl_configSs_(), DL_SHEET.ACCESSI, DL_HEADERS.accessi);
  // Una rilevazione per giorno: rieseguire nello stesso giorno sostituisce, giorni diversi restano come storico.
  var n = dl_replaceRows_(sh, 4, function (k) {
    return String(k[0]) === job.cliente && String(k[1]) === conn.id && String(k[2]) === String(job.account) && dl_ymd_(k[3]) === today;
  }, rows);
  return { righe: esito === 'ok' ? n : 0, esito: esito, messaggio: messaggio };
}

/* ---------- Trigger ---------- */

/** Se resta lavoro, programma una ripresa tra un minuto; altrimenti rimuove quella vecchia. */
function dl_scheduleContinuation_(needed) {
  var props = dl_props_();
  var old = props.getProperty(DL_PROP.CONT_TRIGGER);
  if (old) {
    ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getUniqueId() === old) ScriptApp.deleteTrigger(t); });
    props.deleteProperty(DL_PROP.CONT_TRIGGER);
  }
  if (needed) {
    var t = ScriptApp.newTrigger('run').timeBased().after(60 * 1000).create();
    props.setProperty(DL_PROP.CONT_TRIGGER, t.getUniqueId());
  }
}

function dl_installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['run', 'checkTokens'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  dl_props_().deleteProperty(DL_PROP.CONT_TRIGGER);
  ScriptApp.newTrigger('run').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('checkTokens').timeBased().everyDays(1).atHour(8).create();
}
