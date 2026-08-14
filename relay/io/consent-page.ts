// The OAuth callback page — the last thing a user sees in a connect flow, so
// it follows the cockpit's design system rather than looking like a debug dump:
// IBM Plex Sans, hairline borders, no shadows, one blue accent, and the same
// tokens in both colour schemes (DESIGN.md).
//
// Its own module so it can be rendered and asserted in tests; importing the
// consent script itself would execute main().

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

export interface ConsentPage {
  title: string;
  body: string;
  detail?: string;
  ok: boolean;
}

export function page(opts: ConsentPage): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>
  :root {
    --bg:#f7f7f8; --surface:#fff; --outline:#e5e7eb;
    --ink:#1a1d21; --muted:#64748b; --accent:#2563eb; --ok:#059669; --err:#dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0f1115; --surface:#171a21; --outline:#262b36;
      --ink:#e6e8ec; --muted:#9aa3b2; --accent:#3b82f6; --ok:#34d399; --err:#f87171;
    }
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    font-family:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    background:var(--bg); color:var(--ink); line-height:1.6;
    min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
    -webkit-font-smoothing:antialiased;
  }
  .card{
    background:var(--surface); border:1px solid var(--outline); border-radius:6px;
    padding:28px 30px; max-width:32rem; width:100%;
  }
  .mark{
    font-size:13px; font-weight:600; color:var(--muted);
    letter-spacing:-0.01em; margin-bottom:18px;
  }
  h1{font-size:20px; font-weight:600; letter-spacing:-0.01em; margin-bottom:6px;
     display:flex; align-items:center; gap:9px}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--st);flex:none}
  p{font-size:14px; color:var(--muted); text-wrap:pretty}
  .detail{
    margin-top:16px; padding-top:14px; border-top:1px solid var(--outline);
    font-size:12px; color:var(--muted);
  }
</style>
<body><div class="card" style="--st:${opts.ok ? "var(--ok)" : "var(--err)"}">
  <div class="mark">secretary</div>
  <h1><span class="dot"></span>${escapeHtml(opts.title)}</h1>
  <p>${escapeHtml(opts.body)}</p>
  ${opts.detail ? `<div class="detail">${escapeHtml(opts.detail)}</div>` : ""}
</div></body></html>`;
}
