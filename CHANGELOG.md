# Changelog

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
