# signrequest-mcp-worker

The [SignRequest](https://signrequest.com) e-signature API exposed as a **remote [MCP](https://modelcontextprotocol.io) server**, running as a **Cloudflare Worker** (Streamable HTTP + SSE). Built on the [`agents`](https://github.com/cloudflare/agents) `McpAgent`.

It exposes **twenty-seven tools** for the document-signing workflow — create & send signature requests, track, cancel/remind, delete, attach files, read documents, templates, events & teams, plus high-level helpers (one-shot signer summaries, flat field extraction, batch reads) and a safe no-email signing-link generator. The tool definitions live in [`src/tools.ts`](src/tools.ts) and the SignRequest REST client in [`src/signrequest.ts`](src/signrequest.ts); both are transport-agnostic, so every build shares an identical tool surface.

This repo ships **two deployments from the same code**:

| Worker | Auth | Use it from | Entry |
|--------|------|-------------|-------|
| **`signrequest-mcp`** | static bearer token | Claude Code, Claude Desktop, programmatic | [`src/index.ts`](src/index.ts) · [`wrangler.jsonc`](wrangler.jsonc) |
| **`signrequest-mcp-oauth`** | OAuth 2.1 (single-user passphrase) | **Claude.ai web** custom connector | [`src/oauth.ts`](src/oauth.ts) · [`wrangler.oauth.jsonc`](wrangler.oauth.jsonc) |

> **Status:** both deployments typecheck, bundle, and deploy clean. Secrets are set via `wrangler secret put` and are **never** committed to this repo.

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
- [OAuth worker (Claude.ai web)](#oauth-worker-claudeai-web)
- [Caveats](#caveats)
- [Project layout](#project-layout)

---

## Architecture

```
client                         bearer worker (src/index.ts)
Claude Code / Desktop / curl ── Authorization: Bearer <MCP_AUTH_TOKEN> ──┐
                                                                          │
Claude.ai web ── OAuth 2.1 (passphrase) ── oauth worker (src/oauth.ts) ──┤
                                                                          ▼
                                              SignRequestMCP (McpAgent, Durable Object)
                                                • registerTools(server, client)  ← tools.ts
                                                • SignRequestClient               ← signrequest.ts
                                                                          │
                                                Authorization: Token <SIGNREQUEST_TOKEN>
                                                                          ▼
                                                          SignRequest REST API v1
```

- **`McpAgent` + Durable Object.** MCP session state lives in a Cloudflare Durable Object (SQLite-backed, migration `v1`). Both workers bind it as `MCP_OBJECT` → class `SignRequestMCP`.
- **Shared tool layer.** `registerTools()` and `SignRequestClient` are plain TypeScript with no Worker-specific imports, so the bearer worker, the OAuth worker, and a local stdio build all share them.
- **`src/ai-stub.ts`** aliases the unused optional `ai` peer dependency of `agents` out of the bundle.

---

## Endpoints

Bearer worker (`signrequest-mcp`):

| Method | Path           | Auth   | Purpose                                  |
|--------|----------------|--------|------------------------------------------|
| `GET`  | `/`            | none   | Health check → `signrequest-mcp worker: ok` |
| `POST` | `/mcp`         | Bearer | MCP Streamable HTTP (modern clients)     |
| `GET`  | `/sse`         | Bearer | MCP SSE (legacy clients)                 |

OAuth worker (`signrequest-mcp-oauth`) — see [OAuth worker](#oauth-worker-claudeai-web).

---

## Authentication

**Bearer worker** is gated by a **shared bearer token** (`MCP_AUTH_TOKEN`): fails closed (no secret → everything 401s), constant-time comparison, and the SignRequest token never leaves the Worker. Right for programmatic use, `mcp-remote`, Claude Code/Desktop.

**OAuth worker** implements **OAuth 2.1** (PKCE + dynamic client registration) via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider), gated by a single shared **passphrase** (`APP_PASSPHRASE`) on the consent screen — the only model Claude.ai web accepts.

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
| `file_from_content` | string | base64 file contents — small files only |
| `file_from_content_name` | string | filename **with** extension, e.g. `contract.pdf`; required if `file_from_content` is set |
| `template` | string (url) | template resource URL to base the document on |
| `signers` | Signer[] | **required**, min 1 — see [Signer](#signer-object) |
| `from_email` | string (email) | sender; must belong to the token's team; falls back to `SIGNREQUEST_FROM_EMAIL` |
| `from_email_name`, `subject`, `message` | string | `message` allows limited HTML (`a,b,i,em,strong,ul,ol,li,blockquote,code,abbr,acronym`) |
| `send_reminders` | boolean | auto-remind signers who haven't signed |
| `who` | `m` \| `o` \| `mo` | `m`=only me, `o`=only others, `mo`=both |
| `external_id`, `name`, `events_callback_url` | string | your ref id · display name · per-document webhook URL |
| `disable_emails` | boolean | suppress SignRequest status emails (with embedded signers = fully silent) |
| `dry_run` | boolean | preview who *would* be emailed; creates/sends nothing |

#### `signrequest_create_document`
Create a document **without** sending it. Returns a document with a `url`/`uuid` you can pass to `signrequest_send` later. *Write · emails no one.* Accepts the document-source fields above plus `external_id`, `name`, `events_callback_url`.

#### `signrequest_send`
Send a signature request for an **existing** document. *Write · sends email.* Fields: `document` (resource URL, **required**), `signers` (**required**), `from_email`, `from_email_name`, `subject`, `message`, `send_reminders`, `who`.

### Track & manage

| Tool | Purpose | Input | Class |
|------|---------|-------|-------|
| `signrequest_get` | Get one signature request — status, signers, who signed/declined/viewed | `uuid` | read-only |
| `signrequest_list` | List signature requests (most recent first) | `page?`, `external_id?` | read-only |
| `signrequest_cancel` | Cancel a request; unsigned signers lose access. Only if not already fully signed/declined | `uuid` | **destructive**, idempotent |
| `signrequest_resend` | Resend the signing email to signers who haven't signed (`dry_run?` previews) | `uuid`, `dry_run?` | write · sends email |

### Documents & templates

| Tool | Purpose | Input | Class |
|------|---------|-------|-------|
| `signrequest_get_document` | Get a document — conversion status, signed-PDF URL, security hash, signing log (`compact?` = trimmed summary) | `uuid`, `compact?` | read-only |
| `signrequest_list_documents` | List documents (most recent first) | `page?`, `external_id?` | read-only |
| `signrequest_delete_document` | **Permanently delete** a document + its signature requests + stored file | `uuid` | **destructive** |
| `signrequest_list_templates` | List templates; use a template's resource URL as `template` above | `page?` | read-only |
| `signrequest_get_template` | Get one template by UUID — its fields and resource URL | `uuid` | read-only |
| `signrequest_search_documents` | Fast search — filter by `signer_emails`, `q`, `name`, `status` (no blind paging) | filters | read-only |

### Events & teams

| Tool | Purpose | Input | Class |
|------|---------|-------|-------|
| `signrequest_list_events` | List the webhook delivery log (signed/declined/viewed…), for auditing | `page?` | read-only |
| `signrequest_get_event` | Get one event by UUID | `uuid` | read-only |
| `signrequest_list_teams` | List teams the token can access | `page?` | read-only |
| `signrequest_list_team_members` | List members of accessible team(s) | `page?` | read-only |

### Attachments

| Tool | Purpose | Input | Class |
|------|---------|-------|-------|
| `signrequest_add_document_attachment` | Attach an extra file to a document (`file_from_url` or base64) — not a signature field | `document` + file source | write |
| `signrequest_list_document_attachments` | List document attachments | `page?` | read-only |
| `signrequest_get_document_attachment` | Get one attachment by UUID | `uuid` | read-only |

> Attachments *collected from signers* aren't a separate tool — they come back inline on the signer object via `signrequest_get` (alongside the signer's filled `inputs`).

### High-level helpers & safety

These compose the raw endpoints into a single call each — they encode the "find the *signed* document, read its filled fields" logic so callers never have to walk `signrequest.signers[].inputs[]` or guess which of a person's documents is the real one.

| Tool | Purpose | Input | Class |
|------|---------|-------|-------|
| `signrequest_whoami` | Token health check — confirms the API token works; returns teams & members | — | read-only |
| `signrequest_get_signer_summary` | **One-shot status for a person**: finds their *signed* document and returns status, signed-PDF URL, `embed_url`, and filled fields as a flat `{external_id: value}` map | `email`, `name_contains?` | read-only |
| `signrequest_get_document_fields` | A document's filled values as a flat `{external_id: value}` map + compact signers | `uuid`, `signer_email?` | read-only |
| `signrequest_get_signed_pdf` | Fresh (time-limited) signed-PDF + signing-log URLs | `uuid` | read-only |
| `signrequest_get_signing_link` | A signer's embedded signing link (`embed_url`) | `uuid`, `signer_email?` | read-only |
| `signrequest_get_documents` | Batch-fetch up to 50 documents as **compact** summaries (fewer round-trips, less context) | `uuids[]` | read-only |
| `signrequest_create_embedded_signing_links` | **Safe link generator** — forces `disable_emails` + embedded signing for every signer and returns each `embed_url`; **no one is emailed** | doc source *or* `document`, `signers[]` | write · no email |

**Safety flags:** `quick_create` / `send` / `resend` accept `dry_run` (preview who *would* be emailed, send nothing); `quick_create` accepts `disable_emails`; `get_document` accepts `compact`.

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

This MCP covers **twenty endpoints** of the SignRequest v1 API — the document-signing workflow plus read access to templates, events, and teams. The twenty base tools below map 1:1 to a method in [`src/signrequest.ts`](src/signrequest.ts); the seven [high-level helpers](#high-level-helpers--safety) compose these same endpoints (e.g. search → get → field-extract):

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
| `signrequest_delete_document` | `DELETE /documents/{uuid}/` |
| `signrequest_list_templates` | `GET /templates/` |
| `signrequest_get_template` | `GET /templates/{uuid}/` |
| `signrequest_list_events` | `GET /events/` |
| `signrequest_get_event` | `GET /events/{uuid}/` |
| `signrequest_list_teams` | `GET /teams/` |
| `signrequest_list_team_members` | `GET /team-members/` |
| `signrequest_add_document_attachment` | `POST /document-attachments/` |
| `signrequest_list_document_attachments` | `GET /document-attachments/` |
| `signrequest_get_document_attachment` | `GET /document-attachments/{uuid}/` |
| `signrequest_search_documents` | `GET /documents-search/` |

**Still not exposed** (present in the SignRequest v1 API, intentionally omitted):

- **Signer-collected attachments** as a standalone resource — they come back inline on the signer object via `signrequest_get` (document attachments themselves *are* supported, above)
- **Team write ops** — create/modify a team, fetch a single team by subdomain, invite members
- **API-token create/delete** — SignRequest's API is **list-only** for tokens (create/revoke are web-UI only); a read-only `list_api_tokens` tool can be added on request but it returns secret token values, so it's omitted by default. Also **e-sign disclosures**.
- A standalone signer resource — SignRequest has none; signer data comes back inside sign-request objects (`signrequest_get`)

If you need any of these, add a method to `SignRequestClient` and a tool in `registerTools()`. Full API: <https://signrequest.com/api/v1/docs/>.

The client (`Authorization: Token <token>`) retries only idempotent `GET`s (on `429`/`5xx`, exponential backoff honoring `Retry-After`); state-changing `POST`/`DELETE` calls are **never** auto-retried, to avoid double-creating/sending or other surprises.

---

## Configuration

Set via `npx wrangler secret put <NAME>` (secrets) or a `[vars]` block (non-secret). Add `-c wrangler.oauth.jsonc` to target the OAuth worker.

| Name | Worker | Required | Purpose |
|------|--------|----------|---------|
| `SIGNREQUEST_TOKEN` | both | ✅ | Team-scoped SignRequest API token |
| `MCP_AUTH_TOKEN` | bearer | ✅ | Shared bearer clients send as `Authorization: Bearer <…>` |
| `APP_PASSPHRASE` | oauth | ✅ | Passphrase entered on the OAuth consent screen |
| `OAUTH_KV` (binding) | oauth | ✅ | KV namespace storing OAuth grants/registrations |
| `SIGNREQUEST_FROM_EMAIL` | both | optional | Default sender, so callers can omit `from_email` |
| `SIGNREQUEST_BASE_URL` | both | optional | Override API base (default `https://signrequest.com/api/v1`) |
| `SIGNREQUEST_MAX_RETRIES` | both | optional | Max retries for idempotent calls (default `3`) |

---

## Deploy

```bash
npm install

# Bearer worker secrets — paste each value at the prompt (do NOT put it on the command line):
npx wrangler secret put SIGNREQUEST_TOKEN
npx wrangler secret put MCP_AUTH_TOKEN

npx wrangler deploy
```

Generate a strong `MCP_AUTH_TOKEN` without a trailing newline (a stray newline breaks the constant-time compare):

```bash
MCP_TOKEN=$(openssl rand -hex 32); printf '%s' "$MCP_TOKEN" | npx wrangler secret put MCP_AUTH_TOKEN; echo "MCP_AUTH_TOKEN=$MCP_TOKEN"
```

The first deploy creates the Durable Object (migration `v1`) and prints your `https://signrequest-mcp.<subdomain>.workers.dev` URL. For the OAuth worker, see [OAuth worker](#oauth-worker-claudeai-web).

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

The **bearer** worker can't be added to Claude.ai web (its connector UI requires OAuth, with no field for a static token). Use the **`signrequest-mcp-oauth`** deployment instead:

1. Deploy it and set its secrets — see [OAuth worker](#oauth-worker-claudeai-web).
2. In Claude.ai → **Settings → Connectors → Add custom connector**, enter the MCP URL:
   `https://signrequest-mcp-oauth.<subdomain>.workers.dev/mcp`
3. Claude.ai discovers OAuth automatically (dynamic client registration) and sends you to the consent screen. Enter your **passphrase** to authorize.

### Programmatic

Any HTTP MCP client works — send `Authorization: Bearer <MCP_AUTH_TOKEN>` and `Accept: application/json, text/event-stream` to `POST /mcp`.

---

## OAuth worker (Claude.ai web)

`signrequest-mcp-oauth` is the same MCP server fronted by an OAuth 2.1 provider, gated by a single shared passphrase. Routes:

| Route | Purpose |
|-------|---------|
| `GET /` | health check (no auth) |
| `GET`/`POST` `/authorize` | passphrase consent screen |
| `/token`, `/register`, `/.well-known/oauth-*` | OAuth endpoints (handled by the provider) |
| `POST /mcp`, `GET /sse` | MCP transports, OAuth-protected |

Deploy alongside the bearer worker:

```bash
# One-time: create the KV namespace the provider needs, then put its id in wrangler.oauth.jsonc
npx wrangler kv namespace create signrequest-mcp-oauth   # → { "binding": ..., "id": "<paste into kv_namespaces>" }

# Secrets (paste at the prompt; -c selects the OAuth worker):
npx wrangler secret put SIGNREQUEST_TOKEN -c wrangler.oauth.jsonc
npx wrangler secret put APP_PASSPHRASE   -c wrangler.oauth.jsonc

npx wrangler deploy -c wrangler.oauth.jsonc
```

`APP_PASSPHRASE` fails closed — if unset, the consent screen rejects every attempt. Then add the connector in Claude.ai per [Claude Web](#claude-web).

---

## Caveats

- **Existing-token-only.** SignRequest is owned by Box and is in maintenance mode; this assumes you already have a working team API token.
- **No Hebrew** in signer email/UI language (see [Signer object](#signer-object)).
- **Single-user OAuth.** The OAuth worker gates on one shared passphrase — fine for a personal connector, not multi-tenant. Swap the consent handler for a real IdP (GitHub/Google/etc.) if you need per-user identity.
- **SDK pin.** `@modelcontextprotocol/sdk` is pinned to `1.23.0` to match the copy `agents` bundles. Re-check when upgrading `agents`.

---

## Project layout

```
src/
  index.ts        Bearer worker entry — routing, bearer gate, McpAgent/Durable Object
  oauth.ts        OAuth worker entry — OAuthProvider + passphrase consent + McpAgent
  tools.ts        registerTools() — the 27 tool definitions + Zod schemas (shared)
  signrequest.ts  SignRequestClient — dependency-free REST client, fetch-only (shared)
  ai-stub.ts      stubs the unused `ai` peer dep out of the bundle
wrangler.jsonc        bearer worker config (signrequest-mcp)
wrangler.oauth.jsonc  OAuth worker config (signrequest-mcp-oauth) — adds OAUTH_KV
package.json          pinned deps (SDK 1.23.0, agents ^0.2.0, zod, workers-oauth-provider, wrangler)
```
