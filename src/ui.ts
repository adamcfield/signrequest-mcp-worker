/**
 * Shared look for every HTML page this worker serves (connector sign-in, /managed, member links).
 * Self-contained: no external fonts, images or scripts. Fleet pattern: copy this file as is
 * and change BRAND only.
 */
// `logo` (optional): the service's own icon as a data: URI (CSP img-src data:); replaces the text badge and the tab icon.
export const BRAND: { name: string; accent: string; mark: string; logo?: string } = {
  name: 'SignRequest',
  accent: '#1e88e5',
  mark: 'S',
  logo: 'data:image/png;base64,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',
};

const CSS = `
:root{color-scheme:light dark;--bg:#f5f6f8;--card:#fff;--fg:#1d2330;--muted:#5f6878;--line:#dfe3ea;--accent:${BRAND.accent};--ok:#1e7e34;--err:#c62828;--field:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#14161b;--card:#1d2027;--fg:#e8eaee;--muted:#9aa2b1;--line:#30343d;--field:#16181d}}
*{box-sizing:border-box}
a{color:var(--accent)}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:34rem;margin:2.5rem auto;padding:0 16px}
.brand{display:flex;align-items:center;gap:.7rem;margin:0 0 1.2rem}
.mark.logo{background:none}.mark img{width:40px;height:40px;border-radius:10px;display:block}
.mark{width:40px;height:40px;border-radius:10px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700;letter-spacing:.02em}
.brand b{font-size:1.05rem}.brand span{display:block;color:var(--muted);font-size:.85rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.4rem 1.4rem .6rem;box-shadow:0 1px 3px #0000000d}
h1{font-size:1.35rem;margin:0 0 .6rem}
p{margin:.4rem 0 1rem}
fieldset{border:0;border-top:1px solid var(--line);padding:1rem 0 .2rem;margin:0}
fieldset:first-of-type{border-top:0;padding-top:0}
legend{font-weight:600;padding:0;margin-bottom:.5rem}
label{display:block;font-size:.9rem;font-weight:500;margin:0 0 .85rem}
input,select{display:block;width:100%;margin-top:.3rem;padding:.6rem .7rem;font:inherit;color:inherit;background:var(--field);border:1px solid var(--line);border-radius:8px}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
button{font:inherit;font-weight:600;padding:.65rem 1rem;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer;width:100%;margin:.2rem 0 .8rem}
button:hover{filter:brightness(1.07)}
a.btn{display:block;text-align:center;text-decoration:none;font-weight:600;padding:.75rem 1rem;border-radius:8px;background:var(--accent);color:#fff;margin:.4rem 0 1rem}a.btn:hover{filter:brightness(1.07)}a.btn.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}
ol.steps{padding-left:1.2rem;margin:.4rem 0 1rem}ol.steps li{margin:.3rem 0}
.big{font-size:2.4rem;line-height:1;margin:.2rem 0 .6rem}
button.secondary{background:transparent;color:var(--muted);border:1px solid var(--line)}
.row{display:flex;gap:.5rem}.row button{width:auto;flex:none}
.err,.ok{border-radius:8px;padding:.7rem .9rem;margin:0 0 1rem;font-size:.92rem}
.err{background:#c628281a;color:var(--err)}.ok{background:#1e7e341a}
.muted{color:var(--muted);font-size:.85rem}
code{font:.85em ui-monospace,SFMono-Regular,Menlo,monospace;background:#8882;padding:.1em .35em;border-radius:4px;word-break:break-all}
.copy{display:flex;gap:.5rem;align-items:stretch;margin:.3rem 0 1rem}
.copy input{margin:0;font:1rem ui-monospace,SFMono-Regular,Menlo,monospace}
.copy button{width:auto;margin:0;display:flex;align-items:center;gap:.35rem;white-space:nowrap}
footer{color:var(--muted);font-size:.8rem;text-align:center;margin:1.2rem 0}
`;

// Wires every [data-copy] button to copy the value of the element it names.
const COPY_JS = `document.querySelectorAll('[data-close]').forEach(function(b){b.addEventListener('click',function(){window.close();b.textContent='You can close this tab now'})});document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var t=document.getElementById(b.getAttribute('data-copy'));if(!t)return;var v=t.value||t.textContent;var done=function(){var o=b.innerHTML;b.textContent='Copied';setTimeout(function(){b.innerHTML=o},1500)};if(navigator.clipboard){navigator.clipboard.writeText(v).then(done,function(){t.select&&t.select();document.execCommand('copy');done()})}else{t.select&&t.select();document.execCommand('copy');done()}})})`;

const COPY_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

/** Tab icon (§12A): the brand mark on the accent colour, inline as an SVG data URI (no request, CSP img-src data:). */
export function faviconDataUri(): string {
  if (BRAND.logo) return BRAND.logo;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${BRAND.accent}"/><text x="32" y="42" font-family="system-ui,Segoe UI,Arial,sans-serif" font-size="${BRAND.mark.length > 1 ? 26 : 34}" font-weight="700" fill="#fff" text-anchor="middle">${BRAND.mark.replace(/[&<>"']/g, '')}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A read-only value with a copy button. `id` must be unique on the page. */
export function copyField(id: string, value: string, label = 'Copy'): string {
  return `<div class="copy"><input id="${esc(id)}" value="${esc(value)}" readonly aria-label="${esc(label)}"><button type="button" data-copy="${esc(id)}">${COPY_ICON}<span>${esc(label)}</span></button></div>`;
}

/** A full page: brand header, one card, the shared style; CSP allows only this page's own inline script. */
export function renderPage(body: string, opts: { status?: number; title?: string; subtitle?: string; formAction: string }): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const script = /data-(copy|close)=/.test(body) ? `<script nonce="${nonce}">${COPY_JS}</script>` : '';
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title ?? `Connect ${BRAND.name}`)}</title><link rel="icon" href="${faviconDataUri()}"><style>${CSS}</style></head><body><main>
<div class="brand">${BRAND.logo ? `<div class="mark logo"><img src="${esc(BRAND.logo)}" alt="${esc(BRAND.name)}"></div>` : `<div class="mark">${esc(BRAND.mark)}</div>`}<div><b>${esc(BRAND.name)} for Claude</b><span>${esc(opts.subtitle ?? 'MCP connector')}</span></div></div>
<div class="card">${body}</div>
<footer>Your credentials are encrypted and only used to call ${esc(BRAND.name)} for you.</footer>
</main>${script}</body></html>`,
    {
      status: opts.status ?? 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; form-action ${opts.formAction}; frame-ancestors 'none'; base-uri 'none'`,
        'Referrer-Policy': 'no-referrer',
      },
    },
  );
}
