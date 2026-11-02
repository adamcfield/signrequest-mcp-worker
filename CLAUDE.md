# CLAUDE.md — SignRequest MCP Worker

Guide for AI coding agents working in this repo.

## What this is
A remote MCP server on Cloudflare Workers covering the whole SignRequest REST API v1 (47 tools), deployed as **two workers from shared code**:
- **`signrequest-mcp`** (`src/index.ts`, `wrangler.jsonc`): bring-your-own-key first: a caller's own token (`X-SignRequest-Token` / `Authorization: Token`, `src/byo.ts`) goes into the session props and is used as-is, no bearer needed. Otherwise bearer-gated (`MCP_AUTH_TOKEN`, constant-time, fails closed) and acts with the fallback team token `SIGNREQUEST_TOKEN`. `__unsafe_ensureInitialized` replaces the session's props whenever the credential changes. Serves `/mcp` (Streamable HTTP) and `/sse` (legacy).
- **`signrequest-mcp-oauth`** (`src/oauth.ts`, `wrangler.oauth.jsonc`): the claude.ai connector. `@cloudflare/workers-oauth-provider` with **SignRequest's own OAuth2 login** as the upstream (`SR_CLIENT_ID`/`SR_CLIENT_SECRET`); each user acts with their own token (`Bearer`). `/mcp` only.

Both bind the Durable Object `MCP_OBJECT` → class `SignRequestMCP` (migration `v1`, `new_sqlite_classes`); keep the migrations in both configs in sync.

## Layout
- `src/signrequest.ts` — dependency-free `SignRequestClient` (`fetch` only): retries **GETs only** (429/5xx/network, `Retry-After`-aware backoff), never retries writes (double-send risk); `paginate()` for count/next/results; `mapLimit` bounded concurrency; logs method+path of every write (no PII).
- `src/tools.ts` — `registerTools(server, client, opts)`: every tool + zod schemas + pure helpers (`compactDoc`, `pickSigner`, `extractFields`, `readableStatus`, `buildSignerSummary`, `redactApiToken`). `VERSION` lives here.
- `src/oauth.ts` — OAuth provider wiring, `/authorize` → SignRequest, `/callback` code exchange, `tokenExchangeCallback` refreshes the upstream token whenever Claude refreshes ours.
- `src/ai-stub.ts` — aliases the unused `ai` peer of `agents` out of the bundle.
- `tests/` — vitest, `fetch` stubbed. `src/oauth.ts` imports `cloudflare:workers` and can't load under Node; `tests/oauth.test.ts` checks it by source text and guards library contracts.

## Conventions
- Tool names `signrequest_<verb>_<noun>` (a few legacy bare ones: `signrequest_get`, `_list`, `_send`, `_cancel`, `_resend` — don't rename without an alias plan; claude.ai caches tool names per connector).
- Reads: `server.registerTool` + `READ_ONLY` annotations. Writes: `writeTool(...)`, which registers nothing when `MCP_READONLY=true`. Destructive tools set `destructiveHint`; every new write tool gets `dry_run` (GET-only preview).
- Handlers go through `run()`, which turns `SignRequestError` into an `isError` result — never throw out of a handler.
- Keep output small: return `compactDoc` shapes by default, raw objects only on explicit request (`get_document compact=false`). Never return API token keys (`redactApiToken`).
- Bump `VERSION` (tools.ts) + `package.json` + `package-lock.json` (`npm version <v> --no-git-tag-version`) + a dated `CHANGELOG.md` entry together.

## Workflows
- `npm run typecheck` and `npm test` must pass before committing (CI runs both on Node 24).
- `npx wrangler deploy --dry-run` / `-c wrangler.oauth.jsonc --dry-run` to check the bundle.
- Deploys are manual: `npm run deploy` (bearer), `npm run deploy:oauth`. Post-deploy: `MCP_URL=… MCP_TOKEN=… npm run smoke` (bearer worker).

## Gotchas learned
- **Team context.** A SignRequest *login* token spans every team the user is in. Against `signrequest.com/api/v1` it sees 0 events, 403 on `/audit-events/` and only user-owned documents. Calls must go to `https://<team>.signrequest.com/api/v1` — `SIGNREQUEST_TEAM` in `wrangler.oauth.jsonc`.
- `MCP_RESOURCE` in `src/oauth.ts` must stay the exact `/mcp` URL existing grants were issued for, or every connected user is signed out.
- OAuth user IDs must not contain `:` (the provider uses it as a token separator).
- The OAuth agent overrides `__unsafe_ensureInitialized` (internal `agents` API) to pick up refreshed upstream tokens mid-session; `tests/oauth.test.ts` fails if `agents` stops calling it. Re-check on every `agents` upgrade.
- `@modelcontextprotocol/sdk` is pinned exactly because `agents` pins it; `undici` is pinned via `overrides`.
- SignRequest's `/events/` log has no "which URL" field. A document's `events_callback_url` overrides the team's — `webhook_health` attributes failures by looking documents up.
- `signing_log` on a document is an object `{pdf, security_hash}`, not a URL.
- Signer `language` accepts `he` even though SignRequest's published list omits it.
- Status codes: `co ne se vi si sd do ca de ex er` → `readableStatus`; signed = `si`/`sd`/`do`.
- Full document objects are full of signer PII (ID numbers, phones, addresses). Don't dump them into tool output, logs, commits or issues.
