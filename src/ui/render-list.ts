import { esc, layout, NAV_COUNTS_FN, SEARCH_ICON } from './html';

const EMPTY_LIST = `<div class="empty"><div class="big">Nothing here yet</div>Make a request, fire a socket event or run a job — then it shows up live.</div>`;

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
      <p>This removes every captured request, socket event and job. This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn" onclick="closeClearModal()">Cancel</button>
        <button class="btn solid-danger" onclick="confirmClear()">Clear all</button>
      </div>
    </div>
  </div>
  ${IGNORE_MODAL}
  <script>${CLIENT_SCRIPT.replace('__PREFIX__', esc(routePrefix))}</script>`;

  const topbar = `
    <h1 id="view-title">Overview</h1>
    <div class="search">${SEARCH_ICON}<input id="search" type="text" placeholder="Filter…" autocomplete="off" spellcheck="false"></div>
    <div class="spacer"></div>
    <button class="btn ghost" id="auto-btn" onclick="toggleAuto(this)">Auto-refresh: on</button>
    <button class="btn ghost" id="ignore-btn" onclick="openIgnore()" title="Skip noisy endpoints like health checks">Ignored</button>
    <button class="btn ghost" onclick="refresh()">Refresh</button>
    <button class="btn danger" onclick="clearAll()">Clear</button>`;

  return layout('nest-debug-panel', body, { routePrefix, active: 'overview', topbar, spa: true });
}

/**
 * The "Ignored endpoints" manager. A modal rather than a page: it's a settings
 * dialog you open, adjust and dismiss, and keeping it in the SPA means the list
 * behind it never has to reload.
 *
 * One form serves both add and edit — `submitIgnore()` decides which by whether
 * a row is being edited — so there's a single input path to validate.
 */
const IGNORE_MODAL = `
  <div class="modal-overlay" id="ignore-modal">
    <div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="ignore-title">
      <div class="modal-head">
        <h3 id="ignore-title">Ignored endpoints</h3>
        <span class="tag" id="ignore-count"></span>
      </div>
      <p>Requests matching these patterns are never captured — use it for health checks, metrics scrapes and other traffic that would otherwise fill the buffer.</p>
      <div id="ignore-form">
        <div class="field-row">
          <div class="grow"><input class="inp mono" id="ignore-pattern" type="text" placeholder="/health  or  /static/*" autocomplete="off" spellcheck="false"></div>
          <div class="grow"><input class="inp" id="ignore-note" type="text" placeholder="Note (optional)" autocomplete="off"></div>
          <button class="btn solid" id="ignore-submit" onclick="submitIgnore()">Add</button>
          <button class="btn" id="ignore-cancel" style="display:none" onclick="cancelIgnoreEdit()">Cancel</button>
        </div>
        <p class="form-note"><code>/health</code> also covers <code>/health/db</code>. Use <code>*</code> to match anything: <code>/v1/*/ping</code>.</p>
        <p class="form-err" id="ignore-error"></p>
      </div>
      <ul class="rule-list" id="ignore-list"></ul>
      <div class="modal-actions" style="margin-top:16px">
        <button class="btn" onclick="closeIgnore()">Done</button>
      </div>
    </div>
  </div>`;

/** All client behavior. `__PREFIX__` is replaced with the route prefix. */
const CLIENT_SCRIPT = `(function () {
  var PREFIX = '/__PREFIX__';
  var auto = true, filter = '', view = 'overview';
  var summaries = [], queries = null, queriesLoading = false, logs = null, logsLoading = false;
  var ignoreRules = [], ignoreEditable = true, ignoreEditingId = null;

  var VIEWS = {
    overview:   { title: 'Overview',   search: false },
    requests:   { title: 'Requests',   search: true, kind: 'http' },
    sockets:    { title: 'Sockets',    search: true, kind: 'socket' },
    jobs:       { title: 'Jobs',       search: true, kind: 'job' },
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
    if (s.kind === 'job') return '<span class="badge m-JOB">JOB</span>';
    return '<span class="badge ' + methodClass(s.method) + '">' + escHtml(s.method) + '</span>';
  }
  function labelOf(s) {
    if (s.kind === 'socket') {
      var ns = (s.namespace && s.namespace !== '/') ? ' <span class="muted">' + escHtml(s.namespace) + '</span>' : '';
      return escHtml(s.event == null ? '—' : s.event) + ns;
    }
    if (s.kind === 'job') {
      var q = s.queue ? ' <span class="muted">' + escHtml(s.queue) + '</span>' : '';
      return escHtml(s.jobName == null ? '—' : s.jobName) + q;
    }
    return escHtml(s.url);
  }
  function statusCell(s) {
    if (s.kind === 'socket' || s.kind === 'job') return s.hasException ? '<span class="err">failed</span>' : '<span class="ok">ok</span>';
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
    if (s.kind === 'job') return ((s.queue ? s.queue + ':' : '') + (s.jobName || '—'));
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
    if (view === 'requests') items = items.filter(function (s) { return s.kind !== 'socket' && s.kind !== 'job'; });
    else if (view === 'sockets') items = items.filter(function (s) { return s.kind === 'socket'; });
    else if (view === 'jobs') items = items.filter(function (s) { return s.kind === 'job'; });
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

  // ---- Ignored endpoints ----
  function ignoreError(msg) {
    var el = document.getElementById('ignore-error');
    if (el) el.textContent = msg || '';
  }

  function paintIgnoreButton() {
    var btn = document.getElementById('ignore-btn');
    if (!btn) return;
    var on = 0;
    for (var i = 0; i < ignoreRules.length; i++) if (ignoreRules[i].enabled) on++;
    btn.textContent = on > 0 ? 'Ignored · ' + on : 'Ignored';
  }

  function renderIgnore() {
    paintIgnoreButton();
    var count = document.getElementById('ignore-count');
    if (count) count.textContent = ignoreRules.length ? ignoreRules.length + ' rule' + (ignoreRules.length === 1 ? '' : 's') : '';
    // Read-only mode (runtimeIgnore: false) still lists config rules, so a
    // missing request can be explained — it just hides the editing controls.
    var form = document.getElementById('ignore-form');
    if (form) form.style.display = ignoreEditable ? '' : 'none';

    var list = document.getElementById('ignore-list');
    if (!list) return;
    if (!ignoreRules.length) {
      list.innerHTML = '<li class="rule"><span class="muted">Nothing ignored yet — every request is captured.</span></li>';
      return;
    }
    var html = '';
    for (var j = 0; j < ignoreRules.length; j++) {
      var r = ignoreRules[j];
      var fromConfig = r.source === 'config';
      var id = escHtml(r.id);
      var meta = [];
      if (fromConfig) meta.push('set in code');
      if (r.note) meta.push(escHtml(r.note));
      html += '<li class="rule' + (r.enabled ? '' : ' off') + '">'
        + '<div class="rule-main">'
        + '<div class="rule-pattern">' + escHtml(r.pattern) + '</div>'
        + (meta.length ? '<div class="rule-note">' + meta.join(' · ') + '</div>' : '')
        + '</div>';
      if (fromConfig || !ignoreEditable) {
        html += '<span class="pill">read-only</span>';
      } else {
        html += '<label class="toggle" title="Turn this rule off without deleting it">'
          + '<input type="checkbox"' + (r.enabled ? ' checked' : '') + ' onchange="toggleIgnore(\\'' + id + '\\', this.checked)"> on</label>'
          + '<div class="rule-acts">'
          + '<button class="btn mini" onclick="editIgnore(\\'' + id + '\\')">Edit</button>'
          + '<button class="btn mini danger" onclick="deleteIgnore(\\'' + id + '\\')">Delete</button>'
          + '</div>';
      }
      html += '</li>';
    }
    list.innerHTML = html;
  }

  function loadIgnore() {
    return fetch(PREFIX + '?feed=filters', { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        ignoreRules = (d && d.rules) || [];
        ignoreEditable = !d || d.editable !== false;
        renderIgnore();
      })
      .catch(function () { ignoreError('Could not load the rules.'); });
  }

  function ignoreFields() {
    return {
      pattern: document.getElementById('ignore-pattern'),
      note: document.getElementById('ignore-note'),
      submit: document.getElementById('ignore-submit'),
      cancel: document.getElementById('ignore-cancel')
    };
  }

  function resetIgnoreForm() {
    var f = ignoreFields();
    ignoreEditingId = null;
    if (f.pattern) f.pattern.value = '';
    if (f.note) f.note.value = '';
    if (f.submit) f.submit.textContent = 'Add';
    if (f.cancel) f.cancel.style.display = 'none';
    ignoreError('');
  }

  // ---- Global handlers (referenced from inline on* attributes) ----
  window.openIgnore = function () {
    resetIgnoreForm();
    document.getElementById('ignore-modal').classList.add('open');
    loadIgnore().then(function () {
      var f = ignoreFields();
      if (f.pattern && ignoreEditable) f.pattern.focus();
    });
  };
  window.closeIgnore = function () {
    document.getElementById('ignore-modal').classList.remove('open');
    resetIgnoreForm();
  };
  window.cancelIgnoreEdit = resetIgnoreForm;

  window.editIgnore = function (id) {
    var rule = null;
    for (var i = 0; i < ignoreRules.length; i++) if (ignoreRules[i].id === id) rule = ignoreRules[i];
    if (!rule) return;
    var f = ignoreFields();
    ignoreEditingId = id;
    if (f.pattern) { f.pattern.value = rule.pattern; f.pattern.focus(); }
    if (f.note) f.note.value = rule.note || '';
    if (f.submit) f.submit.textContent = 'Save';
    if (f.cancel) f.cancel.style.display = '';
    ignoreError('');
  };

  window.submitIgnore = function () {
    var f = ignoreFields();
    var pattern = f.pattern ? f.pattern.value.trim() : '';
    if (!pattern) { ignoreError('Enter a path to ignore.'); return; }
    var body = { pattern: pattern, note: f.note ? f.note.value.trim() : '' };
    var editing = ignoreEditingId;
    var url = editing ? PREFIX + '/filters/' + encodeURIComponent(editing) : PREFIX + '/filters';
    sendIgnore(editing ? 'PATCH' : 'POST', url, body);
  };

  window.toggleIgnore = function (id, enabled) {
    sendIgnore('PATCH', PREFIX + '/filters/' + encodeURIComponent(id), { enabled: !!enabled });
  };

  window.deleteIgnore = function (id) {
    sendIgnore('DELETE', PREFIX + '/filters/' + encodeURIComponent(id), null);
  };

  /**
   * One writer for every mutation. Rules are also sent as query params so the
   * request still carries them if the host app runs without a body parser.
   */
  function sendIgnore(method, url, body) {
    var full = url;
    if (body) {
      var qs = [];
      for (var k in body) if (body[k] !== undefined) qs.push(k + '=' + encodeURIComponent(body[k]));
      if (qs.length) full += (url.indexOf('?') >= 0 ? '&' : '?') + qs.join('&');
    }
    ignoreError('');
    fetch(full, {
      method: method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    })
      .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
      .then(function (d) {
        if (d && d.ok === false) { ignoreError(d.error || 'That did not work.'); return; }
        resetIgnoreForm();
        // A rule only affects future requests, so the captured list can't have
        // changed — reloading the rules is the one request this needs. The 2s
        // poll picks up everything else on its own.
        return loadIgnore();
      })
      .catch(function () { ignoreError('Request failed — is the app still running?'); });
  }


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
  document.getElementById('ignore-modal').addEventListener('click', function (e) { if (e.target === this) closeIgnore(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    closeClearModal();
    closeIgnore();
  });
  // Enter submits from either field — this dialog is mostly typing one path.
  var ignoreInputs = ['ignore-pattern', 'ignore-note'];
  for (var ii = 0; ii < ignoreInputs.length; ii++) {
    var inp = document.getElementById(ignoreInputs[ii]);
    if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitIgnore(); });
  }
  var search = document.getElementById('search');
  if (search) search.addEventListener('input', function () { filter = search.value; renderView(); });
  window.addEventListener('hashchange', applyRoute);

  applyRoute();
  refresh();
  loadIgnore(); // paints the topbar count so active rules are visible without opening the modal
  setInterval(function () { if (auto) refresh(); }, 2000);
})();`;
