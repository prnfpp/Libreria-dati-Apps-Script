/**
 * Connettore LinkedIn Ads (Advertising API: adAccounts, adAnalytics, adAccountUsers).
 *
 * Autenticazione: OAuth, provider "linkedin_ads" (scope r_ads, r_ads_reporting).
 * Colonna in config: linkedin_ads_account (ID numerico o URN dell'account).
 * Le date delle metriche sono in UTC.
 */
function Connector_linkedin_ads_() {
  var BASE = 'https://api.linkedin.com/rest/';
  var MAX_ELEMENTS = 15000;      // adAnalytics non pagina: oltre questa soglia la risposta è troncata
  var METRICS = ['impressions', 'clicks', 'landingPageClicks', 'costInLocalCurrency',
    'externalWebsiteConversions', 'oneClickLeads', 'conversionValueInLocalCurrency',
    'videoViews', 'totalEngagements'];

  function headers() {
    return { 'Linkedin-Version': String(dl_setting_('linkedin_api_versione', '202610')), 'X-Restli-Protocol-Version': '2.0.0' };
  }

  function accountId(account) {
    return String(account).replace(/\D/g, '');
  }

  function urn(type, id) {
    return encodeURIComponent('urn:li:' + type + ':' + id);
  }

  function lastId(u) {
    return String(u || '').split(':').pop();
  }

  /** Messaggio d'errore leggibile; per il resto valgono le regole generiche (401, 429, 5xx). */
  function classify(status, hdrs, body) {
    if (status >= 200 && status < 300) return null;
    var v = dl_classify_(status, hdrs, body);
    if (body && body.message) v.message = 'LinkedIn ' + status + (body.code ? ' ' + body.code : '') + ': ' + body.message;
    return v;
  }

  function request(path, rawQuery, query) {
    return { url: BASE + path, auth: 'linkedin_ads', headers: headers(), rawQuery: rawQuery, query: query, classify: classify };
  }

  function ymdParts(d) {
    var p = d.split('-');
    return '(year:' + (+p[0]) + ',month:' + (+p[1]) + ',day:' + (+p[2]) + ')';
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /**
   * Una chiamata adAnalytics per intervallo. La sintassi Rest.li vuole parentesi
   * e due punti non codificati, tranne dentro gli URN. Se la risposta arriva al
   * tetto di 15.000 elementi, l'intervallo viene dimezzato e richiesto di nuovo.
   */
  function analytics(id, range, pivot) {
    var raw = 'q=analytics&pivot=' + pivot + '&timeGranularity=DAILY' +
      '&dateRange=(start:' + ymdParts(range.start) + ',end:' + ymdParts(range.end) + ')' +
      '&accounts=List(' + urn('sponsoredAccount', id) + ')' +
      '&fields=dateRange,pivotValues,' + METRICS.join(',');
    var elements = (dl_request_(request('adAnalytics', raw)).body || {}).elements || [];
    if (elements.length < MAX_ELEMENTS || range.start === range.end) return elements;
    var half = Math.floor(dl_daysBetween_(range.start, range.end) / 2);
    var mid = dl_addDays_(range.start, half);
    return analytics(id, { start: range.start, end: mid }, pivot)
      .concat(analytics(id, { start: dl_addDays_(mid, 1), end: range.end }, pivot));
  }

  /** Valuta dell'account, letta una volta per esecuzione. */
  function currency(id) {
    var cache = DL_MEM_.linkedinCurrency = DL_MEM_.linkedinCurrency || {};
    if (!(id in cache)) cache[id] = ((dl_request_(request('adAccounts/' + id)).body) || {}).currency || '';
    return cache[id];
  }

  /** Nome e obiettivo delle campagne indicate, a gruppi di 50, con memoria per esecuzione. */
  function campaigns(id, ids) {
    var cache = DL_MEM_.linkedinCampaigns = DL_MEM_.linkedinCampaigns || {};
    var known = cache[id] = cache[id] || {};
    var missing = ids.filter(function (c) { return !(c in known); });
    for (var i = 0; i < missing.length; i += 50) {
      var batch = missing.slice(i, i + 50);
      var raw = 'q=search&search=(id:(values:List(' +
        batch.map(function (c) { return urn('sponsoredCampaign', c); }).join(',') + ')))&pageSize=100';
      dl_paginate_(request('adAccounts/' + id + '/adCampaigns', raw),
        dl_pager_.tokenQuery('elements', 'metadata.nextPageToken', 'pageToken'))
        .forEach(function (c) { known[String(c.id)] = { nome: c.name || '', obiettivo: c.objectiveType || '' }; });
      batch.forEach(function (c) { if (!(c in known)) known[c] = { nome: '', obiettivo: '' }; });
    }
    return known;
  }

  // WEBSITE_CONVERSIONS su LinkedIn è quasi sempre generazione di contatti: si corregge per campagna nel foglio "campagne".
  var OBIETTIVI = {
    BRAND_AWARENESS: 'Awareness',
    ENGAGEMENT: 'Interazioni', VIDEO_VIEWS: 'Interazioni', WEBSITE_VISITS: 'Interazioni',
    LEAD_GENERATION: 'Lead Generation', WEBSITE_CONVERSIONS: 'Lead Generation'
  };

  var RUOLI = {
    ACCOUNT_BILLING_ADMIN: 'Amministratore fatturazione', ACCOUNT_MANAGER: 'Amministratore',
    CAMPAIGN_MANAGER: 'Gestore campagne', CREATIVE_MANAGER: 'Gestore creatività', VIEWER: 'Visualizzatore'
  };

  return {
    label: 'LinkedIn Ads',
    tipo: 'paid',
    auth: 'linkedin_ads',
    levels: ['account', 'campaign'],
    chunkDays: 30,
    lookbackDays: 30,
    delayDays: 1,

    settings: [
      ['linkedin_api_versione', '202610', 'Versione (AAAAMM) delle API LinkedIn. Ogni versione vale circa un anno.']
    ],

    // "clic" = clic verso la pagina di destinazione, confrontabile con le altre piattaforme.
    // La copertura non è scaricata: LinkedIn la fornisce solo come stima non sommabile per giorno.
    defaultMappings: [
      ['impressions', 'impression'],
      ['landingPageClicks', 'clic'],
      ['costInLocalCurrency', 'spesa'],
      ['externalWebsiteConversions', 'conversioni'],
      ['oneClickLeads', 'conversioni'],
      ['oneClickLeads', 'lead'],
      ['conversionValueInLocalCurrency', 'valore_conversioni'],
      ['videoViews', 'visualizzazioni_video'],
      ['totalEngagements', 'interazioni']
    ],

    mapObjective: function (nativo) { return OBIETTIVI[String(nativo || '').toUpperCase()] || ''; },

    listAccounts: function () {
      var STATI = { ACTIVE: 'attivo', DRAFT: 'bozza', CANCELED: 'annullato', PENDING_DELETION: 'in eliminazione', REMOVED: 'rimosso' };
      return dl_paginate_(request('adAccounts', 'q=search&pageSize=1000'),
        dl_pager_.tokenQuery('elements', 'metadata.nextPageToken', 'pageToken'))
        .map(function (a) {
          return { account: String(a.id), nome: a.name, valuta: a.currency, fuso: 'UTC', stato: STATI[a.status] || a.status };
        });
    },

    getMetrics: function (account, range, livello) {
      var id = accountId(account);
      var elements = analytics(id, range, livello === 'campaign' ? 'CAMPAIGN' : 'ACCOUNT');
      if (!elements.length) return [];
      var info = {};
      if (livello === 'campaign') {
        var ids = {};
        elements.forEach(function (e) { ids[lastId((e.pivotValues || [])[0])] = true; });
        info = campaigns(id, Object.keys(ids));
      }
      var valuta = currency(id);
      return elements.map(function (e) {
        var s = e.dateRange.start;
        var cid = livello === 'campaign' ? lastId((e.pivotValues || [])[0]) : '';
        var m = {};
        METRICS.forEach(function (k) { if (e[k] !== undefined) m[k] = e[k]; });
        return { data: s.year + '-' + pad(s.month) + '-' + pad(s.day), campagna_id: cid,
          campagna: cid ? info[cid].nome : '', obiettivo_nativo: cid ? info[cid].obiettivo : '',
          valuta: valuta, metriche: m };
      });
    },

    /**
     * Utenti dell'account con ruolo. LinkedIn restituisce solo l'ID persona
     * (urn:li:person:...), senza nome né email: lo segnala la colonna "nota".
     */
    getAccessUsers: function (account) {
      var id = accountId(account);
      return dl_paginate_(request('adAccountUsers', '', { q: 'accounts', accounts: 'urn:li:sponsoredAccount:' + id, start: 0, count: 100 }),
        dl_pager_.offsetQuery('elements', 'start', 100))
        .map(function (u) {
          return { utente: u.user, utente_id: lastId(u.user), ruolo_nativo: u.role, ruolo: RUOLI[u.role] || u.role,
            nota: 'LinkedIn fornisce solo l\'ID persona: nome da associare a mano' };
        });
    }
  };
}
