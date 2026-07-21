import type { RequestSummary } from '../interfaces/profile.interface';
import { esc, formatMs, layout, statusClass } from './html';

function typeBadge(summary: RequestSummary): string {
  if (summary.kind === 'socket') return `<span class="badge m-WS">WS</span>`;
  const method = summary.method;
  const cls = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? `m-${method}` : 'm-OTHER';
  return `<span class="badge ${cls}">${esc(method)}</span>`;
}

function label(summary: RequestSummary): string {
  if (summary.kind === 'socket') {
    const ns = summary.namespace && summary.namespace !== '/' ? ` <span class="muted">${esc(summary.namespace)}</span>` : '';
    return `${esc(summary.event ?? '—')}${ns}`;
  }
  return esc(summary.url);
}

function statusCell(summary: RequestSummary): string {
  if (summary.kind === 'socket') {
    return summary.hasException
      ? '<span class="err">error</span>'
      : '<span class="muted">—</span>';
  }
  return `<span class="${statusClass(summary.statusCode)}">${summary.statusCode ?? '—'}</span>`;
}

function row(summary: RequestSummary, prefix: string): string {
  const pills = [
    summary.sqlCount > 0 ? `<span class="pill">${summary.sqlCount} SQL</span>` : '',
    summary.redisCount > 0 ? `<span class="pill">${summary.redisCount} Redis</span>` : '',
    summary.httpCount > 0 ? `<span class="pill">${summary.httpCount} HTTP</span>` : '',
    summary.hasException ? '<span class="pill hot">exception</span>' : '',
    summary.slow ? '<span class="pill hot">slow</span>' : '',
  ].join('');
  return `<tr class="row" data-kind="${esc(summary.kind)}" onclick="location.href='/${esc(prefix)}/${esc(summary.id)}'">
    <td>${typeBadge(summary)}</td>
    <td>${label(summary)}</td>
    <td>${statusCell(summary)}</td>
    <td>${formatMs(summary.durationMs)}</td>
    <td>${pills || '<span class="muted">—</span>'}</td>
    <td class="muted">${esc(new Date(summary.startedAt).toLocaleTimeString())}</td>
  </tr>`;
}

const EMPTY = `<tr><td colspan="6"><div class="empty">Nothing captured yet — make an API request or fire a socket event, then refresh.</div></td></tr>`;

export function renderListPage(summaries: RequestSummary[], routePrefix: string): string {
  const rows = summaries.map((summary) => row(summary, routePrefix)).join('\n');
  const body = `
  <div class="filters" id="filters">
    <button class="chip active" data-filter="all">All</button>
    <button class="chip" data-filter="http">HTTP</button>
    <button class="chip" data-filter="socket">Socket</button>
  </div>
  <table>
    <thead><tr><th>Type</th><th>Endpoint / Event</th><th>Status</th><th>Duration</th><th>Activity</th><th>Time</th></tr></thead>
    <tbody id="rows">${rows || EMPTY}</tbody>
  </table>
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
  <script>
    var PREFIX = '/${esc(routePrefix)}';
    var auto = true;
    var filter = 'all';
    var latest = [];
    function escHtml(v) {
      return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function methodClass(m) { return ['GET','POST','PUT','PATCH','DELETE'].indexOf(m) >= 0 ? 'm-' + m : 'm-OTHER'; }
    function statusClass(s) { if (s == null) return 'muted'; if (s >= 500) return 'err'; if (s >= 400) return 'warn'; if (s >= 300) return 'info'; return 'ok'; }
    function fmtMs(v) { if (v == null) return '—'; return v >= 1000 ? (v / 1000).toFixed(2) + 's' : v.toFixed(v < 10 ? 2 : 0) + 'ms'; }
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
    function render() {
      var items = latest.filter(function (s) { return filter === 'all' || s.kind === filter; });
      var html = '';
      for (var i = 0; i < items.length; i++) {
        var s = items[i];
        var pills = '';
        if (s.sqlCount > 0) pills += '<span class="pill">' + s.sqlCount + ' SQL</span>';
        if (s.redisCount > 0) pills += '<span class="pill">' + s.redisCount + ' Redis</span>';
        if (s.httpCount > 0) pills += '<span class="pill">' + s.httpCount + ' HTTP</span>';
        if (s.hasException) pills += '<span class="pill hot">exception</span>';
        if (s.slow) pills += '<span class="pill hot">slow</span>';
        html += '<tr class="row" onclick="location.href=\\'' + PREFIX + '/' + s.id + '\\'">'
          + '<td>' + typeBadge(s) + '</td>'
          + '<td>' + labelOf(s) + '</td>'
          + '<td>' + statusCell(s) + '</td>'
          + '<td>' + fmtMs(s.durationMs) + '</td>'
          + '<td>' + (pills || '<span class="muted">—</span>') + '</td>'
          + '<td class="muted">' + escHtml(new Date(s.startedAt).toLocaleTimeString()) + '</td>'
          + '</tr>';
      }
      if (!html) html = ${JSON.stringify(EMPTY)};
      document.getElementById('rows').innerHTML = html;
    }
    function refresh() {
      fetch(PREFIX, { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (items) { latest = items || []; render(); })
        .catch(function () {});
    }
    var chips = document.querySelectorAll('#filters .chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function (e) {
        for (var j = 0; j < chips.length; j++) chips[j].classList.remove('active');
        e.target.classList.add('active');
        filter = e.target.getAttribute('data-filter');
        render();
      });
    }
    function clearAll() { document.getElementById('clear-modal').classList.add('open'); }
    function closeClearModal() { document.getElementById('clear-modal').classList.remove('open'); }
    function confirmClear() {
      fetch(PREFIX, { method: 'DELETE' }).then(function () { closeClearModal(); refresh(); });
    }
    document.getElementById('clear-modal').addEventListener('click', function (event) {
      if (event.target === this) closeClearModal();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeClearModal();
    });
    function toggleAuto(btn) {
      auto = !auto;
      btn.textContent = auto ? 'Auto-refresh: on' : 'Auto-refresh: off';
    }
    refresh();
    setInterval(function () { if (auto) refresh(); }, 2000);
  </script>`;
  const headerExtra = `
    <button class="btn" onclick="toggleAuto(this)">Auto-refresh: on</button>
    <button class="btn" onclick="refresh()">Refresh</button>
    <button class="btn danger" onclick="clearAll()">Clear</button>`;
  return layout('nest-debug-panel', body, headerExtra);
}
