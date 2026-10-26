import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// src/oauth.ts imports cloudflare:workers, so it can't load under Node. These checks
// guard the two library contracts it depends on.
const require = createRequire(import.meta.url);

describe("oauth worker library contracts", () => {
  it("agents still re-sends props through __unsafe_ensureInitialized on every request", () => {
    const routing = readFileSync(require.resolve("agents").replace(/index\.js$/, "agent-routing.js"), "utf8");
    expect(routing).toMatch(/__unsafe_ensureInitialized\(options\?\.props\)/);
  });

  it("the canonical resource is the /mcp URL existing grants are bound to", () => {
    const src = readFileSync(new URL("../src/oauth.ts", import.meta.url), "utf8");
    expect(src).toContain('MCP_RESOURCE = "https://signrequest-mcp-oauth.adamcfield.workers.dev/mcp"');
    expect(src).not.toMatch(/userId: `signrequest:/);
  });
});
