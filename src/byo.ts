/**
 * Bring-your-own-key for the bearer worker (shared MCP worker standard §3A).
 * Pure helpers, kept out of index.ts so they can be unit-tested under Node.
 */

/** Per-session props. Empty = the worker's fallback token; set = the caller's own token. */
export type Props = { token?: string; team?: string };

/** A SignRequest team subdomain (`acme` in acme.signrequest.com). Anything else is ignored. */
const TEAM_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The caller's own SignRequest credential, if they sent one. Never logged. */
export function byoCredential(request: Request, env: { MCP_BYO_KEYS?: string }): Props | null {
  if (env.MCP_BYO_KEYS === "false") return null;
  const header = request.headers.get("x-signrequest-token")?.trim();
  const auth = request.headers.get("authorization") ?? "";
  const token = header || (/^token\s+/i.test(auth) ? auth.replace(/^token\s+/i, "").trim() : "");
  if (!token || token.length > 200) return null;
  const team = request.headers.get("x-signrequest-team")?.trim().toLowerCase();
  return { token, ...(team && TEAM_RE.test(team) ? { team } : {}) };
}

/** API base for a caller's own token: their team subdomain, else the public host. Never the env override. */
export function byoBaseUrl(props: Props): string | undefined {
  return props.team ? `https://${props.team}.signrequest.com/api/v1` : undefined;
}
