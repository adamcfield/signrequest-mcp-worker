# signrequest-mcp-worker

The SignRequest MCP server as a **remote Cloudflare Worker** (Streamable-HTTP + SSE), built on `agents`' `McpAgent`. Same ten tools as the stdio version — it imports the identical `tools.ts` and `signrequest.ts`, so the tool surface can't drift between the two.

Status: **typechecks and bundles clean** (`wrangler deploy --dry-run` → 235 KiB gzip, Durable Object bound). It has **not** been deployed — that's your step (it needs auth to your Cloudflare account). The stdio version was verified end-to-end against the live API; this one's live confirmation is your first `wrangler deploy`.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | none | Health check |
| POST | `/mcp` | Bearer | MCP Streamable HTTP (modern) |
| GET | `/sse` | Bearer | MCP SSE (legacy clients) |

## Auth model — the one decision that's yours

This Worker is gated by a **shared bearer token** (`MCP_AUTH_TOKEN`). It fails closed: no secret set → everything 401s. This is the right model if you'll call it programmatically or bridge it into Claude Desktop via `mcp-remote`.

**It is NOT a one-click Claude.ai custom connector.** Claude.ai's connector flow expects the MCP server to speak **OAuth**; a static bearer won't slot into that UI. So:

- **Programmatic / `mcp-remote` / scripts** → bearer (this) is perfect, ship as-is.
- **Native Claude.ai connector** → needs OAuth. That's a bigger build (`@cloudflare/workers-oauth-provider` + the `agents` OAuth flow) and it touches your account/identity setup. Tell me which way you want and I'll wire it; I defaulted to bearer because it's the universally-safe option that doesn't depend on your IdP.

## Deploy (your steps)

```bash
cd signrequest-mcp-worker
npm install

# Secrets — use your ROTATED SignRequest token, and a strong random MCP_AUTH_TOKEN
npx wrangler secret put SIGNREQUEST_TOKEN
npx wrangler secret put MCP_AUTH_TOKEN

# Optional: default sender (or add a [vars] block to wrangler.jsonc)
# npx wrangler secret put SIGNREQUEST_FROM_EMAIL

npx wrangler deploy
```

First deploy creates the Durable Object (migration `v1`, `new_sqlite_classes`). Then sanity-check:

```bash
# Health (no auth):
curl https://signrequest-mcp.<your-subdomain>.workers.dev/

# 401 without the token:
curl -i -X POST https://signrequest-mcp.<your-subdomain>.workers.dev/mcp

# MCP initialize (with token):
curl -X POST https://signrequest-mcp.<your-subdomain>.workers.dev/mcp \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

## Using it from Claude Desktop (bearer version)

Bridge the remote server in via `mcp-remote`:

```json
{
  "mcpServers": {
    "signrequest": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://signrequest-mcp.<your-subdomain>.workers.dev/mcp",
        "--header", "Authorization: Bearer <MCP_AUTH_TOKEN>"
      ]
    }
  }
}
```

## Notes
- `src/ai-stub.ts` aliases the unused optional `ai` peer of `agents` out of the bundle (see the file). If you ever use agents' MCP-client features, `npm i ai@^5` and drop the `alias` from `wrangler.jsonc`.
- SDK pinned to `1.23.0` to match the copy `agents` bundles (avoids a duplicate-types mismatch). The stdio project is independent and uses a newer SDK.
- All the SignRequest caveats from the stdio README still apply: existing-token-only (Box owns SignRequest now), and no Hebrew in the signer email/UI chrome.
