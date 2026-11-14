/**
 * Connettore Meta Ads (Marketing API, Insights).
 *
 * Autenticazione: token dell'utente di sistema nella proprietà DL_TOKEN_meta.
 * Colonna in config: meta_ads_account (ID con o senza prefisso "act_").
 * Le date delle metriche sono nel fuso dell'account pubblicitario.
 */
function Connector_meta_ads_() {
  var THROTTLE_CODES = [4, 17, 32, 613, 80000, 80003, 80004, 80014];

  function base() {
    return 'https://graph.facebook.com/' + dl_setting_('meta_api_versione', 'v26.0') + '/';
  }

  function actId(account) {
    var id = String(account).trim();
    return id.indexOf('act_') === 0 ? id : 'act_' + id;
  }

  /**
   * Meta risponde con HTTP 400 anche per i limiti di frequenza: si distingue dal
   * codice d'errore. L'attesa suggerita arriva dall'intestazione di utilizzo.
   */
  function classify(status, headers, body) {
    var err = body && body.error;
    if (!err) return null;
    var msg = 'Meta ' + err.code + (err.error_subcode ? '/' + err.error_subcode : '') + ': ' + err.message;
    if (err.code === 190) return { auth: true, message: msg };
    if (THROTTLE_CODES.indexOf(err.code) !== -1) return { retryable: true, waitSec: regainSeconds(headers) || 60, message: msg };
    if (err.is_transient || err.code === 1 || err.code === 2) return { retryable: true, message: msg };
    return { message: msg };
  }

  function regainSeconds(headers) {
    try {
      var usage = JSON.parse(headers['x-business-use-case-usage'] || '{}');
      var max = 0;
      Object.keys(usage).forEach(function (k) {
        (usage[k] || []).forEach(function (u) { max = Math.max(max, Number(u.estimated_time_to_regain_access) || 0); });
      });
      return max * 60;
    } catch (e) { return 0; }
  }

  function get(path, query) {
    return dl_paginate_({ url: base() + path, auth: 'meta', query: query, classify: classify },
      dl_pager_.nextUrl('data', 'paging.next'));
  }

  var OBIETTIVI = {
    OUTCOME_AWARENESS: 'Awareness', BRAND_AWARENESS: 'Awareness', REACH: 'Awareness',
    OUTCOME_ENGAGEMENT: 'Interazioni', OUTCOME_TRAFFIC: 'Interazioni', LINK_CLICKS: 'Interazioni',
    POST_ENGAGEMENT: 'Interazioni', PAGE_LIKES: 'Interazioni', VIDEO_VIEWS: 'Interazioni', MESSAGES: 'Interazioni',
    EVENT_RESPONSES: 'Interazioni',
    OUTCOME_LEADS: 'Lead Generation', LEAD_GENERATION: 'Lead Generation',
    OUTCOME_SALES: 'Vendite', CONVERSIONS: 'Vendite', PRODUCT_CATALOG_SALES: 'Vendite',
    STORE_VISITS: 'Drive to Store'
  };

  var RUOLI = [['MANAGE', 'Amministratore'], ['ADVERTISE', 'Inserzionista'], ['ANALYZE', 'Analista'], ['DRAFT', 'Bozze']];

  function ruolo(tasks) {
    for (var i = 0; i < RUOLI.length; i++) if ((tasks || []).indexOf(RUOLI[i][0]) !== -1) return RUOLI[i][1];
    return (tasks || []).join(', ');
  }

  return {
    label: 'Meta Ads',
    tipo: 'paid',
    auth: 'meta',
    levels: ['account', 'campaign'],
    chunkDays: 14,
    lookbackDays: 28,        // i dati Insights non cambiano più dopo 28 giorni
    delayDays: 1,

    settings: [
      ['meta_api_versione', 'v26.0', 'Versione della Graph API usata dai connettori Meta.'],
      ['meta_business_id', '', 'ID del Business Manager dell\'agenzia: serve per rilevare gli utenti con accesso.']
    ],

    // "clic" = clic sul link, confrontabile con le altre piattaforme ("clicks" di Meta conta ogni clic).
    // "conversioni" = lead + acquisti: modificabile dal foglio mappa_metriche.
    defaultMappings: [
      ['impressions', 'impression'],
      ['reach', 'copertura'],
      ['inline_link_clicks', 'clic'],
      ['spend', 'spesa'],
      ['inline_post_engagement', 'interazioni'],
      ['actions:video_view', 'visualizzazioni_video'],
      ['actions:lead', 'lead'],
      ['actions:lead', 'conversioni'],
      ['actions:purchase', 'acquisti'],
      ['actions:purchase', 'conversioni'],
      ['action_values:purchase', 'valore_conversioni']
    ],

    mapObjective: function (nativo) { return OBIETTIVI[String(nativo || '').toUpperCase()] || ''; },

    listAccounts: function () {
      var STATI = { 1: 'attivo', 2: 'disattivato', 3: 'insoluto', 7: 'in revisione', 9: 'periodo di tolleranza', 101: 'chiuso' };
      return get('me/adaccounts', { fields: 'account_id,name,currency,timezone_name,account_status', limit: 200 })
        .map(function (a) {
          return { account: String(a.account_id), nome: a.name, valuta: a.currency, fuso: a.timezone_name,
            stato: STATI[a.account_status] || String(a.account_status) };
        });
    },

    getMetrics: function (account, range, livello) {
      var fields = ['account_currency', 'impressions', 'reach', 'clicks', 'inline_link_clicks',
        'inline_post_engagement', 'spend', 'actions', 'action_values'];
      if (livello === 'campaign') fields = fields.concat(['campaign_id', 'campaign_name', 'objective']);
      var rows = get(actId(account) + '/insights', {
        level: livello,
        time_increment: 1,
        time_range: { since: range.start, until: range.end },
        fields: fields.join(','),
        use_unified_attribution_setting: true,   // stessi numeri di Gestione inserzioni
        limit: 500
      });
      return rows.map(function (r) {
        var m = { impressions: r.impressions, reach: r.reach, clicks: r.clicks,
          inline_link_clicks: r.inline_link_clicks, inline_post_engagement: r.inline_post_engagement, spend: r.spend };
        (r.actions || []).forEach(function (a) { m['actions:' + a.action_type] = a.value; });
        (r.action_values || []).forEach(function (a) { m['action_values:' + a.action_type] = a.value; });
        return { data: r.date_start, campagna_id: r.campaign_id || '', campagna: r.campaign_name || '',
          obiettivo_nativo: r.objective || '', valuta: r.account_currency || '', metriche: m };
      });
    },

    /**
     * Utenti del Business Manager dell'agenzia assegnati all'account, con email
     * ricavata dall'elenco dei membri del business. Gli utenti del business del
     * cliente non sono visibili da qui: lo dice la colonna "nota".
     */
    getAccessUsers: function (account) {
      var business = String(dl_setting_('meta_business_id', '') || '').trim();
      if (!business) return dl_unsupported_('Imposta "meta_business_id" nel foglio impostazioni per rilevare gli utenti Meta.');
      var members = {};
      try {
        get(business + '/business_users', { fields: 'id,name,email,role', limit: 200 })
          .forEach(function (u) { members[u.id] = u; });
      } catch (e) {
        if (e.kind === 'AUTH' || e.kind === 'DEADLINE') throw e;   // senza permesso business_management: si prosegue senza email
      }
      var nota = 'Solo utenti del Business Manager ' + business;
      return get(actId(account) + '/assigned_users', { business: business, fields: 'id,name,tasks,user_type', limit: 200 })
        .map(function (u) {
          var m = members[u.id];
          return { utente: (m && m.email) || u.name || '', utente_id: u.id,
            ruolo_nativo: (u.tasks || []).join(', '), ruolo: ruolo(u.tasks),
            nota: nota + (m ? '' : ' · utente di sistema o email non disponibile') + (u.name && m && m.email ? ' · ' + u.name : '') };
        });
    }
  };
}
