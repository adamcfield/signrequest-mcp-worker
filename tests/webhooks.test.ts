import { describe, it, expect, vi, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SignRequestClient } from "../src/signrequest.js";
import { registerTools } from "../src/tools.js";

type Call = { url: string; method: string; auth: string | null; body: unknown };

function capture(body: unknown = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      calls.push({
        url,
        method: init.method ?? "GET",
        auth: h.get("authorization"),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

/** Minimal McpServer stand-in that records registered tools and their handlers. */
function fakeServer() {
  const tools = new Map<string, { annotations?: Record<string, unknown>; handler: (a: any) => Promise<any> }>();
  const server = {
    registerTool: (name: string, cfg: { annotations?: Record<string, unknown> }, handler: any) => {
      tools.set(name, { annotations: cfg.annotations, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

const BASE = "https://signrequest.com/api/v1";
afterEach(() => vi.unstubAllGlobals());

describe("webhook client methods", () => {
  const c = () => new SignRequestClient({ token: "t" });

  it("maps CRUD to the right method and path", async () => {
    const calls = capture();
    await c().listWebhooks({ page: 2, limit: 50 });
    await c().getWebhook("w1");
    await c().createWebhook({ event_type: "signed", callback_url: "https://x.test/cb" });
    await c().updateWebhook("w1", { name: "n" });
    await c().updateWebhook("w1", { event_type: "sent", callback_url: "https://x.test/cb" }, true);
    await c().deleteWebhook("w1");
    expect(calls.map((x) => `${x.method} ${x.url.replace(BASE, "")}`)).toEqual([
      "GET /webhooks/?page=2&limit=50",
      "GET /webhooks/w1/",
      "POST /webhooks/",
      "PATCH /webhooks/w1/",
      "PUT /webhooks/w1/",
      "DELETE /webhooks/w1/",
    ]);
    expect(calls[2].body).toEqual({ event_type: "signed", callback_url: "https://x.test/cb" });
  });

  it("covers teams, forward, audit and api-token endpoints", async () => {
    const calls = capture();
    await c().getTeam("volta");
    await c().updateTeam("volta", { events_callback_url: "https://x.test" });
    await c().inviteTeamMember("volta", { email: "a@b.test" });
    await c().deleteTeam("volta");
    await c().forwardSigner("sr1", { signer_email_to_forward: "a@b.test", signer_email_to_forward_to: "c@d.test" });
    await c().listAuditEvents({ status: "error", timestamp__date__gte: "2026-10-01" });
    await c().listApiTokens();
    expect(calls.map((x) => `${x.method} ${x.url.replace(BASE, "")}`)).toEqual([
      "GET /teams/volta/",
      "PATCH /teams/volta/",
      "POST /teams/volta/invite_member/",
      "DELETE /teams/volta/",
      "POST /signrequests/sr1/forward_signer/",
      "GET /audit-events/?status=error&timestamp__date__gte=2026-10-01",
      "GET /api-tokens/",
    ]);
  });
});

describe("auth scheme", () => {
  it("defaults to Token for team API tokens", async () => {
    const calls = capture();
    await new SignRequestClient({ token: "abc" }).listWebhooks();
    expect(calls[0].auth).toBe("Token abc");
  });

  it("uses Bearer with a token getter, re-read on every request", async () => {
    const calls = capture();
    let tok = "one";
    const client = new SignRequestClient({ token: () => tok, authScheme: "Bearer" });
    await client.listWebhooks();
    tok = "two";
    await client.listWebhooks();
    expect(calls.map((x) => x.auth)).toEqual(["Bearer one", "Bearer two"]);
  });
});

describe("tool registration", () => {
  const client = new SignRequestClient({ token: "t" });

  it("registers all 47 tools, and read-only mode hides every write", () => {
    const full = fakeServer();
    registerTools(full.server, client);
    expect(full.tools.size).toBe(47);
    const ro = fakeServer();
    registerTools(ro.server, client, { readOnly: true });
    for (const [name, t] of ro.tools) expect(t.annotations?.readOnlyHint, name).toBe(true);
    for (const n of ["signrequest_create_webhook", "signrequest_delete_webhook", "signrequest_delete_team"]) {
      expect(ro.tools.has(n)).toBe(false);
      expect(full.tools.get(n)?.annotations?.destructiveHint ?? false).toBe(n !== "signrequest_create_webhook");
    }
  });

  it("dry_run never calls a write endpoint", async () => {
    const calls = capture({ uuid: "w1", event_type: "signed" });
    const { server, tools } = fakeServer();
    registerTools(server, client);
    await tools.get("signrequest_create_webhook")!.handler({ event_type: "signed", callback_url: "https://x.test", dry_run: true });
    await tools.get("signrequest_update_webhook")!.handler({ uuid: "w1", name: "n", dry_run: true });
    await tools.get("signrequest_delete_webhook")!.handler({ uuid: "w1", dry_run: true });
    expect(calls.every((x) => x.method === "GET")).toBe(true);
  });

  it("delete_team refuses without a matching confirm_subdomain", async () => {
    const calls = capture();
    const { server, tools } = fakeServer();
    registerTools(server, client);
    const res = await tools.get("signrequest_delete_team")!.handler({ subdomain: "volta" });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("webhook_health flags undelivered and non-2xx deliveries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.replace(BASE, "");
        const body = path.startsWith("/webhooks/")
          ? { results: [{ uuid: "w1", event_type: "signed", callback_url: "https://x.test" }], next: null }
          : path.startsWith("/teams/")
            ? { results: [{ subdomain: "volta", events_callback_url: "https://team.test" }] }
            : {
                next: null,
                results: [
                  { uuid: "e1", event_type: "sent", delivered: true, callback_status_code: 200 },
                  { uuid: "e2", event_type: "signer_viewed_email", delivered: false, callback_status_code: 404 },
                ],
              };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const { server, tools } = fakeServer();
    registerTools(server, client);
    const res = await tools.get("signrequest_webhook_health")!.handler({});
    const out = JSON.parse(res.content[0].text);
    expect(out.deliveries_by_http_status).toEqual({ "200": 1, "404": 1 });
    expect(out.failed_deliveries.map((f: any) => f.uuid)).toEqual(["e2"]);
    expect(out.team_callbacks[0].events_callback_url).toBe("https://team.test");
  });
});

describe("list_api_tokens", () => {
  it("never returns the secret key", async () => {
    capture({ count: 1, results: [{ name: "ci", email: "a@b.test", key: "abcdef0123456789", password: "x" }] });
    const { server, tools } = fakeServer();
    registerTools(server, new SignRequestClient({ token: "t" }));
    const res = await tools.get("signrequest_list_api_tokens")!.handler({});
    const text = res.content[0].text as string;
    expect(text).not.toContain("abcdef0123456789");
    expect(text).not.toContain('"password"');
    expect(JSON.parse(text).results[0]).toMatchObject({ name: "ci", key_last4: "6789" });
  });
});

describe("webhook_health visibility", () => {
  it("warns instead of looking healthy when no events are visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ count: 0, next: null, results: [] }), { status: 200 })),
    );
    const { server, tools } = fakeServer();
    registerTools(server, new SignRequestClient({ token: "t" }));
    const out = JSON.parse((await tools.get("signrequest_webhook_health")!.handler({})).content[0].text);
    expect(out.warnings?.[0]).toMatch(/No events visible/);
  });

  it("scans the event log 100 at a time", async () => {
    const calls = capture({ count: 0, next: null, results: [] });
    const { server, tools } = fakeServer();
    registerTools(server, new SignRequestClient({ token: "t" }));
    await tools.get("signrequest_webhook_health")!.handler({});
    expect(calls.some((c) => c.url.endsWith("/events/?page=1&limit=100"))).toBe(true);
  });
});
