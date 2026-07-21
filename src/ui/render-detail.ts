import type { RequestProfile, TimelineEvent } from '../interfaces/profile.interface';
import { esc, formatBytes, formatMs, jsonBlock, layout, statusClass } from './html';

function renderCards(cards: Array<[string, string, string?]>): string {
  return `<div class="cards">${cards
    .map(
      ([label, value, cls]) =>
        `<div class="card"><div class="label">${esc(label)}</div><div class="value ${cls ?? ''}">${esc(value)}</div></div>`,
    )
    .join('')}</div>`;
}

function kvTable(rows: Array<[string, string]>): string {
  return `<table class="kv">${rows
    .map(([key, value]) => `<tr><td>${esc(key)}</td><td>${esc(value)}</td></tr>`)
    .join('')}</table>`;
}

function overviewCards(profile: RequestProfile): string {
  return renderCards([
    ['Status', String(profile.statusCode ?? '—'), statusClass(profile.statusCode)],
    ['Duration', formatMs(profile.durationMs), profile.slow ? 'err' : undefined],
    ['SQL queries', String(profile.sql.length)],
    ['Redis commands', String(profile.redis.length)],
    ['HTTP calls', String(profile.http.length)],
    ['Response size', formatBytes(profile.responseSize)],
    ['IP', profile.ip ?? '—'],
    ['Time', new Date(profile.startedAt).toLocaleTimeString()],
  ]);
}

function socketOverviewCards(profile: RequestProfile): string {
  const socket = profile.socket;
  return renderCards([
    ['Event', socket?.event ?? '—'],
    ['Namespace', socket?.namespace ?? '/'],
    ['Duration', formatMs(profile.durationMs), profile.slow ? 'err' : undefined],
    ['SQL queries', String(profile.sql.length)],
    ['Redis commands', String(profile.redis.length)],
    ['HTTP calls', String(profile.http.length)],
    ['Socket ID', socket?.socketId ?? '—'],
    ['Time', new Date(profile.startedAt).toLocaleTimeString()],
  ]);
}

function socketPanel(profile: RequestProfile): string {
  const socket = profile.socket;
  if (!socket) return '<div class="empty">No socket metadata</div>';
  const rows: Array<[string, string]> = [
    ['Event', socket.event],
    ['Namespace', socket.namespace ?? '/'],
    ['Socket ID', socket.socketId ?? '—'],
    ['Rooms', socket.rooms && socket.rooms.length ? socket.rooms.join(', ') : '—'],
  ];
  const meta = kvTable(rows);
  const heading = (text: string) => `<h3 style="margin:18px 0 6px;font-size:14px;">${esc(text)}</h3>`;
  return `${meta}
    ${heading('Payload')}${jsonBlock(profile.body)}
    ${heading('Acknowledgement')}${jsonBlock(socket.ack)}
    ${socket.handshake ? `${heading('Handshake')}${jsonBlock(socket.handshake)}` : ''}`;
}

function timelinePanel(profile: RequestProfile): string {
  const total = Math.max(profile.durationMs ?? 1, 1);
  const rows = profile.timeline
    .map((event: TimelineEvent) => {
      const left = Math.min((event.at / total) * 100, 99);
      const width = event.durationMs !== undefined ? Math.min((event.durationMs / total) * 100, 100 - left) : 0.5;
      const duration = event.durationMs !== undefined ? ` (${formatMs(event.durationMs)})` : '';
      return `<div class="tl-row">
        <div class="tl-at">${formatMs(event.at)}</div>
        <div class="tl-track">
          <div class="tl-bar k-${esc(event.kind)}" style="left:${left.toFixed(2)}%;width:${Math.max(width, 0.5).toFixed(2)}%"></div>
          <div class="tl-label">${esc(event.label)}${esc(duration)}</div>
        </div>
      </div>`;
    })
    .join('');
  return `<div class="tl">${rows || '<div class="empty">No timeline events</div>'}</div>`;
}

function sqlPanel(profile: RequestProfile, slowQueryThreshold: number): string {
  const analysis = profile.sqlAnalysis;
  if (profile.sql.length === 0) return '<div class="empty">No SQL queries captured</div>';

  let alerts = '';
  if (analysis) {
    for (const group of analysis.possibleNPlusOne) {
      alerts += `<div class="alert">⚠ Possible N+1 — executed ${group.count}× (${formatMs(group.totalTimeMs)} total):<br><code>${esc(group.sql.slice(0, 200))}</code></div>`;
    }
    for (const group of analysis.duplicates.filter(
      (dup) => !analysis.possibleNPlusOne.includes(dup),
    )) {
      alerts += `<div class="alert">Duplicate query — executed ${group.count}×: <code>${esc(group.sql.slice(0, 160))}</code></div>`;
    }
  }

  const summary = analysis
    ? `<div class="cards">
        <div class="card"><div class="label">Total queries</div><div class="value">${analysis.totalQueries}</div></div>
        <div class="card"><div class="label">Total SQL time</div><div class="value">${formatMs(analysis.totalTimeMs)}</div></div>
        <div class="card"><div class="label">Slowest</div><div class="value">${
          analysis.slowestIndex >= 0 ? formatMs(profile.sql[analysis.slowestIndex]?.durationMs) : '—'
        }</div></div>
        <div class="card"><div class="label">Slow (≥${slowQueryThreshold}ms)</div><div class="value ${analysis.slowQueryCount > 0 ? 'warn' : ''}">${analysis.slowQueryCount}</div></div>
      </div>`
    : '';

  const items = profile.sql
    .map((query, index) => {
      const slow = query.durationMs >= slowQueryThreshold;
      const meta = [
        query.source ? `<span class="pill">${esc(query.source)}</span>` : '',
        query.model || query.operation
          ? `<span class="pill">${esc([query.model, query.operation].filter(Boolean).join('.'))}</span>`
          : '',
        query.transactionId ? `<span class="pill">tx ${esc(query.transactionId)}</span>` : '',
      ].join('');
      return `<div class="event">
        <div class="head"><span class="num">${index + 1}.</span>${meta}<span class="dur ${slow ? 'slow' : ''}">${formatMs(query.durationMs)}</span></div>
        <pre>${esc(query.sql ?? '(no SQL captured)')}</pre>
        ${query.params ? `<pre class="muted">params: ${esc(query.params)}</pre>` : ''}
      </div>`;
    })
    .join('');

  // Paginate the query list client-side so a heavy (e.g. N+1) request stays
  // navigable. All rows are rendered in the DOM — the JSON API and no-JS
  // fallback still see everything; only the visible window is limited. The
  // per-page selector re-slices instantly, no round-trip needed.
  const DEFAULT_PAGE_SIZE = 25;
  const MIN_PAGE_SIZE = 5;
  if (profile.sql.length <= MIN_PAGE_SIZE) return `${summary}${alerts}<div id="sql-events">${items}</div>`;

  const sizeOptions = [10, 25, 50, 100]
    .map((n) => `<option value="${n}"${n === DEFAULT_PAGE_SIZE ? ' selected' : ''}>${n} per page</option>`)
    .join('');
  const pager = `<div class="pager pager-bottom">
    <button class="pager-nav sql-prev" type="button">Previous</button>
    <div class="pager-center">
      <span class="pager-status sql-status"></span>
      <select class="pager-size sql-size" aria-label="Rows per page">${sizeOptions}</select>
    </div>
    <button class="pager-nav sql-next" type="button">Next</button>
  </div>`;
  const script = `<script>(function () {
    var size = ${DEFAULT_PAGE_SIZE}, page = 0;
    var events = [].slice.call(document.querySelectorAll('#sql-events > .event'));
    var status = [].slice.call(document.querySelectorAll('.sql-status'));
    var prev = [].slice.call(document.querySelectorAll('.sql-prev'));
    var next = [].slice.call(document.querySelectorAll('.sql-next'));
    var sizers = [].slice.call(document.querySelectorAll('.sql-size'));
    function pageCount() { return Math.max(1, Math.ceil(events.length / size)); }
    function render() {
      if (page > pageCount() - 1) page = pageCount() - 1;
      if (page < 0) page = 0;
      var start = page * size, end = Math.min(start + size, events.length);
      for (var i = 0; i < events.length; i++) events[i].style.display = (i >= start && i < end) ? '' : 'none';
      var text = 'Page ' + (page + 1) + ' of ' + pageCount();
      status.forEach(function (el) { el.textContent = text; });
      prev.forEach(function (el) { el.disabled = page === 0; });
      next.forEach(function (el) { el.disabled = page >= pageCount() - 1; });
    }
    prev.forEach(function (el) { el.addEventListener('click', function () { if (page > 0) { page--; render(); } }); });
    next.forEach(function (el) { el.addEventListener('click', function () { if (page < pageCount() - 1) { page++; render(); } }); });
    sizers.forEach(function (el) { el.addEventListener('change', function () {
      size = parseInt(el.value, 10) || ${DEFAULT_PAGE_SIZE};
      sizers.forEach(function (other) { other.value = el.value; });
      page = 0;
      render();
    }); });
    render();
  })();</script>`;

  return `${summary}${alerts}<div id="sql-events">${items}</div>${pager}${script}`;
}

function redisPanel(profile: RequestProfile): string {
  if (profile.redis.length === 0) return '<div class="empty">No Redis commands captured</div>';
  return profile.redis
    .map(
      (event, index) => `<div class="event">
      <div class="head"><span class="num">${index + 1}.</span><strong>${esc(event.command)}</strong>${
        event.error ? '<span class="pill hot">error</span>' : ''
      }<span class="dur">${formatMs(event.durationMs)}</span></div>
      <pre>${esc(event.args.join(' '))}</pre>
      ${event.error ? `<pre class="err">${esc(event.error)}</pre>` : ''}
    </div>`,
    )
    .join('');
}

function httpPanel(profile: RequestProfile): string {
  if (profile.http.length === 0) return '<div class="empty">No outgoing HTTP calls captured</div>';
  return profile.http
    .map(
      (event, index) => `<div class="event">
      <div class="head">
        <span class="num">${index + 1}.</span>
        <strong>${esc(event.method)}</strong>
        <span class="${statusClass(event.statusCode)}">${event.statusCode ?? '—'}</span>
        <span class="pill">${esc(event.source)}</span>
        <span class="dur">${formatMs(event.durationMs)}</span>
      </div>
      <pre>${esc(event.url)}</pre>
      <div class="muted" style="font-size:12px">request: ${formatBytes(event.requestSize)} · response: ${formatBytes(event.responseSize)}</div>
      ${event.error ? `<pre class="err">${esc(event.error)}</pre>` : ''}
    </div>`,
    )
    .join('');
}

function exceptionPanel(profile: RequestProfile): string {
  const exception = profile.exception;
  if (!exception) return '<div class="empty">No exception</div>';
  return `<div class="alert error"><strong>${esc(exception.name)}</strong>: ${esc(exception.message)}
    ${exception.statusCode !== undefined ? `(status ${exception.statusCode})` : ''} — thrown at ${formatMs(exception.at)}</div>
    ${exception.stack ? `<pre class="code">${esc(exception.stack)}</pre>` : ''}`;
}

function memoryPanel(profile: RequestProfile): string {
  const memory = profile.memory;
  if (!memory) return '<div class="empty">Memory profiling disabled</div>';
  const rows: Array<[string, string]> = [];
  if (memory.before) rows.push(['Heap used (start)', formatBytes(memory.before.heapUsed)]);
  if (memory.after) {
    rows.push(
      ['Heap used (end)', formatBytes(memory.after.heapUsed)],
      ['Heap total', formatBytes(memory.after.heapTotal)],
      ['RSS', formatBytes(memory.after.rss)],
      ['External', formatBytes(memory.after.external)],
    );
  }
  if (memory.heapUsedDelta !== undefined) {
    const sign = memory.heapUsedDelta >= 0 ? '+' : '−';
    rows.push(['Heap delta', `${sign}${formatBytes(Math.abs(memory.heapUsedDelta))}`]);
  }
  if (memory.eventLoopDelayMs !== undefined) rows.push(['Event loop delay (mean)', `${memory.eventLoopDelayMs}ms`]);
  return kvTable(rows);
}

export function renderDetailPage(
  profile: RequestProfile,
  routePrefix: string,
  slowQueryThreshold: number,
): string {
  const isSocket = profile.kind === 'socket';

  const commonPanels: Array<[string, string]> = [
    ['Timeline', timelinePanel(profile)],
    ['SQL', sqlPanel(profile, slowQueryThreshold)],
    ['Redis', redisPanel(profile)],
    ['HTTP', httpPanel(profile)],
    ['Exception', exceptionPanel(profile)],
    ['Memory', memoryPanel(profile)],
  ];
  const panels: Array<[string, string]> = isSocket
    ? [...commonPanels, ['Socket', socketPanel(profile)]]
    : [
        ...commonPanels,
        ['Headers', jsonBlock(profile.headers)],
        ['Body', jsonBlock(profile.body)],
        ['Response', jsonBlock(profile.responseBody)],
      ];

  const counts: Record<string, number> = {
    SQL: profile.sql.length,
    Redis: profile.redis.length,
    HTTP: profile.http.length,
  };

  const tabs = panels
    .map(([name], index) => {
      const count = counts[name] !== undefined ? ` (${counts[name]})` : '';
      const hot = name === 'Exception' && profile.exception ? ' 🔥' : '';
      return `<div class="tab ${index === 0 ? 'active' : ''}" data-tab="${name}">${name}${count}${hot}</div>`;
    })
    .join('');

  const panelDivs = panels
    .map(
      ([name, html], index) =>
        `<div class="panel ${index === 0 ? 'active' : ''}" data-panel="${name}">${html}</div>`,
    )
    .join('\n');

  const userRow =
    profile.user !== undefined
      ? `<tr><td>User</td><td><pre class="code" style="padding:6px 10px">${esc(JSON.stringify(profile.user))}</pre></td></tr>`
      : '';

  const heading = isSocket
    ? `<span class="badge m-WS">WS</span>
       ${esc(profile.socket?.event ?? '')}${
         profile.socket?.namespace
           ? ` <span class="muted" style="font-size:14px">on ${esc(profile.socket.namespace)}</span>`
           : ''
       }`
    : `<span class="badge m-${esc(profile.method)}">${esc(profile.method)}</span>
       ${esc(profile.url)}`;
  const idLabel = isSocket ? 'Event ID' : 'Request ID';

  const body = `
  <p><a href="/${esc(routePrefix)}">← Back to all</a></p>
  <h2 style="margin:12px 0 4px; font-size: 18px;">
    ${heading}
  </h2>
  ${!isSocket && profile.route ? `<div class="muted">route: ${esc(profile.route)}</div>` : ''}
  ${isSocket ? socketOverviewCards(profile) : overviewCards(profile)}
  <table class="kv">
    <tr><td>${idLabel}</td><td>${esc(profile.id)}</td></tr>
    <tr><td>Started</td><td>${esc(profile.startedAt)}</td></tr>
    ${userRow}
  </table>
  <div class="tabs">${tabs}</div>
  ${panelDivs}
  <script>
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
        tab.classList.add('active');
        document.querySelector('[data-panel="' + tab.getAttribute('data-tab') + '"]').classList.add('active');
      });
    });
  </script>`;

  const title = isSocket
    ? `nest-debug-panel — ${profile.socket?.event ?? 'socket'}`
    : `nest-debug-panel — ${profile.method} ${profile.url}`;
  return layout(title, body);
}
