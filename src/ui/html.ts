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
  }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; min-height: 100vh; }
  a { color: var(--accent); text-decoration: none; }
  header { display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
  header .spacer { flex: 1; }
  main { max-width: 1200px; margin: 0 auto; padding: 24px; }
  .btn { background: var(--panel2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
  .btn:hover { border-color: var(--accent); }
  .btn.danger:hover { border-color: var(--err); color: var(--err); }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); padding: 10px 14px; border-bottom: 1px solid var(--border); }
  td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tr.row { cursor: pointer; }
  tr.row:hover { background: var(--panel2); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 5px; font-size: 11px; font-weight: 700; }
  .m-GET { background: #1f3a5f; color: #79b8ff; }
  .m-POST { background: #1f4a2e; color: #7ee2a0; }
  .m-PUT, .m-PATCH { background: #4a3a1f; color: #e2c57e; }
  .m-DELETE { background: #4a1f1f; color: #ff9e9e; }
  .m-OTHER { background: var(--panel2); color: var(--muted); }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .err { color: var(--err); }
  .info { color: var(--info); } .muted { color: var(--muted); }
  .pill { display: inline-block; background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; font-size: 11px; color: var(--muted); margin-right: 4px; }
  .pill.hot { border-color: var(--warn); color: var(--warn); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 18px 0; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
  .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .card .value { font-size: 18px; font-weight: 700; margin-top: 4px; word-break: break-all; }
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
  header { padding: 0 24px; height: 56px; backdrop-filter: blur(8px); background: rgba(22,27,34,0.92); }
  .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; }
  .brand-mark { flex: none; display: block; }
  .brand-text { display: flex; flex-direction: column; line-height: 1.15; }
  .brand-name { font-size: 14px; font-weight: 600; letter-spacing: 0.01em; color: var(--text); }
  .brand-name b { color: #ff5277; font-weight: 600; }
  .brand-sub { font-size: 10.5px; color: var(--muted); letter-spacing: 0.14em; text-transform: uppercase; }
  footer { border-top: 1px solid var(--border); margin-top: 40px; padding: 18px 24px; text-align: center; color: var(--muted); font-size: 12px; }
  footer a { color: var(--text); font-weight: 600; text-decoration: none; }
  footer a:hover { color: var(--accent); }
  footer .gh { vertical-align: -2px; fill: currentColor; }
  .modal-overlay { position: fixed; inset: 0; background: rgba(1,4,9,0.6); display: none; align-items: center; justify-content: center; z-index: 100; }
  .modal-overlay.open { display: flex; }
  .modal { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 22px 24px; width: 360px; max-width: calc(100vw - 32px); box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
  .modal h3 { font-size: 15px; margin-bottom: 6px; }
  .modal p { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .btn.solid-danger { background: #b62324; border-color: #b62324; color: #fff; }
  .btn.solid-danger:hover { background: var(--err); border-color: var(--err); color: #fff; }
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

const GITHUB_ICON =
  '<svg class="gh" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

export function layout(title: string, body: string, headerExtra = ''): string {
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
<header>
  <div class="brand">
    ${brandMark(30)}
    <div class="brand-text">
      <span class="brand-name">Nest <b>Debug Panel</b></span>
      <span class="brand-sub">Request Profiler</span>
    </div>
  </div>
  <div class="spacer"></div>
  ${headerExtra}
</header>
<main>${body}</main>
<footer>
  Development profiler · Crafted by <a href="https://github.com/rakibulislam8226" target="_blank" rel="noopener noreferrer">${GITHUB_ICON} Rakibul Islam</a>
</footer>
</body>
</html>`;
}
