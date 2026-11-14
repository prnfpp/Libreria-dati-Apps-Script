/**
 * Richieste HTTP: autenticazione, tentativi con attesa crescente, paginazione.
 * I connettori non chiamano mai UrlFetchApp direttamente.
 */

/**
 * @param {Object} o
 *   url        {string}
 *   method     {string=}  get (default) | post | ...
 *   query      {Object=}  parametri; oggetti e array vengono serializzati in JSON
 *   rawQuery   {string=}  porzione di query già codificata (es. sintassi Rest.li di LinkedIn)
 *   headers    {Object=}
 *   body       {Object=}  inviato come JSON
 *   form       {Object=}  inviato come form-urlencoded
 *   auth       {string=}  id del provider (google, meta, ...). Assente = nessuna autenticazione
 *   authStyle  {string=}  'bearer' (default) | 'query:<nome>' | 'header:<nome>'
 *   classify   {function(number, Object, *): Object=}  lettura degli errori specifica della piattaforma;
 *              restituisce {ok} | {retryable, waitSec, message} | {auth, message} | {message}, oppure null
 * @return {{status:number, headers:Object, body:*}}
 */
function dl_request_(o) {
  var maxAttempts = Number(dl_setting_('http_tentativi', 5));
  var refreshed = false;
  var lastMessage = '';

  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    var built = dl_buildRequest_(o);
    var status = 0, headers = {}, body = null, text = '', verdict;
    try {
      DL_MEM_.calls++;
      var resp = UrlFetchApp.fetch(built.url, built.params);
      status = resp.getResponseCode();
      headers = dl_lowerKeys_(resp.getHeaders());
      text = resp.getContentText();
      try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
      verdict = (o.classify && o.classify(status, headers, body)) || dl_classify_(status, headers, body);
    } catch (e) {
      // Errore di rete, DNS o timeout: si ritenta.
      verdict = { retryable: true, message: 'rete: ' + e.message };
    }

    if (verdict.ok) return { status: status, headers: headers, body: body };
    lastMessage = dl_redact_(verdict.message || ('HTTP ' + status + ' ' + String(text).slice(0, 500)));

    if (verdict.auth) {
      // Un solo tentativo di rinnovo, poi è un intervento manuale.
      if (o.auth && !refreshed) {
        refreshed = true;
        try { dl_accessToken_(o.auth, true); continue; } catch (e) { lastMessage = e.message; }
      }
      throw dl_error_('AUTH', lastMessage, { authId: o.auth, status: status });
    }
    if (!verdict.retryable || attempt === maxAttempts) {
      throw dl_error_('HTTP', lastMessage, { status: status, body: body, retryable: !!verdict.retryable });
    }

    var wait = verdict.waitSec ? verdict.waitSec * 1000 : Math.min(60000, 2000 * Math.pow(2, attempt - 1));
    wait += Math.floor(Math.random() * 1000);
    if (dl_timeLeft_() < wait + 15000) {
      throw dl_error_('DEADLINE', 'Limite raggiunto (' + lastMessage + '): si riprende alla prossima esecuzione.', { waitMs: wait });
    }
    Utilities.sleep(wait);
  }
  throw dl_error_('HTTP', lastMessage);
}

function dl_buildRequest_(o) {
  var headers = {};
  for (var h in (o.headers || {})) headers[h] = o.headers[h];
  var query = {};
  for (var q in (o.query || {})) query[q] = o.query[q];

  if (o.auth) {
    var token = dl_accessToken_(o.auth);
    var style = o.authStyle || 'bearer';
    if (style === 'bearer') headers.Authorization = 'Bearer ' + token;
    else if (style.indexOf('query:') === 0) query[style.slice(6)] = token;
    else if (style.indexOf('header:') === 0) headers[style.slice(7)] = token;
  }

  var parts = [];
  Object.keys(query).forEach(function (k) {
    var v = query[k];
    if (v === undefined || v === null) return;
    if (typeof v === 'object') v = JSON.stringify(v);
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  });
  if (o.rawQuery) parts.push(o.rawQuery);
  var url = o.url + (parts.length ? (o.url.indexOf('?') === -1 ? '?' : '&') + parts.join('&') : '');

  var params = { method: (o.method || 'get').toLowerCase(), headers: headers, muteHttpExceptions: true };
  if (o.body !== undefined) { params.contentType = 'application/json'; params.payload = JSON.stringify(o.body); }
  else if (o.form !== undefined) { params.payload = o.form; }
  return { url: url, params: params };
}

/** Regole generiche: 2xx ok, 401 token, 429 e 5xx da ritentare. */
function dl_classify_(status, headers, body) {
  if (status >= 200 && status < 300) return { ok: true };
  var msg = 'HTTP ' + status + ' ' + (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 500);
  if (status === 401) return { auth: true, message: msg };
  if (status === 429 || status >= 500) {
    var ra = Number(headers['retry-after']);
    return { retryable: true, waitSec: ra > 0 ? ra : 0, message: msg };
  }
  return { message: msg };
}

function dl_lowerKeys_(obj) {
  var out = {};
  for (var k in obj) out[String(k).toLowerCase()] = obj[k];
  return out;
}

/** Millisecondi rimasti prima che l'esecuzione debba fermarsi. */
function dl_timeLeft_() {
  return DL_MEM_.deadline ? DL_MEM_.deadline - Date.now() : 300000;
}

/* ---------- Paginazione ---------- */

/**
 * Scorre tutte le pagine di una richiesta.
 * @param {Object} request   come dl_request_
 * @param {Object} pager     {items: fn(body) -> Array, next: fn(body, request, stato) -> request|null}
 *                           (vedi dl_pager_ per gli schemi pronti)
 * @param {Object=} opt      {maxPages, onPage: fn(items)}  con onPage le righe non vengono accumulate
 * @return {Array}
 */
function dl_paginate_(request, pager, opt) {
  opt = opt || {};
  var all = [];
  var state = { page: 1, fetched: 0 };
  var req = request;
  var max = opt.maxPages || 1000;
  while (req && state.page <= max) {
    var res = dl_request_(req);
    var items = pager.items(res.body) || [];
    state.fetched += items.length;
    if (opt.onPage) opt.onPage(items); else all = all.concat(items);
    state.lastCount = items.length;
    req = pager.next(res.body, req, state);
    state.page++;
  }
  return all;
}

function dl_copy_(o, patch) {
  var out = {};
  for (var k in o) out[k] = o[k];
  for (var p in patch) out[p] = patch[p];
  return out;
}

function dl_path_(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce(function (acc, k) { return acc === null || acc === undefined ? acc : acc[k]; }, obj);
}

/** Schemi di paginazione pronti. I percorsi sono del tipo "data.list". */
var dl_pager_ = {
  /** L'API restituisce l'URL completo della pagina successiva (Meta: paging.next). */
  nextUrl: function (itemsPath, nextPath) {
    return {
      items: function (b) { return dl_path_(b, itemsPath); },
      next: function (b, req) {
        var url = dl_path_(b, nextPath);
        // L'URL successivo contiene già tutti i parametri: tolgo quelli iniziali.
        return url ? dl_copy_(req, { url: url, query: {}, rawQuery: '', authStyle: req.authStyle && req.authStyle.indexOf('query:') === 0 ? 'none' : req.authStyle }) : null;
      }
    };
  },
  /** Token di pagina in query (Google: nextPageToken -> pageToken). */
  tokenQuery: function (itemsPath, tokenPath, param) {
    return {
      items: function (b) { return dl_path_(b, itemsPath); },
      next: function (b, req) {
        var t = dl_path_(b, tokenPath);
        if (!t) return null;
        var q = dl_copy_(req.query || {}); q[param] = t;
        return dl_copy_(req, { query: q });
      }
    };
  },
  /** Token di pagina nel corpo della richiesta (Google Ads search, GA4). */
  tokenBody: function (itemsPath, tokenPath, field) {
    return {
      items: function (b) { return dl_path_(b, itemsPath); },
      next: function (b, req) {
        var t = dl_path_(b, tokenPath);
        if (!t) return null;
        var body = dl_copy_(req.body || {}); body[field] = t;
        return dl_copy_(req, { body: body });
      }
    };
  },
  /** Offset in query (LinkedIn: start/count). Si ferma alla prima pagina incompleta. */
  offsetQuery: function (itemsPath, startParam, pageSize) {
    return {
      items: function (b) { return dl_path_(b, itemsPath); },
      next: function (b, req, st) {
        if (st.lastCount < pageSize) return null;
        var q = dl_copy_(req.query || {}); q[startParam] = st.fetched;
        return dl_copy_(req, { query: q });
      }
    };
  },
  /** Offset nel corpo (Search Console: startRow; GA4: offset). */
  offsetBody: function (itemsPath, startField, pageSize) {
    return {
      items: function (b) { return dl_path_(b, itemsPath); },
      next: function (b, req, st) {
        if (st.lastCount < pageSize) return null;
        var body = dl_copy_(req.body || {}); body[startField] = st.fetched;
        return dl_copy_(req, { body: body });
      }
    };
  },
  /** Numero di pagina (TikTok: page + page_info.total_page). */
  pageNumber: function (itemsPath, pageParam, totalPagesPath) {
    return {
      items: function (b) { return dl_path_(b, itemsPath); },
      next: function (b, req, st) {
        var total = Number(dl_path_(b, totalPagesPath)) || 1;
        if (st.page >= total) return null;
        var q = dl_copy_(req.query || {}); q[pageParam] = st.page + 1;
        return dl_copy_(req, { query: q });
      }
    };
  }
};
