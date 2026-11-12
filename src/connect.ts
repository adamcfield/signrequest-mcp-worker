/**
 * claude.ai connector pages for the OAuth worker (src/oauth.ts), kept free of
 * `cloudflare:workers` so they can be unit-tested under Node.
 *
 * Three ways to connect, all ending in an OAuth grant whose props carry the credential:
 *  - "Sign in with SignRequest" (SignRequest's own OAuth2 login; only when SR_CLIENT_ID and
 *    SR_CLIENT_SECRET are set). The hand-off itself lives in src/oauth.ts.
 *  - "Use an API token": the user pastes their own SignRequest API token (+ optional team
 *    subdomain). Checked with SignRequest once (the call signrequest_whoami makes), then stored
 *    only inside the encrypted grant.
 *  - Managed authorization (standard §3C): a Claude Team/Enterprise owner binds one team API
 *    token on /managed and gets a Tenant ID for Claude; members connect with no sign-in screen.
 *    Shared module src/managed-auth.ts (fleet copy, never edit it here); off until
 *    SIGNREQUEST_EMA_SECRET is set.
 */
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createManagedAuth, normalizeIssuer, parseDomains } from "./managed-auth.js";
import { SignRequestClient, SignRequestError } from "./signrequest.js";
import { TEAM_RE, byoBaseUrl } from "./byo.js";
import { copyField, esc, renderPage } from "./ui.js";

/** Grant props. Never logged. */
export type GrantProps = {
  user: string;
  /** SignRequest login (OAuth2) access token, sent as `Bearer`. */
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms when accessToken expires. */
  expiresAt?: number;
  /** A SignRequest API token (pasted, or the organisation's under managed authorization), sent as `Token`. */
  apiToken?: string;
  /** Team subdomain for apiToken calls (`acme` → https://acme.signrequest.com/api/v1). */
  team?: string;
  /** Set on grants issued through managed authorization. */
  m?: true;
};

/** A SignRequest credential: an API token and, optionally, its team subdomain. */
export type SrCred = { token: string; team?: string };

export const managed = createManagedAuth<SrCred>({
  kvPrefix: "signrequest:",
  sealSecretName: "SIGNREQUEST_EMA_SECRET",
  toProps: (c) => ({ user: "managed", apiToken: c.token, ...(c.team ? { team: c.team } : {}), m: true }) satisfies GrantProps,
  credentialId: (c) => `${c.token}|${c.team ?? ""}`,
});

export interface ConnectEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  SR_CLIENT_ID?: string;
  SR_CLIENT_SECRET?: string;
  SIGNREQUEST_TEAM?: string;
  SIGNREQUEST_BASE_URL?: string;
  SIGNREQUEST_EMA_SECRET?: string;
}

export const loginMode = (env: { SR_CLIENT_ID?: string; SR_CLIENT_SECRET?: string }): boolean =>
  !!(env.SR_CLIENT_ID && env.SR_CLIENT_SECRET);

/** Which credential a grant carries, for signrequest_whoami and logs. */
export function credentialSource(p: GrantProps | undefined): "managed" | "api_token" | "signrequest_login" | "none" {
  if (p?.apiToken) return p.m ? "managed" : "api_token";
  return p?.accessToken ? "signrequest_login" : "none";
}

/** first4…last4, never the whole token. */
export function maskToken(t: string | undefined): string | null {
  if (!t) return null;
  return t.length > 12 ? `${t.slice(0, 4)}…${t.slice(-4)}` : "••••";
}

/**
 * §3.9: form-action covers every hop of a POST's redirect chain: the 302 back to claude.ai after
 * an API token, and the hand-off to SignRequest's login.
 */
export const FORM_ACTION = [
  "'self'",
  "https://claude.ai",
  "https://claude.com",
  "https://signrequest.com",
  "http://localhost:*",
  "http://127.0.0.1:*",
].join(" ");

/** An error/notice page in the fleet look. */
export function page(title: string, message: string, status = 200, formAction = FORM_ACTION): Response {
  return renderPage(`<h1>${esc(title)}</h1><p class="err">${esc(message)}</p>`, { status, title, formAction });
}

const TOKEN_HELP = `In SignRequest: <b>Team settings</b> → <b>API</b> → <b>Create token</b> (team admins). The team subdomain is the first part of your team's address, e.g. <code>acme</code> in <code>acme.signrequest.com</code>; leave it empty if you use signrequest.com.`;

/** Token + team inputs. The token is never echoed back: after an error the user pastes it again (§12A). */
function credFields(team = "", rekey = false): string {
  return `<label>SignRequest API token${rekey ? ` <span class="muted">(paste it again: for safety it is never sent back to the page)</span>` : ""}<input name="token" type="password" autocomplete="off" spellcheck="false" required${rekey ? " autofocus" : ""}></label>
<label>Team subdomain (optional)<input name="team" placeholder="acme" autocomplete="off" spellcheck="false" value="${esc(team)}"></label>`;
}

/** A pasted token + team, shape-checked (no upstream call). */
export function parseCred(rawToken: string, rawTeam: string): { ok: true; cred: SrCred } | { ok: false; error: string; team: string } {
  const token = rawToken.trim();
  let team = rawTeam.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\.signrequest\.com.*$/, "");
  if (!token || token.length > 200 || /\s/.test(token)) {
    return { ok: false, error: "Paste a SignRequest API token (Team settings → API in SignRequest).", team };
  }
  if (team && !TEAM_RE.test(team)) {
    return { ok: false, error: "Team subdomain: letters, digits and dashes only, e.g. acme for acme.signrequest.com.", team };
  }
  return { ok: true, cred: { token, ...(team ? { team } : {}) } };
}

/** API base for a SignRequest LOGIN token: the configured team host (login tokens span every team). */
export function loginBaseUrl(env: { SIGNREQUEST_TEAM?: string; SIGNREQUEST_BASE_URL?: string }): string | undefined {
  if (env.SIGNREQUEST_BASE_URL) return env.SIGNREQUEST_BASE_URL;
  return env.SIGNREQUEST_TEAM ? `https://${env.SIGNREQUEST_TEAM}.signrequest.com/api/v1` : undefined;
}

/**
 * SignRequestClient settings for a grant, read per request (props can change mid-session).
 * API tokens (own or the organisation's) use "Token" on their team's host; a SignRequest login
 * uses "Bearer" on the configured team host.
 */
export function clientOptions(props: () => GrantProps | undefined, env: { SIGNREQUEST_TEAM?: string; SIGNREQUEST_BASE_URL?: string }) {
  return {
    token: () => {
      const p = props();
      const t = p?.apiToken ?? p?.accessToken;
      // Grants without a credential (pre-1.5.2 passphrase grants) can't act.
      if (!t) throw new Error("This connection has no SignRequest credential. Disconnect and reconnect the connector.");
      return t;
    },
    authScheme: (): "Token" | "Bearer" => (props()?.apiToken ? "Token" : "Bearer"),
    baseUrl: () => {
      const p = props();
      return p?.apiToken ? byoBaseUrl({ team: p.team }) : loginBaseUrl(env);
    },
  };
}

/** For signrequest_whoami: which credential, masked. */
export function credentialInfo(p: GrantProps | undefined, env: { SIGNREQUEST_TEAM?: string }) {
  return {
    source: credentialSource(p),
    token: maskToken(p?.apiToken ?? p?.accessToken),
    team: p?.apiToken ? (p.team ?? null) : (env.SIGNREQUEST_TEAM ?? null),
  };
}

export type CheckResult = "ok" | "rejected" | "unreachable";

/**
 * One cheap read proving the token works: GET /teams/, the call signrequest_whoami makes, on the
 * same host the tools will use. Hook object so tests can replace it.
 */
export const validateCred = {
  run: async (cred: SrCred): Promise<CheckResult> => {
    const client = new SignRequestClient({ token: cred.token, baseUrl: byoBaseUrl(cred), maxRetries: 0 });
    try {
      await client.listTeams({ limit: 1 });
      return "ok";
    } catch (e) {
      if (e instanceof SignRequestError && (e.status === 401 || e.status === 403 || e.status === 404)) return "rejected";
      return "unreachable";
    }
  },
};

export function checkMessage(r: Exclude<CheckResult, "ok">, cred: SrCred): string {
  if (r === "unreachable") return "Couldn't reach SignRequest to check the token. Try again in a minute.";
  return cred.team
    ? `SignRequest rejected that token for ${cred.team}.signrequest.com. Check that you copied the whole token and that the team subdomain is right (or leave it empty).`
    : "SignRequest rejected that token. Check that you copied the whole token, or add your team subdomain.";
}

/**
 * The OAuth request is round-tripped through the form as an opaque `state` blob. It is
 * re-validated server-side on POST (client + registered redirect URI) and again by the provider
 * on completion, so a tampered blob can't redirect anywhere the client didn't register.
 */
export const encodeState = (r: AuthRequest) => btoa(encodeURIComponent(JSON.stringify(r)));
export const decodeState = (s: string): AuthRequest | null => {
  try {
    return JSON.parse(decodeURIComponent(atob(s))) as AuthRequest;
  } catch {
    return null;
  }
};

export function connectPage(
  state: string,
  opts: { clientName?: string; login: boolean; error?: string; team?: string },
): Response {
  const name = opts.clientName || "Claude";
  const login = opts.login
    ? `<form method="post"><input type="hidden" name="state" value="${esc(state)}"><input type="hidden" name="action" value="login">
<button type="submit">Sign in with SignRequest</button></form>
<p class="muted">Or connect with an API token:</p>`
    : "";
  return renderPage(
    `<h1>Connect SignRequest</h1>
<p><b>${esc(name)}</b> is asking to use SignRequest on your behalf.</p>
${opts.error ? `<p class="err" role="alert">${esc(opts.error)}</p>` : ""}${login}<form method="post"><input type="hidden" name="state" value="${esc(state)}"><input type="hidden" name="action" value="token">
${credFields(opts.team ?? "", !!opts.error)}
<button type="submit"${opts.login ? ' class="secondary"' : ""}>Connect with API token</button></form>
<p class="muted">${TOKEN_HELP}</p>
<p class="muted">The token is checked with SignRequest once, then stored only inside your encrypted connector grant. Remove the connector in Claude, or delete the token in SignRequest, to end access.</p>`,
    { status: opts.error ? 400 : 200, title: "Connect SignRequest", subtitle: "Connect your account", formAction: FORM_ACTION },
  );
}

async function sha256hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * /authorize. GET shows the connect page; POST either hands off to SignRequest's login
 * (`loginRedirect`, src/oauth.ts) or validates a pasted API token and completes the grant.
 */
export async function handleAuthorize(
  request: Request,
  env: ConnectEnv,
  loginRedirect: (request: Request, env: ConnectEnv, reqInfo: AuthRequest) => Promise<Response>,
): Promise<Response> {
  const login = loginMode(env);
  if (request.method === "GET") {
    let reqInfo: AuthRequest;
    try {
      reqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch {
      return page("Connection failed", "Invalid OAuth request. Start again from Claude.", 400);
    }
    if (!reqInfo.clientId) return page("Connection failed", "Invalid OAuth request. Start again from Claude.", 400);
    const client = await env.OAUTH_PROVIDER.lookupClient(reqInfo.clientId);
    return connectPage(encodeState(reqInfo), { clientName: client?.clientName, login });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const fd = await request.formData();
  const state = String(fd.get("state") ?? "");
  const reqInfo = decodeState(state);
  // Re-check the client/redirect pair server-side; the form field is client-controlled.
  const client = reqInfo?.clientId ? await env.OAUTH_PROVIDER.lookupClient(reqInfo.clientId) : null;
  if (!reqInfo || !client || !client.redirectUris.includes(reqInfo.redirectUri)) {
    return page("Connection failed", "Invalid OAuth request. Start again from Claude.", 400);
  }
  const clientName = client.clientName;

  if (String(fd.get("action") ?? "") === "login") {
    if (!login) return connectPage(state, { clientName, login, error: "Sign in with SignRequest isn't set up on this server. Use an API token." });
    return loginRedirect(request, env, reqInfo);
  }

  const parsed = parseCred(String(fd.get("token") ?? ""), String(fd.get("team") ?? ""));
  if (!parsed.ok) return connectPage(state, { clientName, login, error: parsed.error, team: parsed.team });
  const check = await validateCred.run(parsed.cred);
  if (check !== "ok") return connectPage(state, { clientName, login, error: checkMessage(check, parsed.cred), team: parsed.cred.team });

  // userId: a hash of the token (no ':' allowed), so nothing reversible is stored as an id.
  const userId = `srtoken-${(await sha256hex(`signrequest-connector:${parsed.cred.token}`)).slice(0, 32)}`;
  const props: GrantProps = { user: userId, apiToken: parsed.cred.token, ...(parsed.cred.team ? { team: parsed.cred.team } : {}) };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: reqInfo,
    userId,
    metadata: { label: "SignRequest API token", ...(parsed.cred.team ? { team: parsed.cred.team } : {}) },
    scope: reqInfo.scope ?? [],
    props,
  });
  return Response.redirect(redirectTo, 302);
}

/** /managed posts back to itself only; nothing on it redirects. */
const MANAGED_FORM_ACTION = "'self'";

interface ManagedView {
  error?: string;
  done?: { tenantId: string; issuer: string; domains: string[] };
  removed?: boolean;
  /** 'manage' = change or remove an existing setup (shows Tenant ID + remove); default = new setup only. */
  mode?: "new" | "manage";
  /** What the user typed, re-filled after an error (§12A). Never the token. */
  values?: { issuer?: string; domains?: string; tenant?: string; team?: string };
}

/** Same layout as the fleet template's /managed (§12A). */
export function managedPage(v: ManagedView = {}, status = 200): Response {
  const { error, done, removed } = v;
  const manage = v.mode === "manage";
  const val = (k: "issuer" | "domains" | "tenant") => (v.values?.[k] ? ` value="${esc(v.values[k]!)}"` : "");
  const team = v.values?.team ?? "";
  const save = `<form method="post" action="/managed${manage ? "?manage=1" : ""}"><input type="hidden" name="action" value="save">
<fieldset><legend>1. From Claude</legend>
<label>Issuer URL (Claude: Organization settings → Connectors → SignRequest → Managed authorization)<input name="issuer" placeholder="https://identity.anthropic.com/issuers/…" required autocomplete="off"${val("issuer")}></label>
${manage ? `<label>Tenant ID of the setup to change<input name="tenant" placeholder="tn_…" required autocomplete="off"${val("tenant")}></label>` : ""}</fieldset>
<fieldset><legend>2. Who</legend>
<label>Allowed email domains (optional, e.g. example.com; empty = every member)<input name="domains" placeholder="example.com" autocomplete="off"${val("domains")}></label></fieldset>
<fieldset><legend>3. The SignRequest API token the whole organisation will use</legend>
${credFields(team, !!error)}<p class="muted">${TOKEN_HELP} Members act with this team token: documents they send come from the team.</p></fieldset>
<button type="submit">${manage ? "Save changes" : "Save"}</button></form>`;
  const remove = `<form method="post" action="/managed?manage=1"><fieldset><legend>Remove this setup</legend><input type="hidden" name="action" value="remove">
<label>Tenant ID<input name="tenant" required autocomplete="off"${val("tenant")}></label>
${credFields(team)}
<button type="submit" class="secondary">Remove setup</button></fieldset></form>`;
  const intro = `<h1>SignRequest: managed authorization</h1>
<p>For a Claude Team or Enterprise owner: connect SignRequest once for the whole organisation. Members then use it in Claude without a connector sign-in, with the organisation's SignRequest API token.</p>`;
  const err = error ? `<p class="err" role="alert">${esc(error)}</p>` : "";
  let body: string;
  if (done) {
    body = `${intro}<div class="ok"><b>Saved.</b> Paste this into Claude's <b>Tenant ID</b> field, then click <b>Test connection</b>:
${copyField("tenant-id", done.tenantId, "Copy")}
<p class="muted">Keep it: you need it, with the same API token, to change or remove the setup. Issuer ${esc(done.issuer)}. ${done.domains.length ? `Only ${esc(done.domains.join(", "))} addresses can sign in.` : "Every member of that Claude organisation can sign in."}</p></div>
<p class="muted">To change or remove this setup later, open <a href="/managed?manage=1">Change or remove a setup</a> with this Tenant ID and the same token.</p>`;
  } else if (removed) {
    body = `${intro}<div class="ok"><b>Setup removed.</b> Members lose access when their current token expires (at most an hour).</div><p class="muted"><a href="/managed">Set up again</a></p>`;
  } else if (manage) {
    body = `${intro}${err}<p class="muted">Changing an existing setup. <a href="/managed">New setup instead</a></p>${save}${remove}`;
  } else {
    body = `${intro}${err}${save}<p class="muted">Already set up? <a href="/managed?manage=1">Change or remove it</a></p>`;
  }
  return renderPage(body, { status, title: "SignRequest: managed authorization", subtitle: "Managed authorization", formAction: MANAGED_FORM_ACTION });
}

/** §3C.7 setup page. The SignRequest token is the gate: it is validated before anything is bound. */
export async function handleManaged(request: Request, env: ConnectEnv): Promise<Response> {
  if (!managed.enabled(env)) {
    return page("Managed authorization", "Managed authorization is not enabled on this server.", 503, MANAGED_FORM_ACTION);
  }
  const mode: "new" | "manage" = new URL(request.url).searchParams.has("manage") ? "manage" : "new";
  if (request.method === "GET") return managedPage({ mode });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const fd = await request.formData();
  const field = (n: string, max: number) => String(fd.get(n) ?? "").trim().slice(0, max);
  const action = field("action", 10) === "remove" ? "remove" : "save";
  const tenant = field("tenant", 80);
  const values = { issuer: field("issuer", 300), domains: field("domains", 500), tenant, team: field("team", 100) };
  const fail = (error: string) => managedPage({ error, mode: action === "remove" || tenant ? "manage" : mode, values }, 400);
  const parsed = parseCred(String(fd.get("token") ?? ""), values.team);
  values.team = parsed.ok ? (parsed.cred.team ?? "") : parsed.team;
  if (!parsed.ok) return fail(parsed.error);

  if (action === "remove") {
    const r = await managed.removeBinding(env, tenant, parsed.cred);
    return r.ok ? managedPage({ removed: true }) : fail(r.error);
  }

  const issuer = normalizeIssuer(values.issuer);
  if (!issuer) return fail(`That is not a Claude Issuer URL. Copy it from Claude's "Managed authorization" dialog; it looks like https://identity.anthropic.com/issuers/…`);
  const domains = parseDomains(values.domains);
  if (!domains) return fail("Allowed email domains: plain domains only, e.g. example.com.");
  const check = await validateCred.run(parsed.cred);
  if (check !== "ok") return fail(checkMessage(check, parsed.cred));
  const r = await managed.saveBinding(env, { issuer, credential: parsed.cred, domains, tenantId: tenant || undefined });
  if (!r.ok) return fail(r.error);
  return managedPage({ done: r.binding });
}

/** GET /health body. `ok` is about serving: an API token always works, so missing login secrets only warn. */
export function healthBody(env: ConnectEnv, version: string) {
  const warnings: string[] = [];
  const login = loginMode(env);
  if (login && !env.SIGNREQUEST_TEAM && !env.SIGNREQUEST_BASE_URL) {
    warnings.push("SIGNREQUEST_TEAM is not set: login tokens see no events and get 403 on the audit log.");
  }
  warnings.push(...managed.healthWarnings(env));
  return {
    ok: true,
    service: "signrequest-mcp-oauth",
    version,
    signIn: { signrequestLogin: login, apiToken: true, managed: managed.enabled(env) },
    warnings,
  };
}
