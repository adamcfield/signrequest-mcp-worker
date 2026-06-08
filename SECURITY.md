# Security

## Reporting a vulnerability

Please **don't** open a public issue for security problems. Open a private
[GitHub security advisory](https://github.com/adamcfield/signrequest-mcp-worker/security/advisories/new)
or contact the maintainer directly.

## Hardening built in

- **Auth-gated, fail-closed.** The bearer worker requires `Authorization: Bearer <MCP_AUTH_TOKEN>`
  (constant-time compare; if no token is configured, everything returns 401). The OAuth worker
  gates on OAuth 2.1 + a passphrase. The SignRequest API token never leaves the Worker.
- **Per-session isolation.** Each MCP session runs in its own Durable Object instance — server
  and transport objects are not shared across clients.
- **Safe by default.** Writes are never auto-retried (no double-send); batch tools use bounded
  concurrency; idempotent GETs use `Retry-After`-aware backoff.
- **No secrets in the repo**; non-PII audit logging of state-changing calls; optional
  `MCP_READONLY=true` mode that registers read tools only.

## Known dependency advisories (tracked)

Two transitive **runtime** dependencies — `@modelcontextprotocol/sdk` (pinned `1.23.0`) and
`agents` (`^0.2.x`) — currently carry the advisories below. Their realistic exposure for this
deployment is **low** because of the hardening above:

| Advisory | Exposure here |
| --- | --- |
| [GHSA-8r9q-7v3j-jr4g](https://github.com/advisories/GHSA-8r9q-7v3j-jr4g) — SDK ReDoS | Low — reachable only by an already-authorized client. |
| [GHSA-345p-7cg4-v4c7](https://github.com/advisories/GHSA-345p-7cg4-v4c7) — cross-client instance-reuse leak | Low — each session runs in its own Durable Object; instances aren't shared across clients. |
| [GHSA-w48q-cv73-mx4w](https://github.com/advisories/GHSA-w48q-cv73-mx4w) — DNS-rebinding off by default | Low — remote, token-gated Worker, not a localhost server (DNS rebinding targets local servers). |

**Remediation status.** The upstream fix is `agents@0.14+` (which bundles a patched SDK `1.29`),
but that is a **breaking** upgrade: it requires `zod@^4`, `ai@^6`, and a heavier peer set, and
changes the framework surface — it does not resolve against the current pinned stack
(`npm install agents@latest` fails `ERESOLVE`). The upgrade is tracked as a planned, separately
verified change. Until then the advisories are mitigated by the auth gate + per-session isolation.
Re-evaluate when `agents`/SDK ship a non-breaking patched line.
