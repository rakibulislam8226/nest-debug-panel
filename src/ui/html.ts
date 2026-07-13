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
  header { display: flex; align-items: center; gap: 12px; padding: 14px 24px; background: var(--panel); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
  header .logo { font-weight: 700; font-size: 16px; }
  header .logo span { color: var(--accent); }
  header .sub { color: var(--muted); font-size: 12px; }
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
  footer { text-align: center; color: var(--muted); font-size: 12px; padding: 24px; }
`;

export function layout(title: string, body: string, headerExtra = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${BASE_STYLES}</style>
</head>
<body>
<header>
  <div class="logo">nest<span>-debug-panel</span></div>
  <div class="sub">request inspector</div>
  <div class="spacer"></div>
  ${headerExtra}
</header>
<main>${body}</main>
<footer>nest-debug-panel — development profiler. Do not enable in production.</footer>
</body>
</html>`;
}
