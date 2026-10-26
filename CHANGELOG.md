# Changelog

## 1.5.2 — Team context for SignRequest login

### Changed
- OAuth worker pins `SIGNREQUEST_TEAM=voltasolar` (`wrangler.oauth.jsonc` vars). A SignRequest login spans every team the user belongs to, and without a team host it sees **no** events, a 403 audit log and only user-owned documents; via `https://voltasolar.signrequest.com/api/v1` it sees all 83k events, the audit log and API-created documents.
- `webhook_health` scans 100 events per page (was 10), reports `oldest_event_scanned`, and returns a `warnings` entry instead of an all-clear when no events are visible.
- OAuth worker: passphrase sign-in and the shared `SIGNREQUEST_TOKEN` retired — SignRequest login only.

## 1.5.1 — Dependency security upgrade

### Changed
- `agents` 0.14 → **0.30.1**, `@modelcontextprotocol/sdk` 1.29 → **1.32.1**, `zod` → **4.6.7**, `@cloudflare/workers-oauth-provider` 0.7 → **1.2.4**, `wrangler` → 4.152, `@cloudflare/workers-types` → 5.x. `undici` pinned to 7.30.1 via `overrides` (wrangler's miniflare ships a vulnerable one). `npm audit`: **0 vulnerabilities** (was 29).
- OAuth worker: canonical resource set to `…/mcp` (what existing grants carry, so sessions survive); legacy SSE dropped from the OAuth worker (1.x requires every API route under the resource) — the bearer worker still serves `/sse`.
- CI on Node 24 (Node 20 is end-of-life, and npm 10 can't resolve `agents` 0.30's peer set).

### Fixed
- SignRequest-login grants used a `:` in the user ID, which the OAuth provider can't parse in tokens — would have broken every login-mode session (login mode wasn't enabled yet).

## 1.5.0 — Webhooks, full API coverage, SignRequest login

### Added
- **Webhook subscriptions** (`/webhooks/`): `list_webhooks`, `get_webhook`, `create_webhook`, `update_webhook` (PATCH, or PUT with `replace`), `delete_webhook`, plus `webhook_health` — subscriptions, team callback URL and recent deliveries by HTTP status with failures listed.
- **Rest of the API spec**: `forward_signer`, `get_team`, `create_team`, `update_team`, `delete_team` (needs `confirm_subdomain`), `invite_team_member`, `get_team_member`, `list_audit_events`, `list_api_tokens` (keys redacted). Every operation in the v1 spec now has a tool — 47 tools.
- **SignRequest login for the OAuth worker**: with `SR_CLIENT_ID`/`SR_CLIENT_SECRET` set, Connect goes through SignRequest's own OAuth2 login; each user acts with their own token (`Bearer`), refreshed upstream on every Claude token refresh and picked up by running sessions. Passphrase mode remains the fallback. Optional `SIGNREQUEST_TEAM` for team context.
- `dry_run` on every new write tool; version shown in both health checks.

### Fixed
- OAuth consent screen: UTF-8-safe encoding of the auth request (non-Latin `state` broke `/authorize`).
- CI: `package-lock.json` resynced — `npm ci` had failed on every run since 1.4.0.

## 1.4.0 — Dependency upgrade (security)

### Changed
- Upgraded `agents` 0.2 → **0.14.5**, `@modelcontextprotocol/sdk` 1.23 → **1.29.0**, `zod` 3 → **4**.
  Clears 3 MCP SDK advisories (ReDoS, cross-client instance reuse, DNS-rebinding default) —
  `npm audit` now reports **0 vulnerabilities**.
- No API or behavior change: same 32 tools; typecheck + 24 tests green; both workers redeployed
  and smoke-verified live (tool execution + zod-4 input validation). `ai`/`react` are required
  peers of `agents` but are never bundled into the Worker.

## 1.3.0 — Enterprise pass

### Added
- **Campaign-scale capabilities** (logic the SignRequest API lacks):
  - `signrequest_campaign_status` — roster-wide rollup with bounded concurrency; aggregate counts + per-person status/fields in one call.
  - `signrequest_bulk_send` — send the same template/file to many recipients (one request each); per-recipient results, `dry_run`, and an `embedded` (no-email) mode.
  - `signrequest_list_all_documents` — auto-paginated, compact list.
  - `signrequest_list_template_fields` — discover a template's `external_id`s / prefill tags.
  - `signrequest_wait_until_signed` — bounded poll to a terminal state (≤25s).
- **Enterprise controls:** `MCP_READONLY=true` registers read tools only (writes are never registered); non-PII audit logging of every state-changing API call (visible via `wrangler tail`).
- **Stability & performance:** `mapLimit` bounded-concurrency batch helper; client auto-pagination (`listAllDocuments` / `searchAllDocuments`); injectable `backoffBaseMs`.
- **Quality:** vitest unit suite (client retry/backoff/pagination/no-retry-on-POST, pure helpers, signer-summary composition) + GitHub Actions CI; `npm run smoke` extended to 32 tools.

### Fixed
- `pickSigner` no longer returns the sender/owner just because they're auto-"signed"; it now prefers the actual recipient signer (whose field values matter). Caught by the new test suite.

## 1.2.0 — High-level helpers & safety

### Added
- Helpers: `get_signer_summary`, `get_document_fields`, `get_signed_pdf`, `get_signing_link`, `get_documents` (batch/compact), `create_embedded_signing_links` (safe, no-email), `whoami`.
- Safety/efficiency flags: `dry_run` on `quick_create`/`send`/`resend`; `disable_emails` on `quick_create`; `compact` on `get_document`.

## 1.1.0

- Search, document attachments, events, teams, delete; OAuth worker for Claude.ai web. (20 tools)
