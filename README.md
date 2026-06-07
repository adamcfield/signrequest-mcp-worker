# signrequest-mcp-worker

The [SignRequest](https://signrequest.com) e-signature API exposed as a **remote [MCP](https://modelcontextprotocol.io) server**, running as a **Cloudflare Worker** (Streamable HTTP + SSE). Built on the [`agents`](https://github.com/cloudflare/agents) `McpAgent`.

It exposes **ten tools** for the document-signing workflow — create & send signature requests, track status, cancel/remind, and read documents & templates. The tool definitions live in [`src/tools.ts`](src/tools.ts) and the SignRequest REST client in [`src/signrequest.ts`](src/signrequest.ts); both are transport-agnostic, so a stdio build and this Worker build share an identical tool surface.

> **Status:** typechecks and bundles clean (`wrangler deploy --dry-run` → ~235 KiB gzip, Durable Object bound) and is deployed. Secrets are set via `wrangler secret put` and are **never** committed to this repo.

---

## Contents

- [Architecture](#architecture)
- [Endpoints](#endpoints)
- [Authentication](#authentication)
- [Tools](#tools)
- [SignRequest API coverage](#signrequest-api-coverage)
- [Configuration](#configuration)
- [Deploy](#deploy)
- [Verify](#verify)
- [Connect a client](#connect-a-client) — [Claude Code](#claude-code) · [Claude Desktop](#claude-desktop) · [Claude Web](#claude-web) · [Programmatic](#programmatic)
- [Caveats](#caveats)
- [Project layout](#project-layout)

---

## Architecture

```
client (Claude Code / Desktop / curl)
        │  HTTPS + Authorization: Bearer <MCP_AUTH_TOKEN>
        ▼
┌──────────────────────────────────────────────┐
│ Worker fetch handler (src/index.ts)            │
│  • GET /          → public health check        │
│  • bearer gate    → 401 if token missing/wrong │
│  • POST /mcp      → Streamable HTTP transport   │
│  • GET  /sse      → SSE transport (legacy)      │
└───────────────┬────────────────────────────────┘
                │ routes to the Durable Object
                ▼
┌──────────────────────────────────────────────┐
│ SignRequestMCP  (McpAgent, Durable Object)     │
│  • registerTools(server, client)  ← tools.ts   │
│  • SignRequestClient              ← signrequest.ts
└───────────────┬────────────────────────────────┘
                │ Authorization: Token <SIGNREQUEST_TOKEN>
                ▼
        SignRequest REST API v1
```

- **`McpAgent` + Durable Object.** MCP session state is held in a Cloudflare Durable Object (SQLite-backed, migration `v1`). The binding is `MCP_OBJECT` → class `SignRequestMCP`.
- **Shared tool layer.** `registerTools()` and `SignRequestClient` are plain TypeScript with no Worker-specific imports, so the exact same files can drive a local stdio server.
- **`src/ai-stub.ts`** aliases the unused optional `ai` peer dependency of `agents` out of the bundle. If you ever use `agents`' MCP-*client* features, run `npm i ai@^5` and drop the `alias` from `wrangler.jsonc`.

---

## Endpoints

| Method | Path           | Auth   | Purpose                                  |
|--------|----------------|--------|------------------------------------------|
| `GET`  | `/`            | none   | Health check → `signrequest-mcp worker: ok` |
| `POST` | `/mcp`         | Bearer | MCP Streamable HTTP (modern clients)     |
| `GET`  | `/sse`         | Bearer | MCP SSE (legacy clients)                 |
| `POST` | `/sse/message` | Bearer | SSE message channel                      |

Any other path returns `404`. Any authenticated path without a valid bearer returns `401` with a `WWW-Authenticate: Bearer` header.

---

## Authentication

The Worker is gated by a **shared bearer token** (`MCP_AUTH_TOKEN`):

- **Fails closed** — if the secret is unset, *every* authenticated request is rejected. A leaked URL alone is not an open relay to your SignRequest account.
- **Constant-time comparison** — the token check uses a length-safe, constant-time compare to avoid timing leaks.
- The SignRequest API token itself (`SIGNREQUEST_TOKEN`) never leaves the Worker; clients only ever present the `MCP_AUTH_TOKEN` bearer.

This is the right model for programmatic use, `mcp-remote` bridges, and Claude Code/Desktop. It is **not** an OAuth provider — see [Claude Web](#claude-web).

---

## Tools

All tools call an external service (`openWorldHint: true`). "Sends email" means SignRequest dispatches real signing emails.

### Create & send

#### `signrequest_quick_create`
Create a document **and** send the signature request in one call — the most common entry point. *Write · sends email.*

| Field | Type | Notes |
|-------|------|-------|
| *document source* | — | exactly one of `file_from_url`, `file_from_content` (+ `file_from_content_name`), or `template` |
| `file_from_url` | string (url) | public URL SignRequest downloads — preferred for anything but tiny files |
| `file_from_content` | string | base64 file contents — small files only (bloats context) |
| `file_from_content_name` | string | filename **with** extension, e.g. `contract.pdf`; required if `file_from_content` is set |
| `template` | string (url) | template resource URL to base the document on |
| `signers` | Signer[] | **required**, min 1 — see [Signer](#signer-object) |
| `from_email` | string (email) | sender; must belong to the token's team; falls back to `SIGNREQUEST_FROM_EMAIL` |
| `from_email_name`, `subject`, `message` | string | `message` allows limited HTML (`a,b,i,em,strong,ul,ol,li,blockquote,code,abbr,acronym`) |
| `send_reminders` | boolean | auto-remind signers who haven't signed |
| `who` | `m` \| `o` \| `mo` | `m`=only me, `o`=only others, `mo`=both |
| `external_id`, `name`, `events_callback_url` | string | your ref id · display name · per-document webhook URL |

#### `signrequest_create_document`
Create a document **without** sending it. Returns a document with a `url`/`uuid` you can pass to `signrequest_send` later. *Write · emails no one.*
Accepts the document-source fields above plus `external_id`, `name`, `events_callback_url`.

#### `signrequest_send`
Send a signature request for an **existing** document (created via `signrequest_create_document`). *Write · sends email.*
Fields: `document` (resource URL, **required**), `signers` (**required**), `from_email`, `from_email_name`, `subject`, `message`, `send_reminders`, `who`.

### Track & manage

| Tool | Purpose | Input | Class |
|------|---------|-------|-------|
| `signrequest_get` | Get one signature request — status, signers, who signed/declined/viewed | `uuid` | read-only |
| `signrequest_list` | List signature requests (most recent first) | `page?`, `external_id?` | read-only |
| `signrequest_cancel` | Cancel a request; unsigned signers lose access. Only if not already fully signed/declined | `uuid` | **destructive**, idempotent |
| `signrequest_resend` | Resend the signing email to signers who haven't signed | `uuid` | write · sends email |

### Documents & templates

| Tool | Purpose | Input | Class |
|------|---------|-------|-------|
| `signrequest_get_document` | Get a document — conversion status, signed-PDF URL, security hash, signing log | `uuid` | read-only |
| `signrequest_list_documents` | List documents (most recent first) | `page?`, `external_id?` | read-only |
| `signrequest_list_templates` | List templates; use a template's resource URL as `template` above | `page?` | read-only |

### Signer object

Used by `signrequest_quick_create` and `signrequest_send`:

| Field | Type | Notes |
|-------|------|-------|
| `email` | string (email) | **required** |
| `first_name`, `last_name` | string | |
| `order` | int | signing order; lower signs first. The sender is always order `0` |
| `language` | string | `en, en-gb, nl, fr, de, da, fi, hu, it, no, pl, pt, es, sv`. **Hebrew is not supported.** |
| `force_language` | boolean | |
| `message` | string | per-signer message |
| `redirect_url` | string (url) | redirect after signing |

---

## SignRequest API coverage

**No — this MCP does not wrap the entire SignRequest API.** It deliberately covers the ten endpoints that make up the end-to-end signing workflow. Everything below maps 1:1 to a method in [`src/signrequest.ts`](src/signrequest.ts):

| Tool | SignRequest endpoint |
|------|----------------------|
| `signrequest_quick_create` | `POST /signrequest-quick-create/` |
| `signrequest_create_document` | `POST /documents/` |
| `signrequest_send` | `POST /signrequests/` |
| `signrequest_get` | `GET /signrequests/{uuid}/` |
| `signrequest_list` | `GET /signrequests/` |
| `signrequest_cancel` | `POST /signrequests/{uuid}/cancel_signrequest/` |
| `signrequest_resend` | `POST /signrequests/{uuid}/resend_signrequest_email/` |
| `signrequest_get_document` | `GET /documents/{uuid}/` |
| `signrequest_list_documents` | `GET /documents/` |
| `signrequest_list_templates` | `GET /templates/` |

**Not currently exposed** (present in the SignRequest v1 API, intentionally omitted to keep the surface focused and safe):

- **Document deletion** — `DELETE /documents/{uuid}/`
- **Single-template fetch** — `GET /templates/{uuid}/` (you can still discover template URLs via `signrequest_list_templates`)
- **Attachments** — document attachments and signer-collected attachments
- **Webhook events** — listing/reading delivered events (`/events/`). *Note:* you can still set a per-document `events_callback_url` when creating/sending.
- **Teams & members** — create/read teams, invite/list members
- **API token management** and **e-sign disclosures**
- **Standalone signer resource** — `/signers/` (signer data is already returned inside signature-request objects)

If you need any of these, add a method to `SignRequestClient` and a tool in `registerTools()`. See the full API: <https://signrequest.com/api/v1/docs/>.

The client (`Authorization: Token <token>`) retries only idempotent `GET`s (on `429`/`5xx`, exponential backoff honoring `Retry-After`); state-changing `POST`s (create/send/cancel/resend) are **never** auto-retried, to avoid double-creating documents or re-sending signing emails.

---

## Configuration

Set via `npx wrangler secret put <NAME>` (secrets) or a `[vars]` block in `wrangler.jsonc` (non-secret).

| Name | Kind | Required | Purpose |
|------|------|----------|---------|
| `SIGNREQUEST_TOKEN` | secret | ✅ | Team-scoped SignRequest API token |
| `MCP_AUTH_TOKEN` | secret | ✅ | Shared bearer clients must send as `Authorization: Bearer <…>` |
| `SIGNREQUEST_FROM_EMAIL` | secret/var | optional | Default sender, so callers can omit `from_email` |
| `SIGNREQUEST_BASE_URL` | secret/var | optional | Override API base (default `https://signrequest.com/api/v1`) |
| `SIGNREQUEST_MAX_RETRIES` | secret/var | optional | Max retries for idempotent calls (default `3`) |

---

## Deploy

```bash
npm install

# Required secrets — paste each value at the prompt (do NOT put it on the command line):
npx wrangler secret put SIGNREQUEST_TOKEN   # your SignRequest API token
npx wrangler secret put MCP_AUTH_TOKEN      # a strong random shared secret

# Optional default sender:
# npx wrangler secret put SIGNREQUEST_FROM_EMAIL

npx wrangler deploy
```

Generate a strong `MCP_AUTH_TOKEN` without a trailing newline (a stray newline breaks the constant-time compare):

```bash
MCP_TOKEN=$(openssl rand -hex 32); printf '%s' "$MCP_TOKEN" | npx wrangler secret put MCP_AUTH_TOKEN; echo "MCP_AUTH_TOKEN=$MCP_TOKEN"
```

The first deploy creates the Durable Object (migration `v1`, `new_sqlite_classes`) and prints your `https://signrequest-mcp.<subdomain>.workers.dev` URL.

---

## Verify

```bash
URL="https://signrequest-mcp.<subdomain>.workers.dev"

# 1) Health (no auth) → "signrequest-mcp worker: ok"
curl "$URL/"

# 2) Fail-closed — no token → 401
curl -i -X POST "$URL/mcp"

# 3) MCP initialize (with token) → JSON-RPC result, not 401
curl -X POST "$URL/mcp" \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

---

## Connect a client

### Claude Code

```bash
claude mcp add --transport http --scope user signrequest \
  https://signrequest-mcp.<subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"

claude mcp list   # → signrequest: … (HTTP) - ✓ Connected
```

### Claude Desktop

Claude Desktop speaks stdio, so bridge the remote server with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote). Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`) and fully restart the app:

```jsonc
{
  "mcpServers": {
    "signrequest": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://signrequest-mcp.<subdomain>.workers.dev/mcp",
        "--header", "Authorization: Bearer <MCP_AUTH_TOKEN>"
      ]
    }
  }
}
```

> If a bare `npx` doesn't resolve inside the Desktop app (common when Node is installed via a version manager), use the absolute path from `which npx`.

### Claude Web

**Not supported as-is.** Claude.ai's custom-connector UI accepts only **OAuth 2.1** (with PKCE) for authenticated remote MCP servers — there is no field for a static bearer token, API key, or custom header. A bearer-gated Worker like this one cannot be added directly to Claude.ai web.

To support Claude Web you must put the server behind OAuth — e.g. [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) plus the `agents` OAuth flow — which is a separate build that touches your account/identity setup. Until then, use Claude Code, Claude Desktop, Cursor, or any client that lets you set a request header.

### Programmatic

Any HTTP MCP client works — send `Authorization: Bearer <MCP_AUTH_TOKEN>` and `Accept: application/json, text/event-stream` to `POST /mcp`.

---

## Caveats

- **Existing-token-only.** SignRequest is owned by Box and is in maintenance mode; this assumes you already have a working team API token (sign-ups/new provisioning may be unavailable).
- **No Hebrew** in signer email/UI language — not in SignRequest's supported set (see the [Signer object](#signer-object)).
- **Bearer, not OAuth.** See [Claude Web](#claude-web).
- **SDK pin.** `@modelcontextprotocol/sdk` is pinned to `1.23.0` to match the copy `agents` bundles (avoids a duplicate-types mismatch). Re-check this pin when upgrading `agents`.

---

## Project layout

```
src/
  index.ts        Worker entry — routing, bearer gate, McpAgent/Durable Object
  tools.ts        registerTools() — the 10 tool definitions + Zod schemas
  signrequest.ts  SignRequestClient — dependency-free REST client (fetch-only)
  ai-stub.ts      stubs the unused `ai` peer dep out of the bundle
wrangler.jsonc    Worker config — DO binding, migration v1, ai alias
package.json      pinned deps (SDK 1.23.0, agents ^0.2.0, zod, wrangler)
```
