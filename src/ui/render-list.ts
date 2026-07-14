import type { RequestSummary } from '../interfaces/profile.interface';
import { esc, formatMs, layout, statusClass } from './html';

function methodClass(method: string): string {
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? `m-${method}` : 'm-OTHER';
}

function row(summary: RequestSummary, prefix: string): string {
  const pills = [
    summary.sqlCount > 0 ? `<span class="pill">${summary.sqlCount} SQL</span>` : '',
    summary.redisCount > 0 ? `<span class="pill">${summary.redisCount} Redis</span>` : '',
    summary.httpCount > 0 ? `<span class="pill">${summary.httpCount} HTTP</span>` : '',
    summary.hasException ? '<span class="pill hot">exception</span>' : '',
    summary.slow ? '<span class="pill hot">slow</span>' : '',
  ].join('');
  return `<tr class="row" onclick="location.href='/${esc(prefix)}/${esc(summary.id)}'">
    <td><span class="badge ${methodClass(summary.method)}">${esc(summary.method)}</span></td>
    <td>${esc(summary.url)}</td>
    <td class="${statusClass(summary.statusCode)}">${summary.statusCode ?? '—'}</td>
    <td>${formatMs(summary.durationMs)}</td>
    <td>${pills || '<span class="muted">—</span>'}</td>
    <td class="muted">${esc(new Date(summary.startedAt).toLocaleTimeString())}</td>
  </tr>`;
}

export function renderListPage(summaries: RequestSummary[], routePrefix: string): string {
  const rows = summaries.map((summary) => row(summary, routePrefix)).join('\n');
  const body = `
  <table>
    <thead><tr><th>Method</th><th>URL</th><th>Status</th><th>Duration</th><th>Activity</th><th>Time</th></tr></thead>
    <tbody id="rows">${rows || `<tr><td colspan="6"><div class="empty">No requests captured yet — make a request to your API and refresh.</div></td></tr>`}</tbody>
  </table>
  <div class="modal-overlay" id="clear-modal">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="clear-title">
      <h3 id="clear-title">Clear all requests?</h3>
      <p>This removes every captured request profile. This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn" onclick="closeClearModal()">Cancel</button>
        <button class="btn solid-danger" onclick="confirmClear()">Clear all</button>
      </div>
    </div>
  </div>
  <script>
    var PREFIX = '/${esc(routePrefix)}';
    var auto = true;
    function escHtml(v) {
      return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function methodClass(m) { return ['GET','POST','PUT','PATCH','DELETE'].indexOf(m) >= 0 ? 'm-' + m : 'm-OTHER'; }
    function statusClass(s) { if (s == null) return 'muted'; if (s >= 500) return 'err'; if (s >= 400) return 'warn'; if (s >= 300) return 'info'; return 'ok'; }
    function fmtMs(v) { if (v == null) return '—'; return v >= 1000 ? (v / 1000).toFixed(2) + 's' : v.toFixed(v < 10 ? 2 : 0) + 'ms'; }
    function render(items) {
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
          + '<td><span class="badge ' + methodClass(s.method) + '">' + escHtml(s.method) + '</span></td>'
          + '<td>' + escHtml(s.url) + '</td>'
          + '<td class="' + statusClass(s.statusCode) + '">' + (s.statusCode == null ? '—' : s.statusCode) + '</td>'
          + '<td>' + fmtMs(s.durationMs) + '</td>'
          + '<td>' + (pills || '<span class="muted">—</span>') + '</td>'
          + '<td class="muted">' + escHtml(new Date(s.startedAt).toLocaleTimeString()) + '</td>'
          + '</tr>';
      }
      if (!html) html = '<tr><td colspan="6"><div class="empty">No requests captured yet — make a request to your API and refresh.</div></td></tr>';
      document.getElementById('rows').innerHTML = html;
    }
    function refresh() {
      fetch(PREFIX, { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(render)
        .catch(function () {});
    }
    function clearAll() {
      document.getElementById('clear-modal').classList.add('open');
    }
    function closeClearModal() {
      document.getElementById('clear-modal').classList.remove('open');
    }
    function confirmClear() {
      fetch(PREFIX, { method: 'DELETE' }).then(function () {
        closeClearModal();
        refresh();
      });
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
    setInterval(function () { if (auto) refresh(); }, 2000);
  </script>`;
  const headerExtra = `
    <button class="btn" onclick="toggleAuto(this)">Auto-refresh: on</button>
    <button class="btn" onclick="refresh()">Refresh</button>
    <button class="btn danger" onclick="clearAll()">Clear</button>`;
  return layout('nest-debug-panel — requests', body, headerExtra);
}
