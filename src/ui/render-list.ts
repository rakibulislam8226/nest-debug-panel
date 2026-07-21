import { esc, layout, NAV_COUNTS_FN, SEARCH_ICON } from './html';

const EMPTY_LIST = `<div class="empty"><div class="big">Nothing here yet</div>Make an API request or fire a socket event, then it shows up live.</div>`;

/**
 * The dashboard is a small single-page app: one HTML shell with a fixed
 * sidebar, and client JS that swaps views by URL hash (#/overview, #/requests,
 * …). The fast summaries feed (GET ?json) powers every view except Queries,
 * which lazily pulls a flattened SQL feed (GET ?feed=queries) only when opened.
 */
export function renderListPage(routePrefix: string): string {
  const body = `
  <div id="view"><div class="empty">Loading…</div></div>
  <div class="modal-overlay" id="clear-modal">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="clear-title">
      <h3 id="clear-title">Clear all history?</h3>
      <p>This removes every captured request and socket event. This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn" onclick="closeClearModal()">Cancel</button>
        <button class="btn solid-danger" onclick="confirmClear()">Clear all</button>
      </div>
    </div>
  </div>
  <script>${CLIENT_SCRIPT.replace('__PREFIX__', esc(routePrefix))}</script>`;

  const topbar = `
    <h1 id="view-title">Overview</h1>
    <div class="search">${SEARCH_ICON}<input id="search" type="text" placeholder="Filter…" autocomplete="off" spellcheck="false"></div>
    <div class="spacer"></div>
    <button class="btn ghost" id="auto-btn" onclick="toggleAuto(this)">Auto-refresh: on</button>
    <button class="btn ghost" onclick="refresh()">Refresh</button>
    <button class="btn danger" onclick="clearAll()">Clear</button>`;

  return layout('nest-debug-panel', body, { routePrefix, active: 'overview', topbar, spa: true });
}

/** All client behavior. `__PREFIX__` is replaced with the route prefix. */
const CLIENT_SCRIPT = `(function () {
  var PREFIX = '/__PREFIX__';
  var auto = true, filter = '', view = 'overview';
  var summaries = [], queries = null, queriesLoading = false, logs = null, logsLoading = false;

  var VIEWS = {
    overview:   { title: 'Overview',   search: false },
    requests:   { title: 'Requests',   search: true, kind: 'http' },
    sockets:    { title: 'Sockets',    search: true, kind: 'socket' },
    queries:    { title: 'Queries',    search: true },
    logs:       { title: 'Logs',       search: true },
    exceptions: { title: 'Exceptions', search: true },
    slow:       { title: 'Slow',       search: true }
  };

  function escHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function methodClass(m) { return ['GET','POST','PUT','PATCH','DELETE'].indexOf(m) >= 0 ? 'm-' + m : 'm-OTHER'; }
  function statusClass(s) { if (s == null) return 'muted'; if (s >= 500) return 'err'; if (s >= 400) return 'warn'; if (s >= 300) return 'info'; return 'ok'; }
  function fmtMs(v) { if (v == null) return '—'; return v >= 1000 ? (v / 1000).toFixed(2) + 's' : v.toFixed(v < 10 ? 2 : 0) + 'ms'; }
  function relTime(iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 2) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return new Date(iso).toLocaleTimeString();
  }
  function isError(s) { return s.hasException || (s.statusCode != null && s.statusCode >= 500); }
  function typeBadge(s) {
    if (s.kind === 'socket') return '<span class="badge m-WS">WS</span>';
    return '<span class="badge ' + methodClass(s.method) + '">' + escHtml(s.method) + '</span>';
  }
  function labelOf(s) {
    if (s.kind === 'socket') {
      var ns = (s.namespace && s.namespace !== '/') ? ' <span class="muted">' + escHtml(s.namespace) + '</span>' : '';
      return escHtml(s.event == null ? '—' : s.event) + ns;
    }
    return escHtml(s.url);
  }
  function statusCell(s) {
    if (s.kind === 'socket') return s.hasException ? '<span class="err">error</span>' : '<span class="muted">—</span>';
    return '<span class="' + statusClass(s.statusCode) + '">' + (s.statusCode == null ? '—' : s.statusCode) + '</span>';
  }
  function pillsOf(s) {
    var p = '';
    if (s.sqlCount > 0) p += '<span class="pill">' + s.sqlCount + ' SQL</span>';
    if (s.redisCount > 0) p += '<span class="pill">' + s.redisCount + ' Redis</span>';
    if (s.httpCount > 0) p += '<span class="pill">' + s.httpCount + ' HTTP</span>';
    if (s.hasNPlusOne) p += '<span class="pill hot">N+1</span>';
    if (s.hasException) p += '<span class="pill hot">exception</span>';
    if (s.slow) p += '<span class="pill hot">slow</span>';
    return p || '<span class="muted">—</span>';
  }
  function matchesFilter(s) {
    if (!filter) return true;
    var hay = [s.method, s.url, s.event, s.namespace, s.statusCode].join(' ').toLowerCase();
    return hay.indexOf(filter.toLowerCase()) >= 0;
  }

  function listTable(items) {
    if (!items.length) return ${JSON.stringify(EMPTY_LIST)};
    var rows = '';
    for (var i = 0; i < items.length; i++) {
      var s = items[i];
      rows += '<tr class="row" onclick="go(\\'' + s.id + '\\')">'
        + '<td>' + typeBadge(s) + '</td>'
        + '<td>' + labelOf(s) + '</td>'
        + '<td>' + statusCell(s) + '</td>'
        + '<td>' + fmtMs(s.durationMs) + '</td>'
        + '<td>' + pillsOf(s) + '</td>'
        + '<td class="muted" title="' + escHtml(s.startedAt) + '">' + escHtml(relTime(s.startedAt)) + '</td>'
        + '</tr>';
    }
    return '<table><thead><tr><th>Type</th><th>Endpoint / Event</th><th>Status</th><th>Duration</th><th>Activity</th><th>Time</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderOverview() {
    if (!summaries.length) return ${JSON.stringify(EMPTY_LIST)};
    var total = summaries.length, durSum = 0, durN = 0, errs = 0, slow = 0, sql = 0, nplus = 0;
    for (var i = 0; i < summaries.length; i++) {
      var s = summaries[i];
      if (s.durationMs != null) { durSum += s.durationMs; durN++; }
      if (isError(s)) errs++;
      if (s.slow) slow++;
      sql += s.sqlCount || 0;
      if (s.hasNPlusOne) nplus++;
    }
    var avg = durN ? durSum / durN : 0;
    var errRate = total ? (errs / total * 100) : 0;
    function stat(mod, key, label, value, foot) {
      return '<div class="stat ' + mod + '"><div class="k">' + key + label + '</div><div class="v">' + value + '</div>'
        + (foot ? '<div class="foot">' + foot + '</div>' : '') + '</div>';
    }
    var ic = {
      req: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8"><path d="M4 8h13l-3-3"/><path d="M20 16H7l3 3"/></svg>',
      clock: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
      warn: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8"><path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
      db: '<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/></svg>'
    };
    var stats = '<div class="stat-grid">'
      + stat('', ic.req, 'Requests', total, 'captured this session')
      + stat('s-info', ic.clock, 'Avg latency', fmtMs(avg), 'across ' + durN + ' completed')
      + stat(errRate > 0 ? 's-err' : 's-ok', ic.warn, 'Error rate', errRate.toFixed(errRate < 10 ? 1 : 0) + '<small>%</small>', errs + ' failed')
      + stat(slow > 0 ? 's-warn' : 's-ok', ic.clock, 'Slow', slow, 'over threshold')
      + stat('', ic.db, 'SQL queries', sql, 'total executed')
      + stat(nplus > 0 ? 's-err' : 's-ok', ic.db, 'N+1 alerts', nplus, 'requests flagged')
      + '</div>';

    // Latency spark — most recent up to 44 requests, oldest→newest.
    var recent = summaries.slice(0, 44).slice().reverse();
    var max = 1;
    for (var j = 0; j < recent.length; j++) if ((recent[j].durationMs || 0) > max) max = recent[j].durationMs;
    var bars = '';
    for (var k = 0; k < recent.length; k++) {
      var r = recent[k];
      var h = Math.max(2, Math.round((r.durationMs || 0) / max * 92));
      var cls = isError(r) ? ' err' : (r.slow ? ' slow' : '');
      bars += '<div class="bar' + cls + '" style="height:' + h + 'px" title="' + escHtml(labelOfPlain(r)) + ' · ' + fmtMs(r.durationMs) + '"></div>';
    }
    var spark = '<div class="section"><h2>Latency <span class="tag">last ' + recent.length + ' requests</span></h2>'
      + '<div class="spark">' + (bars || '<span class="muted" style="margin:auto">no data</span>') + '</div>'
      + '<div class="spark-legend"><span><i style="background:var(--accent)"></i>normal</span><span><i style="background:var(--warn)"></i>slow</span><span><i style="background:var(--err)"></i>error</span></div></div>';

    var recList = '';
    var top = summaries.slice(0, 8);
    for (var m = 0; m < top.length; m++) {
      var t = top[m];
      recList += '<li onclick="go(\\'' + t.id + '\\')">' + typeBadge(t)
        + '<span class="lbl">' + labelOf(t) + '</span>'
        + '<span class="' + statusClass(t.kind === 'socket' ? null : t.statusCode) + '">' + fmtMs(t.durationMs) + '</span>'
        + '<span class="rt">' + escHtml(relTime(t.startedAt)) + '</span></li>';
    }
    var recent2 = '<div class="section"><h2>Recent activity</h2><ul class="recent">' + recList + '</ul></div>';

    return stats + '<div class="board">' + spark + recent2 + '</div>';
  }
  function labelOfPlain(s) {
    if (s.kind === 'socket') return (s.event || '—');
    return (s.method || '') + ' ' + (s.url || '');
  }

  function renderQueries() {
    if (queries == null) {
      if (!queriesLoading) loadQueries();
      return '<div class="empty">Loading queries…</div>';
    }
    var items = queries.filter(function (q) {
      if (!filter) return true;
      var hay = [q.sql, q.model, q.operation, q.source, q.requestLabel].join(' ').toLowerCase();
      return hay.indexOf(filter.toLowerCase()) >= 0;
    });
    if (!items.length) return ${JSON.stringify(EMPTY_LIST)};
    var head = queries.length >= 1000 ? '<div class="alert">Showing the 1000 most recent queries.</div>' : '';
    var rows = '';
    for (var i = 0; i < items.length; i++) {
      var q = items[i];
      var meta = '';
      if (q.source) meta += '<span class="pill">' + escHtml(q.source) + '</span>';
      var mo = [q.model, q.operation].filter(Boolean).join('.');
      if (mo) meta += '<span class="pill">' + escHtml(mo) + '</span>';
      rows += '<tr class="row" onclick="go(\\'' + q.requestId + '\\')">'
        + '<td><code style="font:12px ui-monospace,Menlo,monospace">' + escHtml((q.sql || '(no SQL)').slice(0, 140)) + '</code></td>'
        + '<td>' + (meta || '<span class="muted">—</span>') + '</td>'
        + '<td class="' + (q.slow ? 'warn' : '') + '">' + fmtMs(q.durationMs) + (q.slow ? ' <span class="pill hot">slow</span>' : '') + '</td>'
        + '<td class="muted">' + escHtml(q.requestLabel) + '</td>'
        + '</tr>';
    }
    return head + '<table><thead><tr><th>Query</th><th>Source</th><th>Duration</th><th>Request</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderLogs() {
    if (logs == null) {
      if (!logsLoading) loadLogs();
      return '<div class="empty">Loading logs…</div>';
    }
    var items = logs.filter(function (l) {
      if (!filter) return true;
      var hay = [l.level, l.message, l.context, l.requestLabel].join(' ').toLowerCase();
      return hay.indexOf(filter.toLowerCase()) >= 0;
    });
    if (!items.length) return ${JSON.stringify(EMPTY_LIST)};
    var head = logs.length >= 1000 ? '<div class="alert">Showing the 1000 most recent log lines.</div>' : '';
    var rows = '';
    for (var i = 0; i < items.length; i++) {
      var l = items[i];
      var lvl = ['error','warn','info','log','debug'].indexOf(l.level) >= 0 ? l.level : 'log';
      var msg = String(l.message == null ? '' : l.message);
      rows += '<tr class="row" onclick="go(\\'' + l.requestId + '\\')">'
        + '<td><span class="lvl lvl-' + lvl + '">' + escHtml(lvl) + '</span></td>'
        + '<td><code style="font:12px ui-monospace,Menlo,monospace;white-space:pre-wrap">' + escHtml(msg.slice(0, 200)) + '</code>'
        + (l.context ? ' <span class="pill">' + escHtml(l.context) + '</span>' : '') + '</td>'
        + '<td class="muted">' + escHtml(l.requestLabel) + '</td>'
        + '<td class="muted" title="' + escHtml(new Date(l.startedAt).toISOString()) + '">' + escHtml(relTime(new Date(l.startedAt).toISOString())) + '</td>'
        + '</tr>';
    }
    return head + '<table><thead><tr><th>Level</th><th>Message</th><th>Request</th><th>Time</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderView() {
    var el = document.getElementById('view');
    if (!el) return;
    if (view === 'overview') { el.innerHTML = renderOverview(); return; }
    if (view === 'queries') { el.innerHTML = renderQueries(); return; }
    if (view === 'logs') { el.innerHTML = renderLogs(); return; }
    var items = summaries.filter(matchesFilter);
    if (view === 'requests') items = items.filter(function (s) { return s.kind !== 'socket'; });
    else if (view === 'sockets') items = items.filter(function (s) { return s.kind === 'socket'; });
    else if (view === 'exceptions') items = items.filter(function (s) { return s.hasException; });
    else if (view === 'slow') items = items.filter(function (s) { return s.slow; });
    el.innerHTML = listTable(items);
  }

  ${NAV_COUNTS_FN}
  function updateCounts() { applyNavCounts(summaries); }

  function setLive(on, label) {
    var ind = document.getElementById('live-ind');
    if (ind) ind.classList.toggle('on', !!on);
    var txt = document.getElementById('live-text');
    if (txt) txt.textContent = label;
  }

  function applyRoute() {
    var h = (location.hash || '').replace(/^#\\//, '');
    if (!VIEWS[h]) h = 'overview';
    view = h;
    var links = document.querySelectorAll('.nav-item');
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle('active', links[i].getAttribute('data-view') === view);
    }
    var cfg = VIEWS[view];
    var title = document.getElementById('view-title');
    if (title) title.textContent = cfg.title;
    var search = document.getElementById('search');
    if (search) {
      var box = search.parentElement; // .search wrapper holds the icon + input
      if (box) box.style.display = cfg.search ? '' : 'none';
      if (!cfg.search) { filter = ''; search.value = ''; }
    }
    renderView();
  }

  function loadQueries() {
    queriesLoading = true;
    fetch(PREFIX + '?feed=queries', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { queries = (d && d.queries) || []; queriesLoading = false; if (view === 'queries') renderView(); })
      .catch(function () { queriesLoading = false; queries = []; if (view === 'queries') renderView(); });
  }

  function loadLogs() {
    logsLoading = true;
    fetch(PREFIX + '?feed=logs', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { logs = (d && d.logs) || []; logsLoading = false; if (view === 'logs') renderView(); })
      .catch(function () { logsLoading = false; logs = []; if (view === 'logs') renderView(); });
  }

  // A cheap fingerprint of the captured set. Only when it changes (a request
  // completed, or history was cleared) do we re-render — so idle polling never
  // disturbs the view or reloads the Queries list mid-read.
  function sigOf(items) {
    var sql = 0;
    for (var i = 0; i < items.length; i++) sql += items[i].sqlCount || 0;
    return items.length + '|' + (items.length ? items[0].id : '') + '|' + sql;
  }
  var lastSig = null;

  function refresh() {
    fetch(PREFIX, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (items) {
        items = items || [];
        var sig = sigOf(items);
        var changed = sig !== lastSig;
        lastSig = sig;
        summaries = items;
        updateCounts();
        setLive(auto, auto ? 'Live · ' + summaries.length + ' captured' : 'Paused');
        if (!changed) return; // nothing new — leave the current view untouched
        if (view !== 'queries') queries = null; // invalidate off-screen caches
        if (view !== 'logs') logs = null;
        if (view === 'queries') loadQueries(); // swaps in place when it resolves
        else if (view === 'logs') loadLogs();
        else renderView();
      })
      .catch(function () { setLive(false, 'Disconnected'); });
  }

  // ---- Global handlers (referenced from inline on* attributes) ----
  window.go = function (id) { location.href = PREFIX + '/' + id; };
  window.refresh = function () { lastSig = null; refresh(); };
  window.toggleAuto = function (btn) {
    auto = !auto;
    btn.textContent = auto ? 'Auto-refresh: on' : 'Auto-refresh: off';
    setLive(auto, auto ? 'Live · ' + summaries.length + ' captured' : 'Paused');
  };
  window.clearAll = function () { document.getElementById('clear-modal').classList.add('open'); };
  window.closeClearModal = function () { document.getElementById('clear-modal').classList.remove('open'); };
  window.confirmClear = function () {
    fetch(PREFIX, { method: 'DELETE' }).then(function () { closeClearModal(); queries = null; logs = null; lastSig = null; refresh(); });
  };

  document.getElementById('clear-modal').addEventListener('click', function (e) { if (e.target === this) closeClearModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeClearModal(); });
  var search = document.getElementById('search');
  if (search) search.addEventListener('input', function () { filter = search.value; renderView(); });
  window.addEventListener('hashchange', applyRoute);

  applyRoute();
  refresh();
  setInterval(function () { if (auto) refresh(); }, 2000);
})();`;
