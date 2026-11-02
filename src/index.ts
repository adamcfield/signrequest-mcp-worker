/**
 * SignRequest MCP server — Cloudflare Worker (remote, Streamable-HTTP + SSE).
 *
 * Shares its tool definitions (./tools) with the OAuth worker (./oauth).
 * Bring-your-own-key (shared MCP worker standard §3A): a caller may send their
 * OWN SignRequest API token (`X-SignRequest-Token: <token>` or
 * `Authorization: Token <token>`, optional `X-SignRequest-Team: <subdomain>`) and
 * acts with it — no MCP_AUTH_TOKEN needed, since SignRequest authenticates them.
 * Without one, the worker falls back to its own team token (SIGNREQUEST_TOKEN),
 * gated by a bearer token (MCP_AUTH_TOKEN) so a leaked URL isn't an open relay.
 * MCP_BYO_KEYS="false" turns caller tokens off.
 *
 * Endpoints:
 *   GET  /            -> public health check (no auth)
 *   POST /mcp         -> MCP Streamable HTTP   (bearer required)
 *   GET  /sse         -> MCP SSE (legacy)      (bearer required)
 *
 * Secrets (wrangler secret put ...):
 *   SIGNREQUEST_TOKEN  optional fallback team-scoped SignRequest API token
 *   MCP_AUTH_TOKEN     shared secret clients must send as `Authorization: Bearer <...>`
 * Optional vars:
 *   SIGNREQUEST_FROM_EMAIL, SIGNREQUEST_BASE_URL, SIGNREQUEST_MAX_RETRIES
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SignRequestClient } from "./signrequest.js";
import { registerTools, VERSION } from "./tools.js";
import { byoBaseUrl, byoCredential, type Props } from "./byo.js";

declare global {
  namespace Cloudflare {
    interface Env {
      MCP_OBJECT: DurableObjectNamespace;
      SIGNREQUEST_TOKEN?: string;
      MCP_AUTH_TOKEN?: string;
      /** "false" (exact) => ignore caller-supplied SignRequest tokens (bearer + fallback only). */
      MCP_BYO_KEYS?: string;
      SIGNREQUEST_FROM_EMAIL?: string;
      SIGNREQUEST_BASE_URL?: string;
      SIGNREQUEST_MAX_RETRIES?: string;
      /** "true" => register read-only tools only (no create/send/cancel/delete). */
      MCP_READONLY?: string;
    }
  }
}
type Env = Cloudflare.Env;

export class SignRequestMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "signrequest", version: VERSION });

  async init(): Promise<void> {
    // Read per request: a session's props follow the credential presented on each request
    // (see __unsafe_ensureInitialized), so a session id never lends one caller's token to another.
    const own = () => this.props?.token;
    const client = new SignRequestClient({
      token: () => {
        const t = own() ?? this.env.SIGNREQUEST_TOKEN;
        if (!t) throw new Error("No SignRequest token. Send your own via the X-SignRequest-Token header (or Authorization: Token <token>).");
        return t;
      },
      baseUrl: () => (own() ? byoBaseUrl(this.props ?? {}) : this.env.SIGNREQUEST_BASE_URL),
      maxRetries: this.env.SIGNREQUEST_MAX_RETRIES
        ? Number(this.env.SIGNREQUEST_MAX_RETRIES)
        : undefined,
    });
    registerTools(this.server, client, {
      defaultFromEmail: this.env.SIGNREQUEST_FROM_EMAIL,
      readOnly: this.env.MCP_READONLY === "true",
    });
  }

  // Every request re-sends its props (agents' getAgentByName). Replace the session's props
  // whenever the presented credential differs — including back to {} for the fallback — so
  // the token in use is always the one on THIS request. Internal API: re-check on agents
  // upgrades (tests/oauth.test.ts guards the hook).
  override async __unsafe_ensureInitialized(props?: Props): Promise<void> {
    await super.__unsafe_ensureInitialized(props);
    const next = props ?? {};
    if (next.token !== this.props?.token || next.team !== this.props?.team) {
      await this.updateProps(next);
    }
  }
}

/** Length-safe constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function authorized(request: Request, env: Env): boolean {
  // Fail closed: if no secret is configured, reject everything.
  if (!env.MCP_AUTH_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return safeEqual(header.slice(prefix.length), env.MCP_AUTH_TOKEN);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Public, unauthenticated health check.
    if (request.method === "GET" && url.pathname === "/") {
      const modes = [env.MCP_BYO_KEYS === "false" ? null : "header", env.SIGNREQUEST_TOKEN ? "fallback" : null].filter(Boolean).join(",");
      return new Response(`signrequest-mcp worker: ok (v${VERSION}, credentials: ${modes || "none"})`, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

    // The caller's own token authenticates them with SignRequest; otherwise the bearer gate
    // protects the worker's own token.
    const own = byoCredential(request, env);
    if (!own && !authorized(request, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    }
    if (!own && !env.SIGNREQUEST_TOKEN) {
      return new Response("This worker has no team token. Send your own SignRequest API token in X-SignRequest-Token.", { status: 401 });
    }
    const props: Props = own ?? {};
    const sctx = {
      waitUntil: ctx.waitUntil.bind(ctx),
      passThroughOnException: ctx.passThroughOnException.bind(ctx),
      props,
    } as unknown as ExecutionContext;

    if (url.pathname === "/mcp") {
      return SignRequestMCP.serve("/mcp").fetch(request, env, sctx);
    }
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return SignRequestMCP.serveSSE("/sse").fetch(request, env, sctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
