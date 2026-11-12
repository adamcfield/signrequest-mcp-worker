/**
 * SignRequest MCP server — OAuth-gated Cloudflare Worker (for Claude.ai web).
 *
 * Same McpAgent + tools as the bearer worker (src/index.ts), but fronted by an
 * OAuth 2.1 provider (@cloudflare/workers-oauth-provider) so it can be added to
 * Claude.ai as a custom connector (Claude.ai web requires OAuth, not a bearer).
 *
 * /authorize shows a connect page (src/connect.ts) with two ways in:
 *  - "Sign in with SignRequest" (SR_CLIENT_ID + SR_CLIENT_SECRET set): hands off to
 *    SignRequest's OAuth2 login; each user acts with their own SignRequest access token,
 *    refreshed upstream whenever Claude refreshes ours.
 *  - "Use an API token": the user's own SignRequest API token (+ optional team subdomain),
 *    checked once, stored only in the encrypted grant.
 * Managed authorization (claude.ai org connection, standard §3C): /managed binds one team API
 * token to a Claude organisation; members connect with no sign-in screen. Off until
 * SIGNREQUEST_EMA_SECRET is set.
 *
 * Routes:
 *   GET  /                         health check (no auth)
 *   GET  /health                   JSON health {ok, service, version, warnings} (no auth)
 *   GET/POST /authorize            connect page: SignRequest login or API token (src/connect.ts)
 *   GET  /callback                 SignRequest OAuth2 redirect target (this file)
 *   GET/POST /managed              managed-authorization setup for a Claude org owner (src/connect.ts)
 *   /token, /register, /.well-known/oauth-*   handled by OAuthProvider
 *   POST /mcp                      MCP Streamable HTTP (OAuth-protected; SSE is bearer-worker only)
 *
 * Secrets (wrangler secret put ... -c wrangler.oauth.jsonc):
 *   SR_CLIENT_ID, SR_CLIENT_SECRET   optional SignRequest OAuth2 application ("Sign in with SignRequest")
 *   SIGNREQUEST_EMA_SECRET           optional; turns on managed authorization (never rotate it)
 * Optional: SIGNREQUEST_TEAM (team subdomain for team context), SIGNREQUEST_FROM_EMAIL,
 *   SIGNREQUEST_BASE_URL, SIGNREQUEST_MAX_RETRIES
 */

import { env as workerEnv } from "cloudflare:workers";
import OAuthProvider, { OAuthError } from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SignRequestClient } from "./signrequest.js";
import { registerTools, VERSION } from "./tools.js";
import {
  clientOptions,
  credentialInfo,
  handleAuthorize,
  handleManaged,
  healthBody,
  loginMode,
  managed,
  page,
  type ConnectEnv,
  type GrantProps,
} from "./connect.js";

// Reuses the bearer worker's global Cloudflare.Env (MCP_OBJECT, SIGNREQUEST_FROM_EMAIL,
// etc.) and adds the OAuth-specific bindings. SIGNREQUEST_TOKEN is not used here.
interface Env extends Cloudflare.Env {
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider. */
  OAUTH_PROVIDER: OAuthHelpers;
  SR_CLIENT_ID?: string;
  SR_CLIENT_SECRET?: string;
  /** Team subdomain for LOGIN tokens: API calls go to https://<team>.signrequest.com/api/v1. */
  SIGNREQUEST_TEAM?: string;
  /** Seals org credentials for managed authorization; unset = /managed is off. */
  SIGNREQUEST_EMA_SECRET?: string;
}

/** Grant props: a SignRequest login (OAuth2 tokens) or an API token (own or the organisation's). */
type Props = GrantProps;

const SR_OAUTH = "https://signrequest.com/api/v1/oauth2";
const STATE_TTL_SECONDS = 600;

type AuthRequest = Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>;

/** The MCP agent — identical tool surface to the bearer worker. */
export class SignRequestMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "signrequest", version: VERSION });

  async init(): Promise<void> {
    const client = new SignRequestClient({
      // Read per request so a token refreshed mid-session (see __unsafe_ensureInitialized) is used.
      ...clientOptions(() => this.props, this.env),
      maxRetries: this.env.SIGNREQUEST_MAX_RETRIES
        ? Number(this.env.SIGNREQUEST_MAX_RETRIES)
        : undefined,
    });
    registerTools(this.server, client, {
      defaultFromEmail: this.env.SIGNREQUEST_FROM_EMAIL,
      readOnly: this.env.MCP_READONLY === "true",
      credential: () => credentialInfo(this.props, this.env),
    });
  }

  // Props normally reach the agent only once, at start. Every request re-sends the
  // current grant's props through this hook (agents' getAgentByName), so pick up a
  // refreshed SignRequest token immediately. Internal API: re-check on agents upgrades
  // (tests/oauth.test.ts fails if it disappears).
  override async __unsafe_ensureInitialized(props?: Props): Promise<void> {
    await super.__unsafe_ensureInitialized(props);
    if (
      (props?.accessToken && props.accessToken !== this.props?.accessToken) ||
      (props?.apiToken && (props.apiToken !== this.props?.apiToken || props.team !== this.props?.team))
    ) {
      await this.updateProps(props);
    }
  }
}

function errorPage(message: string, status = 400): Response {
  return page("Couldn't connect to SignRequest", `${message} Close this tab and try connecting again from Claude.`, status);
}

type SrTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

/** Call SignRequest's token endpoint (authorization_code or refresh_token grant). */
async function srToken(env: Env, params: Record<string, string>): Promise<SrTokenResponse> {
  const res = await fetch(`${SR_OAUTH}/token/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      ...params,
      client_id: env.SR_CLIENT_ID ?? "",
      client_secret: env.SR_CLIENT_SECRET ?? "",
    }),
  });
  const text = await res.text();
  if (res.status === 400 || res.status === 401) {
    throw new OAuthError("invalid_grant", { description: `SignRequest token endpoint: ${text.slice(0, 200)}` });
  }
  if (!res.ok) {
    throw new OAuthError("temporarily_unavailable", {
      description: `SignRequest token endpoint returned ${res.status}`,
      statusCode: 503,
    });
  }
  const json = JSON.parse(text) as SrTokenResponse;
  if (!json.access_token) throw new OAuthError("server_error", { description: "SignRequest returned no access_token" });
  return json;
}

function propsFromToken(t: SrTokenResponse, previous?: Props): Props {
  return {
    user: previous?.user ?? "signrequest",
    accessToken: t.access_token,
    // Some servers don't rotate refresh tokens; keep the old one if none is returned.
    refreshToken: t.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + (t.expires_in ?? 36000) * 1000,
  };
}

/** Our access token must expire before SignRequest's, so Claude's refresh drives the upstream refresh. */
const ttlFor = (t: SrTokenResponse): number => Math.max(60, (t.expires_in ?? 36000) - 300);

/** Login mode: stash Claude's auth request under a random state and hand off to SignRequest. */
async function redirectToSignRequest(request: Request, env: ConnectEnv, reqInfo: AuthRequest): Promise<Response> {
  const state = crypto.randomUUID();
  await env.OAUTH_KV.put(`sr_state:${state}`, JSON.stringify(reqInfo), { expirationTtl: STATE_TTL_SECONDS });
  const url = new URL(`${SR_OAUTH}/authorize/`);
  url.searchParams.set("client_id", env.SR_CLIENT_ID ?? "");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "read write");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `${new URL(request.url).origin}/callback`);
  return Response.redirect(url.toString(), 302);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  if (!loginMode(env)) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const stored = state ? await env.OAUTH_KV.get(`sr_state:${state}`) : null;
  if (!stored) return errorPage("The sign-in request expired or was already used.");
  await env.OAUTH_KV.delete(`sr_state:${state}`);
  const reqInfo = JSON.parse(stored) as AuthRequest;

  const upstreamError = url.searchParams.get("error");
  if (upstreamError) {
    return errorPage(
      upstreamError === "access_denied" ? "Access was not granted in SignRequest." : `SignRequest returned: ${upstreamError}`,
    );
  }
  const code = url.searchParams.get("code");
  if (!code) return errorPage("SignRequest did not return an authorization code.");

  let token: SrTokenResponse;
  try {
    token = await srToken(env, {
      grant_type: "authorization_code",
      code,
      redirect_uri: `${url.origin}/callback`,
    });
  } catch (e) {
    return errorPage(e instanceof Error ? e.message : "Token exchange failed.", 502);
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: reqInfo,
    // No ":" allowed — the provider uses it as a separator inside tokens.
    userId: `signrequest-${crypto.randomUUID()}`,
    metadata: { label: "SignRequest login" },
    scope: reqInfo.scope ?? [],
    props: propsFromToken(token),
  });
  return Response.redirect(redirectTo, 302);
}

/** Non-API, non-token routes: the connect page, the SignRequest callback, /managed and a public health check. */
const defaultHandler = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/authorize") return handleAuthorize(request, env, redirectToSignRequest);
    if (path === "/managed") return handleManaged(request, env);
    if (path === "/callback" && request.method === "GET") return handleCallback(request, env);
    if (path === "/health" && request.method === "GET") return Response.json(healthBody(env, VERSION));
    if (path === "/" && request.method === "GET") {
      const mode = loginMode(env) ? "SignRequest login or API token" : "API token";
      return new Response(`signrequest-mcp-oauth worker: ok (v${VERSION}, sign-in: ${mode}, OAuth-gated MCP at /mcp)`, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
};

/**
 * Canonical resource — every token's audience. Must stay exactly the URL existing
 * grants were issued for (claude.ai connects to /mcp), or every session signs out.
 * Forks: change it to your own worker URL.
 */
const MCP_RESOURCE = "https://signrequest-mcp-oauth.adamcfield.workers.dev/mcp";

/**
 * The resource this deployment serves. A parallel copy on another hostname (the Volta account
 * copy, deploy/volta.jsonc) sets the `MCP_RESOURCE` var to its own /mcp URL; unset, it is the
 * canonical URL above, so the existing deployment and its grants are unchanged.
 */
function resourceFor(env: { MCP_RESOURCE?: string }): string {
  const v = env.MCP_RESOURCE?.trim();
  return v ? v : MCP_RESOURCE;
}

export default new OAuthProvider({
  // Streamable HTTP only: every API route must sit under the resource path, and
  // claude.ai uses /mcp. Legacy SSE stays on the bearer worker.
  apiHandlers: {
    "/mcp": SignRequestMCP.serve("/mcp"),
  },
  resourceMetadata: { resource: resourceFor(workerEnv as unknown as { MCP_RESOURCE?: string }) },
  defaultHandler: defaultHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  // §3C: Claude registers by Client ID Metadata Document (needs global_fetch_strictly_public).
  clientIdMetadataDocumentEnabled: true,
  enterpriseManagedAuthorization: managed.emaOptions(workerEnv),
  // Login mode: match our token lifetime to SignRequest's, and refresh SignRequest's
  // token each time Claude refreshes ours.
  tokenExchangeCallback: async ({ grantType, props }) => {
    const p = props as Props;
    if (!p?.refreshToken) return;
    if (grantType === "authorization_code") {
      const remaining = Math.floor(((p.expiresAt ?? 0) - Date.now()) / 1000);
      return { accessTokenTTL: Math.max(60, remaining - 300) };
    }
    if (grantType === "refresh_token") {
      const t = await srToken(workerEnv as unknown as Env, { grant_type: "refresh_token", refresh_token: p.refreshToken });
      const next = propsFromToken(t, p);
      return { newProps: next, accessTokenProps: next, accessTokenTTL: ttlFor(t) };
    }
  },
});
