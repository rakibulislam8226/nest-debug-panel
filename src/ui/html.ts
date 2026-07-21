/** Escape a value for safe interpolation into HTML. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatMs(value: number | undefined): string {
  if (value === undefined) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(value < 10 ? 2 : 0)}ms`;
}

export function formatBytes(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

export function statusClass(status: number | undefined): string {
  if (status === undefined) return 'muted';
  if (status >= 500) return 'err';
  if (status >= 400) return 'warn';
  if (status >= 300) return 'info';
  return 'ok';
}

export function jsonBlock(value: unknown): string {
  if (value === undefined) return '<p class="muted">Not captured</p>';
  let json: string;
  try {
    json = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    json = String(value);
  }
  return `<pre class="code">${esc(json)}</pre>`;
}

export const BASE_STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117; --panel: #161b22; --panel2: #1c2129; --border: #2d333b;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --ok: #3fb950; --warn: #d29922; --err: #f85149; --info: #a371f7;
    --sidebar-w: 244px;
  }
  html, body { height: 100%; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  a { color: var(--accent); text-decoration: none; }

  /* ---- App shell: fixed sidebar + scrolling content ---- */
  .app { display: grid; grid-template-columns: var(--sidebar-w) 1fr; min-height: 100vh; }
  .sidebar {
    position: sticky; top: 0; align-self: start; height: 100vh;
    display: flex; flex-direction: column;
    background: linear-gradient(180deg, #12161d 0%, var(--panel) 100%);
    border-right: 1px solid var(--border);
  }
  .content { min-width: 0; display: flex; flex-direction: column; }

  .brand { display: flex; align-items: center; gap: 11px; padding: 18px 18px 16px; transition: opacity .12s; }
  .brand:hover { opacity: 0.85; }
  .brand-mark { flex: none; display: block; filter: drop-shadow(0 2px 6px rgba(0,0,0,0.35)); }
  .brand-text { display: flex; flex-direction: column; line-height: 1.15; }
  .brand-name { font-size: 14px; font-weight: 600; letter-spacing: 0.01em; color: var(--text); }
  .brand-name b { color: #ff5277; font-weight: 600; }
  .brand-sub { font-size: 10px; color: var(--muted); letter-spacing: 0.16em; text-transform: uppercase; margin-top: 1px; }

  .nav { padding: 6px 12px; overflow-y: auto; flex: 1; }
  .nav-section { font-size: 10px; letter-spacing: 0.13em; text-transform: uppercase; color: var(--muted); padding: 14px 10px 6px; opacity: 0.75; }
  .nav-item {
    display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 7px;
    color: var(--muted); font-size: 13.5px; font-weight: 500; margin-bottom: 1px;
    border: 1px solid transparent; position: relative; transition: background .12s, color .12s;
  }
  .nav-item:hover { background: rgba(255,255,255,0.035); color: var(--text); }
  .nav-item.active { background: rgba(88,166,255,0.12); color: var(--text); border-color: rgba(88,166,255,0.25); }
  .nav-item.active::before { content: ''; position: absolute; left: -12px; top: 50%; transform: translateY(-50%); width: 3px; height: 18px; border-radius: 0 3px 3px 0; background: var(--accent); }
  .nav-ico { flex: none; display: grid; place-items: center; width: 18px; height: 18px; color: currentColor; opacity: 0.9; }
  .nav-ico svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
  .nav-label { flex: 1; }
  .nav-count { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--muted); background: var(--panel2); border: 1px solid var(--border); border-radius: 20px; padding: 1px 8px; min-width: 22px; text-align: center; }
  .nav-item.active .nav-count { color: var(--text); }
  .nav-count.hot { color: var(--err); border-color: rgba(248,81,73,0.4); background: rgba(248,81,73,0.1); }
  .nav-count:empty { display: none; }

  .side-foot { padding: 12px 16px 14px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 9px; }
  .live { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
  .live.on .live-dot { background: var(--ok); box-shadow: 0 0 0 0 rgba(63,185,80,0.6); animation: pulse 1.8s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(63,185,80,0.5); } 70% { box-shadow: 0 0 0 6px rgba(63,185,80,0); } 100% { box-shadow: 0 0 0 0 rgba(63,185,80,0); } }
  .side-foot .author { font-size: 12px; color: var(--muted); }
  .side-foot .author a { color: var(--text); font-weight: 600; }
  .side-foot .author a:hover { color: var(--accent); }
  .side-foot .gh { vertical-align: -2px; fill: currentColor; }

  /* ---- Topbar ---- */
  .topbar {
    position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 14px;
    padding: 0 26px; height: 58px; border-bottom: 1px solid var(--border);
    backdrop-filter: blur(8px); background: rgba(13,17,23,0.82);
  }
  .topbar h1 { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; }
  .topbar .sub { color: var(--muted); font-size: 12.5px; font-weight: 400; margin-left: 2px; }
  .topbar .spacer { flex: 1; }
  .search { position: relative; }
  .search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 15px; height: 15px; stroke: var(--muted); fill: none; stroke-width: 1.8; pointer-events: none; }
  .search input {
    background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 7px;
    padding: 7px 12px 7px 32px; font-size: 13px; width: 230px; outline: none; transition: border-color .12s, width .12s;
  }
  .search input:focus { border-color: var(--accent); width: 280px; }
  .search input::placeholder { color: var(--muted); }
  main { padding: 24px 26px 48px; flex: 1; min-width: 0; overflow-x: auto; }

  .btn { background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
  .btn:hover { border-color: var(--accent); }
  .btn.danger:hover { border-color: var(--err); color: var(--err); }
  .btn.ghost { background: transparent; }

  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); padding: 10px 14px; border-bottom: 1px solid var(--border); }
  td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tr.row { cursor: pointer; }
  tr.row:hover { background: var(--panel2); }
  tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 5px; font-size: 11px; font-weight: 700; }
  .m-GET { background: #1f3a5f; color: #79b8ff; }
  .m-POST { background: #1f4a2e; color: #7ee2a0; }
  .m-PUT, .m-PATCH { background: #4a3a1f; color: #e2c57e; }
  .m-DELETE { background: #4a1f1f; color: #ff9e9e; }
  .m-WS { background: #3a1f4a; color: #d79eff; }
  .m-OTHER { background: var(--panel2); color: var(--muted); }
  .lvl { display: inline-block; padding: 2px 8px; border-radius: 5px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
  .lvl-error { background: rgba(248,81,73,0.15); color: var(--err); }
  .lvl-warn { background: rgba(210,153,34,0.15); color: var(--warn); }
  .lvl-info { background: rgba(88,166,255,0.15); color: var(--accent); }
  .lvl-log { background: var(--panel2); color: var(--muted); }
  .lvl-debug { background: rgba(163,113,247,0.15); color: var(--info); }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .err { color: var(--err); }
  .info { color: var(--info); } .muted { color: var(--muted); }
  .pill { display: inline-block; background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; font-size: 11px; color: var(--muted); margin-right: 4px; }
  .pill.hot { border-color: var(--warn); color: var(--warn); }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 18px 0; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
  .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .card .value { font-size: 18px; font-weight: 700; margin-top: 4px; word-break: break-all; }

  /* ---- Overview dashboard ---- */
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 14px; margin-bottom: 22px; }
  .stat {
    background: linear-gradient(180deg, var(--panel) 0%, #13181f 100%);
    border: 1px solid var(--border); border-radius: 11px; padding: 16px 18px; position: relative; overflow: hidden;
  }
  .stat::after { content: ''; position: absolute; inset: 0 0 auto 0; height: 2px; background: var(--accent); opacity: 0.5; }
  .stat.s-ok::after { background: var(--ok); } .stat.s-warn::after { background: var(--warn); } .stat.s-err::after { background: var(--err); } .stat.s-info::after { background: var(--info); }
  .stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); display: flex; align-items: center; gap: 7px; }
  .stat .k svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 1.8; opacity: 0.8; }
  .stat .v { font-size: 27px; font-weight: 700; margin-top: 8px; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; line-height: 1; }
  .stat .v small { font-size: 14px; font-weight: 600; color: var(--muted); margin-left: 2px; }
  .stat .foot { font-size: 12px; color: var(--muted); margin-top: 6px; }

  .board { display: grid; grid-template-columns: 1.35fr 1fr; gap: 16px; align-items: start; }
  @media (max-width: 900px) { .board { grid-template-columns: 1fr; } }
  .section { background: var(--panel); border: 1px solid var(--border); border-radius: 11px; overflow: hidden; }
  .section > h2 { font-size: 13px; font-weight: 600; padding: 13px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
  .section > h2 .tag { margin-left: auto; font-size: 11px; font-weight: 500; color: var(--muted); }
  .section .body { padding: 6px 0; }
  .spark { display: flex; align-items: flex-end; gap: 3px; height: 116px; padding: 18px 16px 12px; }
  .spark .bar { flex: 1; min-width: 2px; border-radius: 3px 3px 0 0; background: var(--accent); opacity: 0.85; transition: height .2s; min-height: 2px; }
  .spark .bar.slow { background: var(--warn); } .spark .bar.err { background: var(--err); }
  .spark-legend { display: flex; gap: 16px; padding: 0 16px 14px; font-size: 11.5px; color: var(--muted); }
  .spark-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  .recent { list-style: none; }
  .recent li { display: flex; align-items: center; gap: 10px; padding: 9px 16px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .recent li:last-child { border-bottom: none; }
  .recent li:hover { background: var(--panel2); }
  .recent .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .recent .rt { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }

  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin: 20px 0 16px; flex-wrap: wrap; }
  .tab { padding: 8px 14px; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent; font-size: 13px; }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .panel { display: none; }
  .panel.active { display: block; }
  .code { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px; overflow-x: auto; font: 12px/1.6 ui-monospace, 'SF Mono', Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
  .event { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; }
  .event .head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
  .event .num { color: var(--muted); font-size: 12px; }
  .event .dur { margin-left: auto; font-weight: 700; font-size: 13px; }
  .event .dur.slow { color: var(--err); }
  .event pre { font: 12px/1.6 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word; color: #c9d1d9; }
  .event .src { font-size: 12px; color: var(--muted); cursor: pointer; }
  .event .src:hover { color: var(--accent); }
  .alert { border: 1px solid var(--warn); background: rgba(210,153,34,0.08); color: var(--warn); border-radius: 8px; padding: 10px 14px; margin-bottom: 10px; font-size: 13px; }
  .alert.error { border-color: var(--err); background: rgba(248,81,73,0.08); color: var(--err); }
  .tl { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 8px 0; }
  .tl-row { display: grid; grid-template-columns: 90px 1fr; gap: 12px; padding: 6px 16px; align-items: center; }
  .tl-row:hover { background: var(--panel2); }
  .tl-at { color: var(--muted); font: 12px ui-monospace, Menlo, monospace; text-align: right; }
  .tl-track { position: relative; height: 20px; }
  .tl-bar { position: absolute; top: 3px; height: 14px; border-radius: 3px; min-width: 3px; opacity: 0.9; }
  .tl-label { position: absolute; left: 0; top: 0; font-size: 12px; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; padding-left: 2px; text-shadow: 0 1px 2px rgba(0,0,0,0.8); }
  .k-request { background: var(--accent); } .k-response { background: var(--accent); }
  .k-sql { background: var(--ok); } .k-redis { background: var(--err); }
  .k-http { background: var(--info); } .k-custom { background: var(--warn); }
  .k-exception { background: var(--err); }
  .kv { width: auto; min-width: 50%; }
  .kv td:first-child { color: var(--muted); white-space: nowrap; padding-right: 24px; }
  .empty { text-align: center; color: var(--muted); padding: 48px 0; }
  .empty .big { font-size: 15px; color: var(--text); margin-bottom: 6px; }
  .filters { display: flex; gap: 6px; margin-bottom: 14px; }
  .chip { background: var(--panel2); color: var(--muted); border: 1px solid var(--border); border-radius: 20px; padding: 5px 16px; font-size: 13px; cursor: pointer; }
  .chip:hover { border-color: var(--accent); }
  .chip.active { background: var(--accent); border-color: var(--accent); color: #04121f; font-weight: 600; }
  .pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .pager-bottom { border-top: 1px solid var(--border); padding-top: 14px; margin: 16px 0 2px; }
  .pager-center { display: flex; align-items: center; gap: 12px; }
  .pager-status { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .pager-nav { background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 16px; font-size: 13px; cursor: pointer; }
  .pager-nav:hover:not(:disabled) { border-color: var(--accent); }
  .pager-nav:disabled { opacity: 0.4; cursor: default; }
  .pager-size { background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
  .pager-size:hover, .pager-size:focus { outline: none; border-color: var(--accent); }
  .crumb { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
  .crumb:hover { color: var(--accent); }
  .modal-overlay { position: fixed; inset: 0; background: rgba(1,4,9,0.6); display: none; align-items: center; justify-content: center; z-index: 100; }
  .modal-overlay.open { display: flex; }
  .modal { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 22px 24px; width: 360px; max-width: calc(100vw - 32px); box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
  .modal h3 { font-size: 15px; margin-bottom: 6px; }
  .modal p { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .btn.solid-danger { background: #b62324; border-color: #b62324; color: #fff; }
  .btn.solid-danger:hover { background: var(--err); border-color: var(--err); color: #fff; }

  @media (max-width: 720px) {
    /* Sidebar becomes a top bar: brand row, then a single scrollable icon nav. */
    .app { grid-template-columns: 1fr; }
    .sidebar {
      position: sticky; top: 0; z-index: 20; height: auto; min-width: 0;
      flex-direction: column; border-right: none; border-bottom: 1px solid var(--border);
    }
    .brand { padding: 12px 16px; }
    .nav {
      flex: none; padding: 0 8px 8px; gap: 2px;
      display: flex; flex-wrap: nowrap; overflow-x: auto;
      -webkit-overflow-scrolling: touch; scrollbar-width: none;
    }
    .nav::-webkit-scrollbar { display: none; }
    .nav-section { display: none; }
    .nav-item { flex: 0 0 auto; margin: 0; padding: 7px 10px; }
    .nav-item.active::before { display: none; }
    .nav-label { display: none; }
    /* Label only the active monitor, so the icon row stays readable. */
    .nav-item.active .nav-label { display: inline; }
    .side-foot { display: none; }

    /* Top bar wraps; search drops to its own full-width row. */
    .topbar { position: static; height: auto; padding: 10px 16px; flex-wrap: wrap; row-gap: 8px; }
    .topbar .spacer { display: none; }
    .topbar .btn { font-size: 12px; padding: 6px 10px; }
    .search { order: 5; flex: 1 1 100%; }
    .search input, .search input:focus { width: 100%; }
    main { padding: 16px; }
  }
`;

/** Pulse-ring mark, reused as favicon (data URI) and header logo. */
function brandMark(size: number): string {
  return `<svg class="brand-mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">
    <rect width="64" height="64" rx="14" fill="#161b22"/>
    <rect x="1.5" y="1.5" width="61" height="61" rx="12.5" fill="none" stroke="#2d333b" stroke-width="3"/>
    <circle cx="32" cy="32" r="17" fill="none" stroke="#e0234e" stroke-width="5"/>
    <path d="M13 32h9l4-9 9 18 4-9h12" fill="none" stroke="#58a6ff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" rx="14" fill="#0d1117"/>' +
      '<circle cx="32" cy="32" r="17" fill="none" stroke="#e0234e" stroke-width="6"/>' +
      '<path d="M13 32h9l4-9 9 18 4-9h12" fill="none" stroke="#58a6ff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>',
  );

const LINKEDIN_ICON =
  '<svg class="gh" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.6 0H2.4A2.4 2.4 0 0 0 0 2.4v11.2A2.4 2.4 0 0 0 2.4 16h11.2a2.4 2.4 0 0 0 2.4-2.4V2.4A2.4 2.4 0 0 0 13.6 0zM4.9 13.4H2.6V6h2.3v7.4zM3.7 5A1.34 1.34 0 1 1 5 3.66 1.34 1.34 0 0 1 3.7 5zm9.7 8.4h-2.3V9.8c0-.86-.02-1.97-1.2-1.97s-1.38.94-1.38 1.9v3.67H6.2V6h2.2v1h.03a2.42 2.42 0 0 1 2.18-1.2c2.33 0 2.76 1.53 2.76 3.53v4.06z"/></svg>';

const SEARCH_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

/** Nav icons — stroke-based, inherit currentColor. */
const NAV_ICONS: Record<string, string> = {
  overview:
    '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  requests:
    '<svg viewBox="0 0 24 24"><path d="M4 8h13l-3-3"/><path d="M20 16H7l3 3"/></svg>',
  sockets:
    '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  queries:
    '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
  logs:
    '<svg viewBox="0 0 24 24"><path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v6h6"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>',
  exceptions:
    '<svg viewBox="0 0 24 24"><path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  slow:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/></svg>',
};

interface NavItem {
  key: string;
  label: string;
  /** true → count badge turns red when > 0 */
  hot?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'requests', label: 'Requests' },
  { key: 'sockets', label: 'Sockets' },
  { key: 'queries', label: 'Queries' },
  { key: 'logs', label: 'Logs' },
  { key: 'exceptions', label: 'Exceptions', hot: true },
  { key: 'slow', label: 'Slow', hot: true },
];

/**
 * Render the left sidebar. `base` prefixes the hash links: '' on the SPA home
 * (in-page routing), `/<prefix>` on the detail page (navigates back home).
 * Count badges carry `data-count="<key>"` so each page can fill them live.
 */
export function renderSidebar(active: string, base: string): string {
  const items = NAV_ITEMS.map((item) => {
    const cls = item.key === active ? 'nav-item active' : 'nav-item';
    const hot = item.hot ? ' hot-count' : '';
    return `<a class="${cls}" href="${base}#/${item.key}" data-view="${item.key}">
      <span class="nav-ico">${NAV_ICONS[item.key] ?? ''}</span>
      <span class="nav-label">${esc(item.label)}</span>
      <span class="nav-count${hot}" data-count="${item.key}"></span>
    </a>`;
  }).join('');
  return `<aside class="sidebar">
    <a class="brand" href="${base}#/overview" aria-label="Nest Debug Panel — Overview">
      ${brandMark(32)}
      <div class="brand-text">
        <span class="brand-name">Nest <b>Debug Panel</b></span>
        <span class="brand-sub">Request Profiler</span>
      </div>
    </a>
    <nav class="nav">
      <div class="nav-section">Monitors</div>
      ${items}
    </nav>
    <div class="side-foot">
      <div class="live" id="live-ind"><span class="live-dot"></span><span id="live-text">Connecting…</span></div>
      <div class="author">Crafted by <a href="https://bd.linkedin.com/in/rakibulislam8226" target="_blank" rel="noopener noreferrer">${LINKEDIN_ICON} Rakibul Islam</a></div>
    </div>
  </aside>`;
}

interface LayoutOptions {
  routePrefix: string;
  /** Active sidebar item key. */
  active: string;
  /** Topbar contents (title, actions). */
  topbar?: string;
  /** true → sidebar links use in-page hashes (SPA home). */
  spa?: boolean;
}

export function layout(title: string, body: string, opts: LayoutOptions): string {
  const base = opts.spa ? '' : `/${opts.routePrefix}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<style>${BASE_STYLES}</style>
</head>
<body>
<div class="app">
  ${renderSidebar(opts.active, base)}
  <div class="content">
    <div class="topbar">${opts.topbar ?? `<h1>${esc(title)}</h1>`}</div>
    <main>${body}</main>
  </div>
</div>
</body>
</html>`;
}

/**
 * Client-side helper (emitted verbatim into both the list and detail pages):
 * derive the monitor tallies from a summaries array and paint the sidebar
 * count badges. One definition keeps the count keys in a single place.
 */
export const NAV_COUNTS_FN = `function applyNavCounts(summaries) {
  var http = 0, sock = 0, sql = 0, log = 0, exc = 0, slow = 0;
  for (var i = 0; i < summaries.length; i++) {
    var s = summaries[i];
    if (s.kind === 'socket') sock++; else http++;
    sql += s.sqlCount || 0;
    log += s.logCount || 0;
    if (s.hasException) exc++;
    if (s.slow) slow++;
  }
  var map = { requests: http, sockets: sock, queries: sql, logs: log, exceptions: exc, slow: slow };
  var els = document.querySelectorAll('.nav-count');
  for (var j = 0; j < els.length; j++) {
    var key = els[j].getAttribute('data-count');
    if (!(key in map)) continue;
    var n = map[key];
    els[j].textContent = n > 0 ? (n > 999 ? '999+' : n) : '';
    if (els[j].classList.contains('hot-count')) els[j].classList.toggle('hot', n > 0);
  }
  return map;
}`;

export { SEARCH_ICON };
