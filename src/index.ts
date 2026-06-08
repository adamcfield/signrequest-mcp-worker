/**
 * SignRequest MCP server — Cloudflare Worker (remote, Streamable-HTTP + SSE).
 *
 * Reuses the exact same tool definitions as the stdio server (./tools).
 * The SignRequest token lives as a Worker secret; access is gated by a bearer
 * token (MCP_AUTH_TOKEN) so a leaked URL isn't an open relay to your account.
 *
 * Endpoints:
 *   GET  /            -> public health check (no auth)
 *   POST /mcp         -> MCP Streamable HTTP   (bearer required)
 *   GET  /sse         -> MCP SSE (legacy)      (bearer required)
 *
 * Secrets (wrangler secret put ...):
 *   SIGNREQUEST_TOKEN  team-scoped SignRequest API token
 *   MCP_AUTH_TOKEN     shared secret clients must send as `Authorization: Bearer <...>`
 * Optional vars:
 *   SIGNREQUEST_FROM_EMAIL, SIGNREQUEST_BASE_URL, SIGNREQUEST_MAX_RETRIES
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SignRequestClient } from "./signrequest.js";
import { registerTools } from "./tools.js";

declare global {
  namespace Cloudflare {
    interface Env {
      MCP_OBJECT: DurableObjectNamespace;
      SIGNREQUEST_TOKEN: string;
      MCP_AUTH_TOKEN: string;
      SIGNREQUEST_FROM_EMAIL?: string;
      SIGNREQUEST_BASE_URL?: string;
      SIGNREQUEST_MAX_RETRIES?: string;
    }
  }
}
type Env = Cloudflare.Env;

export class SignRequestMCP extends McpAgent<Env> {
  server = new McpServer({ name: "signrequest", version: "1.2.0" });

  async init(): Promise<void> {
    const client = new SignRequestClient({
      token: this.env.SIGNREQUEST_TOKEN,
      baseUrl: this.env.SIGNREQUEST_BASE_URL,
      maxRetries: this.env.SIGNREQUEST_MAX_RETRIES
        ? Number(this.env.SIGNREQUEST_MAX_RETRIES)
        : undefined,
    });
    registerTools(this.server, client, {
      defaultFromEmail: this.env.SIGNREQUEST_FROM_EMAIL,
    });
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
      return new Response("signrequest-mcp worker: ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

    if (!authorized(request, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    }

    if (url.pathname === "/mcp") {
      return SignRequestMCP.serve("/mcp").fetch(request, env, ctx);
    }
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return SignRequestMCP.serveSSE("/sse").fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
