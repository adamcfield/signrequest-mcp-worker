import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SignRequestClient } from "../src/signrequest.js";
import { registerTools, READ_VERBS, RENAMES, VERSION } from "../src/tools.js";
import { readFileSync } from "node:fs";

afterEach(() => vi.unstubAllGlobals());

async function connect(opts: { readOnly?: boolean } = {}) {
  const server = new McpServer({ name: "signrequest", version: VERSION });
  registerTools(server, new SignRequestClient({ token: "t" }), opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("tool-name contract (standard §4.3)", () => {
  it("readOnlyHint is true exactly when the verb is a read verb, and all four hints are set", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.length).toBe(47);
    for (const t of tools) {
      expect(t.name, t.name).toMatch(/^signrequest_[a-z]+(_[a-z0-9]+)*$/);
      expect(t.name.length, t.name).toBeLessThanOrEqual(64);
      const verb = t.name.split("_")[1];
      const a = t.annotations ?? {};
      for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof a[k], `${t.name}.${k}`).toBe("boolean");
      }
      expect(a.readOnlyHint, `${t.name}: verb "${verb}"`).toBe(READ_VERBS.has(verb));
    }
  });

  it("read-only mode lists only read-verb tools", async () => {
    const { tools } = await (await connect({ readOnly: true })).listTools();
    for (const t of tools) expect(READ_VERBS.has(t.name.split("_")[1]), t.name).toBe(true);
  });
});

describe("renamed tools", () => {
  it("old names are hidden from tools/list but still callable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ count: 0, next: null, results: [] }), { status: 200 })),
    );
    const client = await connect();
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const [oldName, newName] of Object.entries(RENAMES)) {
      expect(names.has(oldName), oldName).toBe(false);
      expect(names.has(newName), newName).toBe(true);
    }
    const res = (await client.callTool({ name: "signrequest_webhook_health", arguments: {} })) as any;
    expect(res.isError ?? false).toBe(false);
    expect(JSON.parse(res.content[0].text).events_scanned).toBe(0);
  });

  it("an unknown name still errors", async () => {
    const res = (await (await connect()).callTool({ name: "signrequest_nope", arguments: {} })) as any;
    expect(res.isError).toBe(true);
  });
});

describe("version mirror (standard §9.1)", () => {
  it("VERSION == package.json == top CHANGELOG entry", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    expect(pkg.version).toBe(VERSION);
    expect(changelog.match(/^## (\S+)/m)?.[1]).toBe(VERSION);
  });
});
