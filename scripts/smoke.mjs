#!/usr/bin/env node
/**
 * Smoke test for a deployed SignRequest MCP worker.
 * Reads no secrets from the repo — pass them via env:
 *
 *   MCP_URL=https://signrequest-mcp.<sub>.workers.dev/mcp \
 *   MCP_TOKEN=<bearer> \
 *   node scripts/smoke.mjs
 *
 * Checks: initialize handshake, tools/list (>= 27 tools incl. the high-level
 * helpers), and signrequest_whoami (which validates the SignRequest token
 * end-to-end). Exits non-zero if any check fails.
 */
const URL = process.env.MCP_URL;
const TOKEN = process.env.MCP_TOKEN;
if (!URL || !TOKEN) {
  console.error("Set MCP_URL and MCP_TOKEN env vars.");
  process.exit(2);
}

const BASE_HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const parse = (t) => {
  const line = (t || "").split("\n").find((x) => x.startsWith("data:"));
  try {
    return JSON.parse(line ? line.slice(5).trim() : t);
  } catch {
    return null;
  }
};

let sessionId = null;
async function rpc(body) {
  const headers = { ...BASE_HEADERS };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(URL, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  return { status: res.status, body: parse(await res.text()) };
}

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) failures++;
};

const NEW_TOOLS = [
  "signrequest_whoami",
  "signrequest_get_signer_summary",
  "signrequest_get_document_fields",
  "signrequest_get_signed_pdf",
  "signrequest_get_signing_link",
  "signrequest_get_documents",
  "signrequest_create_embedded_signing_links",
];

const init = await rpc({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
});
check("initialize", init.status === 200 && !!sessionId);
await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const tools = list.body?.result?.tools ?? [];
check("tools/list", tools.length >= 27, `(${tools.length} tools)`);
for (const t of NEW_TOOLS) check(`tool present: ${t}`, tools.some((x) => x.name === t));

const who = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "signrequest_whoami", arguments: {} } });
let whoOk = false;
try {
  whoOk = JSON.parse(who.body?.result?.content?.[0]?.text ?? "{}").ok === true;
} catch {
  /* ignore */
}
check("signrequest_whoami (token valid)", whoOk && !who.body?.result?.isError);

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
