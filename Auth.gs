/**
 * Autenticazione: unico punto per tutte le piattaforme.
 *
 * I segreti stanno solo nelle Script Properties di questo progetto:
 *   DL_CRED_<authId>   JSON {"client_id":"...","client_secret":"..."}   (app OAuth)
 *   DL_TOKEN_<authId>  token semplice oppure JSON {access_token, expires_at, refresh_token, refresh_expires_at}
 * Si inseriscono a mano da Impostazioni progetto > Proprietà script, oppure
 * vengono scritti dal flusso di autorizzazione (getAuthorizationUrl).
 * expires_at e refresh_expires_at sono millisecondi epoch.
 */

/**
 * Definizione dei provider. Tipi:
 *  - google : token nativo di Apps Script (rinnovo automatico)
 *  - static : token incollato a mano (Meta system user)
 *  - oauth2 : flusso con codice di autorizzazione, rinnovo se previsto
 */
function dl_authProviders_() {
  return {
    google: { type: 'google', label: 'Google' },

    meta: {
      type: 'static', label: 'Meta',
      // Legge la scadenza reale del token (0 = non scade).
      introspect: function (token) {
        var r = UrlFetchApp.fetch('https://graph.facebook.com/debug_token?input_token=' +
          encodeURIComponent(token) + '&access_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
        if (r.getResponseCode() !== 200) return null;
        var d = (JSON.parse(r.getContentText()) || {}).data || {};
        if (d.is_valid === false) return { invalid: true };
        return { expires_at: d.expires_at ? d.expires_at * 1000 : 0 };
      }
    },

    linkedin_ads: dl_linkedinProvider_('LinkedIn Ads', 'r_ads r_ads_reporting'),
    linkedin_community: dl_linkedinProvider_('LinkedIn pagine', 'rw_organization_admin r_organization_social'),

    tiktok: {
      type: 'oauth2', label: 'TikTok',
      codeParam: 'auth_code',
      authUrl: function (cred, redirectUri, state) {
        return 'https://business-api.tiktok.com/portal/auth?app_id=' + encodeURIComponent(cred.client_id) +
          '&state=' + encodeURIComponent(state) + '&redirect_uri=' + encodeURIComponent(redirectUri);
      },
      exchange: function (code, cred) {
        var r = UrlFetchApp.fetch('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/', {
          method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          payload: JSON.stringify({ app_id: cred.client_id, secret: cred.client_secret, auth_code: code })
        });
        var b = JSON.parse(r.getContentText());
        if (b.code !== 0) throw dl_error_('AUTH', 'TikTok: ' + b.message);
        return { access_token: b.data.access_token };   // il token ads non scade, salvo revoca
      }
    }
  };
}

function dl_linkedinProvider_(label, scope) {
  var tokenUrl = 'https://www.linkedin.com/oauth/v2/accessToken';
  function post(payload) {
    var r = UrlFetchApp.fetch(tokenUrl, { method: 'post', payload: payload, muteHttpExceptions: true });
    var b = JSON.parse(r.getContentText());
    if (r.getResponseCode() !== 200) throw dl_error_('AUTH', label + ': ' + (b.error_description || b.error || r.getResponseCode()));
    return b;
  }
  function toToken(b, previous) {
    var now = Date.now();
    var t = { access_token: b.access_token, expires_at: now + b.expires_in * 1000 };
    if (b.refresh_token) {
      t.refresh_token = b.refresh_token;
      // La durata del refresh token non si azzera al rinnovo: vale la scadenza originale.
      t.refresh_expires_at = b.refresh_token_expires_in ? now + b.refresh_token_expires_in * 1000
        : (previous && previous.refresh_expires_at) || 0;
    }
    return t;
  }
  return {
    type: 'oauth2', label: label, refreshLeadDays: 7,
    authUrl: function (cred, redirectUri, state) {
      return 'https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=' +
        encodeURIComponent(cred.client_id) + '&redirect_uri=' + encodeURIComponent(redirectUri) +
        '&state=' + encodeURIComponent(state) + '&scope=' + encodeURIComponent(scope);
    },
    exchange: function (code, cred, redirectUri) {
      return toToken(post({ grant_type: 'authorization_code', code: code, client_id: cred.client_id,
        client_secret: cred.client_secret, redirect_uri: redirectUri }));
    },
    refresh: function (token, cred) {
      return toToken(post({ grant_type: 'refresh_token', refresh_token: token.refresh_token,
        client_id: cred.client_id, client_secret: cred.client_secret }), token);
    }
  };
}

/* ---------- Archivio ---------- */

function dl_readToken_(authId) {
  var raw = dl_props_().getProperty(DL_PROP.TOKEN + authId);
  if (!raw) return null;
  raw = raw.trim();
  if (raw.charAt(0) === '{') { try { return JSON.parse(raw); } catch (e) { /* token semplice */ } }
  return { access_token: raw };
}

function dl_saveToken_(authId, token) {
  dl_props_().setProperty(DL_PROP.TOKEN + authId, JSON.stringify(token));
}

function dl_readCred_(authId) {
  var raw = dl_props_().getProperty(DL_PROP.CRED + authId);
  if (!raw) throw dl_error_('AUTH', 'Credenziali app mancanti: proprietà ' + DL_PROP.CRED + authId);
  try { return JSON.parse(raw); } catch (e) {
    throw dl_error_('AUTH', 'La proprietà ' + DL_PROP.CRED + authId + ' deve essere JSON {"client_id":"...","client_secret":"..."}');
  }
}

/* ---------- Token d'accesso ---------- */

/**
 * Restituisce un token valido per il provider, rinnovandolo se serve.
 * @param {string} authId  google | meta | linkedin_ads | linkedin_community | tiktok
 * @param {boolean=} forceRefresh  dopo un 401: forza il rinnovo
 */
function dl_accessToken_(authId, forceRefresh) {
  var p = dl_authProviders_()[authId];
  if (!p) throw dl_error_('CONFIG', 'Provider di autenticazione sconosciuto: ' + authId);
  if (p.type === 'google') return ScriptApp.getOAuthToken();

  var t = dl_readToken_(authId);
  if (!t || !t.access_token) {
    throw dl_error_('AUTH', p.label + ': token mancante (proprietà ' + DL_PROP.TOKEN + authId + ').', { authId: authId });
  }
  var lead = (p.refreshLeadDays || 0) * 86400000;
  var due = t.expires_at && Date.now() > t.expires_at - Math.max(lead, 300000);
  if ((due || forceRefresh) && p.refresh && t.refresh_token) {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var fresh = dl_readToken_(authId);           // un'altra esecuzione può averlo già rinnovato
      if (fresh && fresh.access_token !== t.access_token) return fresh.access_token;
      try {
        t = p.refresh(t, dl_readCred_(authId));
        dl_saveToken_(authId, t);
      } catch (e) {
        if (t.expires_at && Date.now() > t.expires_at) throw e;   // ancora valido: si riproverà
      }
    } finally { lock.releaseLock(); }
  } else if (t.expires_at && Date.now() > t.expires_at) {
    throw dl_error_('AUTH', p.label + ': token scaduto, serve una nuova autorizzazione.', { authId: authId });
  } else if (forceRefresh) {
    throw dl_error_('AUTH', p.label + ': token rifiutato dalla piattaforma, serve una nuova autorizzazione.', { authId: authId });
  }
  return t.access_token;
}

/* ---------- Flusso di autorizzazione (LinkedIn, TikTok) ---------- */

function dl_redirectUri_() {
  return 'https://script.google.com/macros/d/' + ScriptApp.getScriptId() + '/usercallback';
}

function dl_authorizationUrl_(authId) {
  var p = dl_authProviders_()[authId];
  if (!p || p.type !== 'oauth2') throw dl_error_('CONFIG', authId + ' non usa un flusso di autorizzazione.');
  var state = ScriptApp.newStateToken().withMethod('authCallback').withArgument('authId', authId).withTimeout(3600).createToken();
  return p.authUrl(dl_readCred_(authId), dl_redirectUri_(), state);
}

function dl_authCallback_(request) {
  var authId = request.parameter.authId;
  var p = dl_authProviders_()[authId];
  try {
    var code = request.parameter[p.codeParam || 'code'] || request.parameter.code;
    if (!code) throw new Error(request.parameter.error_description || request.parameter.error || 'codice di autorizzazione assente');
    dl_saveToken_(authId, p.exchange(code, dl_readCred_(authId), dl_redirectUri_()));
    dl_props_().deleteProperty(DL_PROP.ALERT + authId);
    return HtmlService.createHtmlOutput('Autorizzazione ' + p.label + ' completata. Puoi chiudere questa scheda.');
  } catch (e) {
    return HtmlService.createHtmlOutput('Autorizzazione ' + p.label + ' non riuscita: ' + dl_redact_(e.message));
  }
}

/* ---------- Scadenze e avvisi ---------- */

/**
 * Stato di ogni token: quanti giorni mancano a un intervento manuale.
 * Un token rinnovabile conta dalla scadenza del refresh token.
 */
function dl_tokenStatus_() {
  var providers = dl_authProviders_();
  var out = [];
  Object.keys(providers).forEach(function (authId) {
    var p = providers[authId];
    if (p.type === 'google') return;
    var t = dl_readToken_(authId);
    if (!t) return;                                     // piattaforma non configurata
    var s = { authId: authId, label: p.label, giorni: null, stato: 'ok', nota: '' };
    var deadline = t.refresh_token ? t.refresh_expires_at : t.expires_at;
    if (!deadline && p.introspect) {
      try {
        var info = p.introspect(t.access_token);
        if (info && info.invalid) { s.stato = 'non_valido'; s.giorni = 0; }
        else if (info) deadline = info.expires_at;
      } catch (e) { s.nota = 'scadenza non verificabile: ' + dl_redact_(e.message); }
    }
    if (deadline) {
      s.giorni = Math.floor((deadline - Date.now()) / 86400000);
      if (s.giorni < 0) s.stato = 'scaduto';
    } else if (s.stato === 'ok') {
      s.nota = s.nota || 'nessuna scadenza';
    }
    out.push(s);
  });
  return out;
}

/** Da eseguire ogni giorno: manda una mail per ogni token in scadenza (una al giorno per token). */
function dl_checkTokens_() {
  var soglia = Number(dl_setting_('avviso_token_giorni', 14));
  var today = dl_today_();
  var props = dl_props_();
  var status = dl_tokenStatus_();
  status.forEach(function (s) {
    var urgent = s.stato !== 'ok' || (s.giorni !== null && s.giorni <= soglia);
    dl_log_({ lavoro: 'token', piattaforma: s.authId, esito: urgent ? 'avviso' : 'ok',
      messaggio: s.giorni === null ? s.nota : 'giorni residui: ' + s.giorni });
    if (!urgent || props.getProperty(DL_PROP.ALERT + s.authId) === today) return;
    dl_notify_('[Livello dati] Token ' + s.label + (s.stato === 'ok' ? ' in scadenza tra ' + s.giorni + ' giorni' : ' ' + s.stato.replace('_', ' ')),
      'Il token ' + s.label + ' richiede un intervento manuale' +
      (s.stato === 'ok' ? ' entro ' + s.giorni + ' giorni.' : ' (stato: ' + s.stato.replace('_', ' ') + ').') +
      '\n\nCosa fare: ' + (dl_authProviders_()[s.authId].type === 'oauth2'
        ? 'aprire il progetto Apps Script, eseguire getAuthorizationUrl("' + s.authId + '") e completare l\'autorizzazione dal link.'
        : 'generare un nuovo token sulla piattaforma e incollarlo nella proprietà ' + DL_PROP.TOKEN + s.authId + '.') +
      '\n\nFinché non viene rinnovato, i dati di questa piattaforma non si aggiornano.');
    props.setProperty(DL_PROP.ALERT + s.authId, today);
  });
  dl_logFlush_();
  return status;
}

function dl_notify_(subject, body) {
  var to = String(dl_setting_('avvisi_destinatari', '') || '').trim() || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(to, subject, body);
}

/** Avviso immediato quando una chiamata fallisce per token non valido (uno al giorno per provider). */
function dl_notifyAuthError_(authId, message) {
  var props = dl_props_();
  var key = DL_PROP.ALERT + authId;
  if (props.getProperty(key) === dl_today_()) return;
  var p = dl_authProviders_()[authId] || { label: authId };
  dl_notify_('[Livello dati] Token ' + p.label + ' da rinnovare', dl_redact_(message) +
    '\n\nI dati di questa piattaforma non si aggiornano finché il token non viene rinnovato.');
  props.setProperty(key, dl_today_());
}
