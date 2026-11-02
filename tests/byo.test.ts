import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { byoBaseUrl, byoCredential } from "../src/byo.js";
import { SignRequestClient } from "../src/signrequest.js";

const req = (h: Record<string, string>) => new Request("https://w/mcp", { method: "POST", headers: h });

describe("byoCredential", () => {
  it("reads X-SignRequest-Token, or Authorization: Token", () => {
    expect(byoCredential(req({ "X-SignRequest-Token": "abc" }), {})).toEqual({ token: "abc" });
    expect(byoCredential(req({ Authorization: "Token abc" }), {})).toEqual({ token: "abc" });
  });

  it("never treats the MCP bearer as a SignRequest token", () => {
    expect(byoCredential(req({ Authorization: "Bearer gate" }), {})).toBeNull();
    expect(byoCredential(req({}), {})).toBeNull();
  });

  it("accepts a valid team subdomain only", () => {
    expect(byoCredential(req({ "X-SignRequest-Token": "t", "X-SignRequest-Team": "Acme-1" }), {})).toEqual({ token: "t", team: "acme-1" });
    expect(byoCredential(req({ "X-SignRequest-Token": "t", "X-SignRequest-Team": "evil.example.com/x" }), {})).toEqual({ token: "t" });
  });

  it("is off with MCP_BYO_KEYS=\"false\"", () => {
    expect(byoCredential(req({ "X-SignRequest-Token": "abc" }), { MCP_BYO_KEYS: "false" })).toBeNull();
  });

  it("builds the team API base, never a caller-chosen host", () => {
    expect(byoBaseUrl({ token: "t", team: "acme" })).toBe("https://acme.signrequest.com/api/v1");
    expect(byoBaseUrl({ token: "t" })).toBeUndefined();
  });
});

describe("SignRequestClient base URL getter", () => {
  it("resolves the base per request", async () => {
    let base: string | undefined = "https://a.signrequest.com/api/v1";
    const urls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: string) => {
      urls.push(String(u));
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const c = new SignRequestClient({ token: "t", baseUrl: () => base, maxRetries: 0 });
      await (c as any).request("GET", "/teams/");
      base = undefined;
      await (c as any).request("GET", "/teams/");
    } finally {
      globalThis.fetch = orig;
    }
    expect(urls[0]).toBe("https://a.signrequest.com/api/v1/teams/");
    expect(urls[1]).toMatch(/^https:\/\/signrequest\.com\/api\/v1\/teams\/$/);
  });
});

describe("bearer worker wiring (source checks; index.ts needs the Workers runtime)", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  it("lets a caller's own token through without MCP_AUTH_TOKEN, and gates the fallback", () => {
    expect(src).toMatch(/const own = byoCredential\(request, env\);\s*if \(!own && !authorized\(request, env\)\)/);
  });
  it("passes the credential as props and replaces session props on every request", () => {
    expect(src).toContain("const props: Props = own ?? {};");
    expect(src).toMatch(/fetch\(request, env, sctx\)/);
    expect(src).toMatch(/__unsafe_ensureInitialized\(props\?: Props\)[\s\S]*updateProps\(next\)/);
  });
  it("uses the env base URL only for the fallback token", () => {
    expect(src).toContain("baseUrl: () => (own() ? byoBaseUrl(this.props ?? {}) : this.env.SIGNREQUEST_BASE_URL)");
  });
});
