import { describe, it, expect, vi } from "vitest";

// agents/mcp pulls in cloudflare:workers, which doesn't load under Node. The bearer gate and
// health route run before any agent code, so a stub is enough.
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve = () => ({ fetch: async () => new Response("mcp", { status: 200 }) });
    static serveSSE = () => ({ fetch: async () => new Response("sse", { status: 200 }) });
  },
}));

const { default: worker } = await import("../src/index.js");
const { VERSION } = await import("../src/tools.js");
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const call = (path: string, env: Record<string, unknown>, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://w.example.com${path}`, { method: path === "/mcp" ? "POST" : "GET", headers }), env as never, ctx);

describe("bearer worker", () => {
  const env = { MCP_AUTH_TOKEN: "secret-token", SIGNREQUEST_TOKEN: "sr" };

  it("rejects a missing or wrong bearer with 401 + WWW-Authenticate", async () => {
    for (const h of [{}, { authorization: "Bearer nope" }, { authorization: "secret-token" }]) {
      const res = await call("/mcp", env, h);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  it("fails closed when MCP_AUTH_TOKEN is unset", async () => {
    expect((await call("/mcp", { SIGNREQUEST_TOKEN: "sr" }, { authorization: "Bearer " })).status).toBe(401);
  });

  it("passes the right bearer through to /mcp", async () => {
    expect((await call("/mcp", env, { authorization: "Bearer secret-token" })).status).toBe(200);
  });

  it("serves /health without auth and never echoes secrets", async () => {
    const ok = await (await call("/health", env)).json();
    expect(ok).toEqual({ ok: true, service: "signrequest-mcp", version: VERSION, warnings: [] });
    const bad = await call("/health", {});
    const text = await bad.text();
    expect(JSON.parse(text).ok).toBe(false);
    expect(JSON.parse(text).warnings).toHaveLength(2);
    expect(text).not.toContain("secret-token");
  });
});
