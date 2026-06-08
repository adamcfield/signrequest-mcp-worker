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

## Dependency advisories — resolved in v1.4.0

**v1.4.0** upgraded the runtime stack to `agents@0.14.5` + `@modelcontextprotocol/sdk@1.29.0`
+ `zod@4`, which clears the earlier MCP SDK advisories
([GHSA-8r9q-7v3j-jr4g](https://github.com/advisories/GHSA-8r9q-7v3j-jr4g) ReDoS,
[GHSA-345p-7cg4-v4c7](https://github.com/advisories/GHSA-345p-7cg4-v4c7) cross-client reuse,
[GHSA-w48q-cv73-mx4w](https://github.com/advisories/GHSA-w48q-cv73-mx4w) DNS-rebinding default).
`npm audit` now reports **0 vulnerabilities**, verified in CI on every push/PR. `ai`/`react` are
required peers of `agents` but are not imported into the Worker bundle.
