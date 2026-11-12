import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { SignRequestClient } from "../src/signrequest.js";
import { registerTools, VERSION } from "../src/tools.js";
import {
  clientOptions,
  credentialInfo,
  handleAuthorize,
  handleManaged,
  healthBody,
  managed,
  parseCred,
  type GrantProps,
} from "../src/connect.js";

/**
 * src/oauth.ts imports cloudflare:workers and can't load under Node. This builds the same
 * provider from the same pieces (src/connect.ts), with a /mcp handler that runs
 * signrequest_whoami through the real client settings, so the whole connect flow is covered.
 */

function memKV() {
  const m = new Map<string, string>();
  return {
    async get(k: string, t?: any) {
      const v = m.get(k);
      if (v === undefined) return null;
      return t === "json" || t?.type === "json" ? JSON.parse(v) : v;
    },
    async put(k: string, v: string) {
      m.set(k, v);
    },
    async delete(k: string) {
      m.delete(k);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: "" };
    },
    _map: m,
  } as unknown as KVNamespace & { _map: Map<string, string> };
}

function fakeServer() {
  const tools = new Map<string, (a: any) => Promise<any>>();
  const server = { registerTool: (name: string, _cfg: unknown, handler: any) => void tools.set(name, handler) } as unknown as McpServer;
  return { server, tools };
}

type Env = Record<string, any>;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

function worker(env: Env) {
  const provider = new OAuthProvider({
    apiHandlers: {
      "/mcp": {
        fetch: async (_req: Request, e: Env, c: ExecutionContext & { props?: GrantProps }) => {
          const { server, tools } = fakeServer();
          const client = new SignRequestClient({ ...clientOptions(() => c.props, e), maxRetries: 0 });
          registerTools(server, client, { credential: () => credentialInfo(c.props, e) });
          const r = await tools.get("signrequest_whoami")!({});
          return Response.json(JSON.parse(r.content[0].text));
        },
      } as never,
    },
    defaultHandler: {
      fetch: async (req: Request, e: Env) => {
        const p = new URL(req.url).pathname;
        if (p === "/authorize") return handleAuthorize(req, e as never, async () => Response.redirect("https://signrequest.com/api/v1/oauth2/authorize/?x=1", 302));
        if (p === "/managed") return handleManaged(req, e as never);
        if (p === "/health") return Response.json(healthBody(e as never, VERSION));
        return new Response("Not found", { status: 404 });
      },
    } as never,
    resourceMetadata: { resource: "https://w/mcp" },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    enterpriseManagedAuthorization: managed.emaOptions(env),
  });
  return (req: Request) => provider.fetch(req, env as never, ctx);
}

afterEach(() => vi.restoreAllMocks());
beforeAll(() => void ((globalThis as any).Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } }));
afterAll(() => void delete (globalThis as any).Cloudflare);

const ISS = "https://identity.anthropic.com/issuers/iss_test123";
const JWKS = `${ISS}/jwks`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE = "https://w/mcp";
const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const j64 = (o: unknown) => b64u(enc.encode(JSON.stringify(o)));

/** Fake SignRequest (GET /teams/ accepts the listed tokens, per host) + fake Claude issuer (ES256). */
async function fakes(tokens: Record<string, string>) {
  const realFetch = globalThis.fetch;
  const seen: { url: string; auth: string }[] = [];
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://w/")) return realFetch(input, init);
    if (url === `${ISS}/.well-known/openid-configuration`) return Response.json({ issuer: ISS, jwks_uri: JWKS });
    if (url === JWKS) return Response.json({ keys: [jwk] });
    const auth = new Headers(init?.headers ?? (input as Request).headers).get("authorization") ?? "";
    seen.push({ url, auth });
    const host = new URL(url).host;
    const ok = Object.entries(tokens).some(([t, h]) => auth === `Token ${t}` && host === h);
    if (/\/api\/v1\/(teams|team-members)\//.test(url)) {
      return ok ? Response.json({ count: 1, results: [{ name: "Example team" }] }) : new Response('{"detail":"Invalid token."}', { status: 401 });
    }
    return new Response("{}", { status: 404 });
  });
  const sign = async (claims: Record<string, unknown>) => {
    const now = Math.floor(Date.now() / 1000);
    const body = `${j64({ alg: "ES256", typ: "oauth-id-jag+jwt", kid: "k1" })}.${j64({ iss: ISS, sub: "u_1", aud: "https://w", resource: RESOURCE, jti: crypto.randomUUID(), iat: now, exp: now + 60, ...claims })}`;
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, enc.encode(body)));
    return `${body}.${b64u(sig)}`;
  };
  return { sign, seen };
}

async function register(w: ReturnType<typeof worker>): Promise<string> {
  const res = await w(
    new Request("https://w/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "Claude" }),
    }),
  );
  return ((await res.json()) as any).client_id;
}

const post = (w: ReturnType<typeof worker>, path: string, fields: Record<string, string>) =>
  w(new Request(`https://w${path}`, { method: "POST", body: new URLSearchParams(fields) }));
const whoami = async (w: ReturnType<typeof worker>, token: string) =>
  (await (await w(new Request(RESOURCE, { method: "POST", headers: { authorization: `Bearer ${token}` } }))).json()) as any;

async function pkce() {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
  return { verifier, challenge };
}

describe("parseCred", () => {
  it("normalises the team and rejects junk", () => {
    expect(parseCred(" tok ", "https://Acme.signrequest.com/")).toEqual({ ok: true, cred: { token: "tok", team: "acme" } });
    expect(parseCred("tok", "")).toEqual({ ok: true, cred: { token: "tok" } });
    expect(parseCred("", "acme").ok).toBe(false);
    expect(parseCred("tok", "bad team!").ok).toBe(false);
  });
});

describe("connect page (paste your own API token)", () => {
  it("validates the token, keeps the team on error, and the grant acts with it", async () => {
    const env: Env = { OAUTH_KV: memKV() };
    const w = worker(env);
    const f = await fakes({ "user-token-1234567": "acme.signrequest.com" });
    const clientId = await register(w);
    const { verifier, challenge } = await pkce();
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE });

    const get = await w(new Request(`https://w/authorize?${q}`));
    expect(get.status).toBe(200);
    expect(get.headers.get("content-security-policy")).toContain("form-action 'self' https://claude.ai");
    const html = await get.text();
    expect(html).not.toContain("Sign in with SignRequest"); // no SR_CLIENT_* here
    expect(html).toContain("data:image/png;base64,");
    const state = /name="state" value="([^"]+)"/.exec(html)![1];

    // Wrong team: rejected, team kept, token never echoed.
    const bad = await post(w, "/authorize", { state, action: "token", token: "user-token-1234567", team: "other" });
    expect(bad.status).toBe(400);
    const badHtml = await bad.text();
    expect(badHtml).toContain("SignRequest rejected that token for other.signrequest.com");
    expect(badHtml).toContain('value="other"');
    expect(badHtml).not.toContain("user-token-1234567");

    // Tampered state: refused.
    expect((await post(w, "/authorize", { state: "nope", action: "token", token: "x" })).status).toBe(400);

    const ok = await post(w, "/authorize", { state, action: "token", token: "user-token-1234567", team: "acme" });
    expect(ok.status).toBe(302);
    const code = new URL(ok.headers.get("location")!).searchParams.get("code")!;
    const tok: any = await (await post(w, "/token", { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: RESOURCE })).json();
    expect(tok.access_token).toBeTruthy();
    for (const v of (env.OAUTH_KV as any)._map.values()) expect(v).not.toContain("user-token-1234567");

    f.seen.length = 0;
    const who = await whoami(w, tok.access_token);
    expect(who).toMatchObject({ ok: true, credential_source: "api_token", token: "user…4567", team_subdomain: "acme" });
    expect(f.seen.length).toBeGreaterThan(0);
    expect(f.seen.every((s) => s.auth === "Token user-token-1234567" && s.url.startsWith("https://acme.signrequest.com/api/v1/"))).toBe(true);
  });

  it("offers SignRequest login when the OAuth app is configured and hands off on click", async () => {
    const env: Env = { OAUTH_KV: memKV(), SR_CLIENT_ID: "cid", SR_CLIENT_SECRET: "cs", SIGNREQUEST_TEAM: "acme" };
    const w = worker(env);
    const clientId = await register(w);
    const { challenge } = await pkce();
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE });
    const html = await (await w(new Request(`https://w/authorize?${q}`))).text();
    expect(html).toContain("Sign in with SignRequest");
    const state = /name="state" value="([^"]+)"/.exec(html)![1];
    const res = await post(w, "/authorize", { state, action: "login" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/signrequest\.com\/api\/v1\/oauth2\/authorize\//);
  });

  it("health is ok without the login app (API tokens always work)", async () => {
    const h: any = await (await worker({ OAUTH_KV: memKV() })(new Request("https://w/health"))).json();
    expect(h).toMatchObject({ ok: true, service: "signrequest-mcp-oauth", signIn: { signrequestLogin: false, apiToken: true, managed: false } });
    expect(h.warnings.join(" ")).toContain("SIGNREQUEST_EMA_SECRET");
  });
});

describe("claude.ai managed authorization", () => {
  it("is off without SIGNREQUEST_EMA_SECRET", async () => {
    const w = worker({ OAUTH_KV: memKV() });
    expect((await w(new Request("https://w/managed"))).status).toBe(503);
    const meta: any = await (await w(new Request("https://w/.well-known/oauth-authorization-server"))).json();
    expect(meta.grant_types_supported).not.toContain("urn:ietf:params:oauth:grant-type:jwt-bearer");
  });

  it("owner binds a team token once; members get tokens that run with it", async () => {
    const kv = memKV();
    const env: Env = { OAUTH_KV: kv, SIGNREQUEST_EMA_SECRET: "seal-secret", SIGNREQUEST_TEAM: "loginteam" };
    const w = worker(env);
    const f = await fakes({ "org-token-abc123": "acme.signrequest.com", "other-token-9999": "acme.signrequest.com" });

    const meta: any = await (await w(new Request("https://w/.well-known/oauth-authorization-server"))).json();
    expect(meta.grant_types_supported).toContain("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(meta.client_id_metadata_document_supported).toBe(true);
    const h: any = await (await w(new Request("https://w/health"))).json();
    expect(h.signIn.managed).toBe(true);
    expect(h.warnings.join(" ")).not.toContain("SIGNREQUEST_EMA_SECRET");

    const page = await w(new Request("https://w/managed"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    const first = await page.text();
    expect(first).not.toContain("Remove setup");
    expect(first).toContain("data:image/png;base64,");

    const clientId = await register(w);
    const tokenFor = (assertion: string) =>
      post(w, "/token", { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion, client_id: clientId, resource: RESOURCE });
    expect((await tokenFor(await f.sign({ client_id: clientId, email: "a@example.com" }))).status).toBe(400);

    // Errors keep what was typed (never the token).
    const badIss = await (await post(w, "/managed", { action: "save", issuer: "https://evil.example.com/issuers/x", token: "org-token-abc123", team: "acme", domains: "example.com" })).text();
    expect(badIss).toContain("not a Claude Issuer URL");
    expect(badIss).toContain('value="example.com"');
    expect(badIss).toContain('value="acme"');
    expect(badIss).not.toContain("org-token-abc123");
    expect(await (await post(w, "/managed", { action: "save", issuer: ISS, token: "wrong", team: "acme" })).text()).toContain("SignRequest rejected that token");

    const done = await post(w, "/managed", { action: "save", issuer: ISS, token: "org-token-abc123", team: "acme", domains: "example.com" });
    expect(done.status).toBe(200);
    const html = await done.text();
    const tenant = /value="(tn_[\w-]+)"/.exec(html)![1];
    expect(html).toContain('data-copy="tenant-id"');
    expect(html).not.toContain("Remove setup");
    for (const v of kv._map.values()) expect(v).not.toContain("org-token-abc123");

    const res = await tokenFor(await f.sign({ client_id: clientId, email: "Member@Example.com", aud_tenant: tenant }));
    expect(res.status).toBe(200);
    const tok: any = await res.json();
    expect(tok.refresh_token).toBeUndefined();
    expect(tok.expires_in).toBe(3600);
    f.seen.length = 0;
    const who = await whoami(w, tok.access_token);
    expect(who).toMatchObject({ ok: true, credential_source: "managed", token: "org-…c123", team_subdomain: "acme" });
    expect(f.seen.every((s) => s.auth === "Token org-token-abc123" && s.url.startsWith("https://acme.signrequest.com/"))).toBe(true);

    expect((await tokenFor(await f.sign({ client_id: clientId, email: "x@other.example", aud_tenant: tenant }))).status).toBe(400);

    const rmWrong = await post(w, "/managed?manage=1", { action: "remove", tenant, token: "other-token-9999", team: "acme" });
    expect(await rmWrong.text()).toContain("different credential");
    const rm = await post(w, "/managed?manage=1", { action: "remove", tenant, token: "org-token-abc123", team: "acme" });
    expect(await rm.text()).toContain("Setup removed");
    expect((await tokenFor(await f.sign({ client_id: clientId, email: "a@example.com", aud_tenant: tenant }))).status).toBe(400);
  });
});

describe("oauth.ts wiring", () => {
  it("serves /authorize and /managed from src/connect.ts and turns managed auth on in the provider", () => {
    const src = readFileSync(new URL("../src/oauth.ts", import.meta.url), "utf8");
    expect(src).toMatch(/handleAuthorize\(request, env, redirectToSignRequest\)/);
    expect(src).toMatch(/path === "\/managed"\) return handleManaged/);
    expect(src).toMatch(/clientIdMetadataDocumentEnabled: true/);
    expect(src).toMatch(/enterpriseManagedAuthorization: managed\.emaOptions\(workerEnv\)/);
    expect(src).toMatch(/\.\.\.clientOptions\(\(\) => this\.props, this\.env\)/);
    const wr = readFileSync(new URL("../wrangler.oauth.jsonc", import.meta.url), "utf8");
    expect(wr).toContain("global_fetch_strictly_public");
  });
});
