/**
 * Minimal SignRequest REST API (v1) client.
 *
 * Dependency-free: uses only the global `fetch`, so this exact file also runs
 * unmodified inside a Cloudflare Worker. Auth is a team-scoped API token sent
 * as `Authorization: Token <token>`.
 *
 * Docs: https://signrequest.com/api/v1/docs/
 */

export const DEFAULT_BASE_URL = "https://signrequest.com/api/v1";

export class SignRequestError extends Error {
  constructor(
    public status: number,
    public body: string,
    public method: string,
    public path: string,
  ) {
    super(`SignRequest API ${method} ${path} -> ${status}: ${body}`);
    this.name = "SignRequestError";
  }
}

/**
 * Run an async fn over `items` with bounded concurrency, preserving input order.
 * Enterprise batch ops (campaign rollups, bulk send) use this so we never open
 * hundreds of simultaneous connections or trip SignRequest's rate limiter.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export interface Signer {
  /** Signer email. Required. */
  email: string;
  first_name?: string;
  last_name?: string;
  /** Signing order; lower signs first. The sender (owner) is always index 0. */
  order?: number;
  /** Email/UI language. Supported: en, en-gb, nl, fr, de, da, fi, hu, it, no, pl, pt, es, sv. (No Hebrew.) */
  language?: string;
  force_language?: boolean;
  /** Per-signer message. */
  message?: string;
  /** Redirect here after signing (only if no chained documents remain). */
  redirect_url?: string;
  /**
   * Enable EMBEDDED signing for this signer: the API returns an `embed_url`
   * (a direct signing link) for them and SignRequest does NOT email them.
   * Value is your app's user id (recorded in the signing log).
   */
  embed_url_user_id?: string;
}

export interface DocumentParams {
  /** Public URL SignRequest can download (preferred for large files). */
  file_from_url?: string;
  /** Base64-encoded file contents. Use only for small files. */
  file_from_content?: string;
  /** Filename WITH extension for file_from_content, e.g. "contract.pdf". */
  file_from_content_name?: string;
  /** Template resource URL to base the document on. */
  template?: string;
  /** Your own reference id for this document. */
  external_id?: string;
  /** Display name; defaults to the filename. */
  name?: string;
  /** Per-document webhook callback URL. */
  events_callback_url?: string;
}

export interface SendParams {
  /** Resource URL of an already-created document. */
  document: string;
  signers: Signer[];
  from_email?: string;
  from_email_name?: string;
  subject?: string;
  message?: string;
  send_reminders?: boolean;
  /** 'm' = only me, 'o' = only others, 'mo' = me & others. */
  who?: "m" | "o" | "mo";
  /** Suppress SignRequest status emails (event emails also need a callback_url). */
  disable_emails?: boolean;
}

export interface QuickCreateParams extends DocumentParams {
  signers: Signer[];
  from_email?: string;
  from_email_name?: string;
  subject?: string;
  message?: string;
  send_reminders?: boolean;
  who?: "m" | "o" | "mo";
  /** Suppress SignRequest status emails. Combine with per-signer embed_url_user_id for a silent request. */
  disable_emails?: boolean;
}

export interface ListQuery {
  page?: number;
  limit?: number;
  external_id?: string;
}

/** Webhook event types accepted by /webhooks/ (from the SignRequest OpenAPI spec). */
export const WEBHOOK_EVENT_TYPES = [
  "convert_error", "converted", "sending_error", "sent", "declined", "cancelled", "expired",
  "signed", "viewed", "downloaded", "signer_signed", "signer_email_bounced", "signer_viewed_email",
  "signer_viewed", "signer_forwarded", "signer_downloaded", "signrequest_received",
  "login_failed", "login_successful", "password_reset_request_sent", "password_reset_request_error",
] as const;
export const WEBHOOK_INTEGRATIONS = ["mfiles", "salesforce", "formdesk", "zapier", "microsoft-flow"] as const;

export interface WebhookParams {
  event_type: (typeof WEBHOOK_EVENT_TYPES)[number];
  callback_url: string;
  name?: string | null;
  integration?: (typeof WEBHOOK_INTEGRATIONS)[number] | null;
}

export interface TeamParams {
  name?: string;
  subdomain?: string;
  phone?: string;
  primary_color?: string;
  events_callback_url?: string;
  documents_as_attachments?: boolean;
}

export interface AuditEventQuery {
  page?: number;
  limit?: number;
  user_email?: string;
  user_ip?: string;
  event_type?: string;
  status?: "success" | "error";
  timestamp__date__lt?: string;
  timestamp__date__lte?: string;
  timestamp__date__gt?: string;
  timestamp__date__gte?: string;
}

export class SignRequestClient {
  private token: string | (() => string);
  private authScheme: "Token" | "Bearer";
  private baseUrl: string;
  private maxRetries: number;
  private timeoutMs: number;
  private backoffBaseMs: number;

  constructor(opts: {
    /** API token, or a getter so a refreshed OAuth token is picked up on every request. */
    token: string | (() => string);
    /** "Token" for team API tokens (default), "Bearer" for SignRequest OAuth2 access tokens. */
    authScheme?: "Token" | "Bearer";
    baseUrl?: string;
    /** Max retry attempts for transient failures on idempotent (GET) calls. Default 3. */
    maxRetries?: number;
    /** Per-request timeout in ms. Default 30000. */
    timeoutMs?: number;
    /** Base for exponential backoff (ms). Default 1000. Lower it in tests for speed. */
    backoffBaseMs?: number;
  }) {
    if (!opts.token) throw new Error("SignRequestClient requires an API token");
    this.token = opts.token;
    this.authScheme = opts.authScheme ?? "Token";
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
  }

  /** Exponential backoff with jitter; honors Retry-After (seconds) when present. */
  private backoff(attempt: number, retryAfter: string | null): Promise<void> {
    let delayMs: number;
    const secs = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(secs)) {
      delayMs = secs * 1000;
    } else {
      delayMs = Math.min(this.backoffBaseMs * 2 ** attempt, 8000);
    }
    delayMs += Math.floor(Math.random() * 250); // jitter
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `${this.authScheme} ${typeof this.token === "function" ? this.token() : this.token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const url = `${this.baseUrl}${path}`;
    if (method !== "GET") {
      // Non-PII audit trail for state-changing calls (surfaced via `wrangler tail`).
      try {
        console.log(`[signrequest-mcp] ${method} ${path}`);
      } catch {
        /* ignore */
      }
    }
    // Only GETs are retried. POSTs (create/send/cancel/resend) are never auto-retried,
    // since a retry could double-create a document or re-send signing emails.
    const isIdempotent = method === "GET";

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);

        const text = await res.text();
        if (res.ok) return (text ? JSON.parse(text) : {}) as T;

        const retryable = isIdempotent && (res.status === 429 || res.status >= 500);
        if (!retryable || attempt >= this.maxRetries) {
          throw new SignRequestError(res.status, text || res.statusText, method, path);
        }
        await this.backoff(attempt, res.headers.get("retry-after"));
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof SignRequestError) throw err;
        // Network error or timeout (AbortError). Retry idempotent calls only.
        if (!isIdempotent || attempt >= this.maxRetries) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`SignRequest request failed (${method} ${path}): ${reason}`);
        }
        await this.backoff(attempt, null);
      }
    }
  }

  private buildQuery(q?: ListQuery): string {
    if (!q) return "";
    const params = new URLSearchParams();
    if (q.page !== undefined) params.set("page", String(q.page));
    if (q.limit !== undefined) params.set("limit", String(q.limit));
    if (q.external_id) params.set("external_id", q.external_id);
    const s = params.toString();
    return s ? `?${s}` : "";
  }

  // ---- Documents ----
  createDocument(params: DocumentParams) {
    return this.request("POST", "/documents/", params);
  }
  getDocument(uuid: string) {
    return this.request("GET", `/documents/${uuid}/`);
  }
  listDocuments(query?: ListQuery) {
    return this.request("GET", `/documents/${this.buildQuery(query)}`);
  }
  /** Permanently delete a document (and its signature requests). Irreversible. */
  deleteDocument(uuid: string) {
    return this.request("DELETE", `/documents/${uuid}/`);
  }

  // ---- SignRequests ----
  send(params: SendParams) {
    return this.request("POST", "/signrequests/", params);
  }
  quickCreate(params: QuickCreateParams) {
    return this.request("POST", "/signrequest-quick-create/", params);
  }
  getSignRequest(uuid: string) {
    return this.request("GET", `/signrequests/${uuid}/`);
  }
  listSignRequests(query?: ListQuery) {
    return this.request("GET", `/signrequests/${this.buildQuery(query)}`);
  }
  cancel(uuid: string) {
    return this.request("POST", `/signrequests/${uuid}/cancel_signrequest/`, {});
  }
  resend(uuid: string) {
    return this.request("POST", `/signrequests/${uuid}/resend_signrequest_email/`, {});
  }
  forwardSigner(
    uuid: string,
    params: { signer_email_to_forward: string; signer_email_to_forward_to: string; forwarded_reason?: string },
  ) {
    return this.request("POST", `/signrequests/${uuid}/forward_signer/`, params);
  }

  // ---- Templates ----
  listTemplates(query?: ListQuery) {
    return this.request("GET", `/templates/${this.buildQuery(query)}`);
  }
  getTemplate(uuid: string) {
    return this.request("GET", `/templates/${uuid}/`);
  }

  // ---- Events (webhook delivery log) ----
  listEvents(query?: ListQuery) {
    return this.request("GET", `/events/${this.buildQuery(query)}`);
  }
  getEvent(uuid: string) {
    return this.request("GET", `/events/${uuid}/`);
  }

  // ---- Teams ----
  listTeams(query?: ListQuery) {
    return this.request("GET", `/teams/${this.buildQuery(query)}`);
  }
  listTeamMembers(query?: ListQuery) {
    return this.request("GET", `/team-members/${this.buildQuery(query)}`);
  }
  getTeamMember(uuid: string) {
    return this.request("GET", `/team-members/${uuid}/`);
  }
  getTeam(subdomain: string) {
    return this.request("GET", `/teams/${encodeURIComponent(subdomain)}/`);
  }
  createTeam(params: TeamParams & { name: string; subdomain: string }) {
    return this.request("POST", "/teams/", params);
  }
  updateTeam(subdomain: string, params: TeamParams) {
    return this.request("PATCH", `/teams/${encodeURIComponent(subdomain)}/`, params);
  }
  /** Delete a team. Irreversible. */
  deleteTeam(subdomain: string) {
    return this.request("DELETE", `/teams/${encodeURIComponent(subdomain)}/`);
  }
  inviteTeamMember(subdomain: string, params: { email: string; is_admin?: boolean; is_owner?: boolean }) {
    return this.request("POST", `/teams/${encodeURIComponent(subdomain)}/invite_member/`, params);
  }

  // ---- Webhook subscriptions ----
  listWebhooks(query?: ListQuery) {
    return this.request("GET", `/webhooks/${this.buildQuery(query)}`);
  }
  getWebhook(uuid: string) {
    return this.request("GET", `/webhooks/${uuid}/`);
  }
  createWebhook(params: WebhookParams) {
    return this.request("POST", "/webhooks/", params);
  }
  /** PATCH (partial) by default; `replace` uses PUT, which needs event_type + callback_url. */
  updateWebhook(uuid: string, params: Partial<WebhookParams>, replace = false) {
    return this.request(replace ? "PUT" : "PATCH", `/webhooks/${uuid}/`, params);
  }
  /** Delete a webhook subscription. Irreversible. */
  deleteWebhook(uuid: string) {
    return this.request("DELETE", `/webhooks/${uuid}/`);
  }
  /** Every webhook subscription, following pagination. */
  listAllWebhooks(cap = 500): Promise<unknown[]> {
    return this.paginate((page) => this.listWebhooks({ page, limit: 100 }), cap);
  }

  // ---- Audit log & API tokens ----
  listAuditEvents(query: AuditEventQuery = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    }
    const s = params.toString();
    return this.request("GET", `/audit-events/${s ? `?${s}` : ""}`);
  }
  listApiTokens(query?: ListQuery) {
    return this.request("GET", `/api-tokens/${this.buildQuery(query)}`);
  }

  // ---- Document attachments ----
  addDocumentAttachment(params: {
    document: string;
    file_from_url?: string;
    file_from_content?: string;
    file_from_content_name?: string;
  }) {
    return this.request("POST", "/document-attachments/", params);
  }
  listDocumentAttachments(query?: ListQuery) {
    return this.request("GET", `/document-attachments/${this.buildQuery(query)}`);
  }
  getDocumentAttachment(uuid: string) {
    return this.request("GET", `/document-attachments/${uuid}/`);
  }

  // ---- Search ----
  searchDocuments(query: {
    q?: string;
    name?: string;
    signer_emails?: string;
    status?: string;
    who?: string;
    signer_data?: boolean;
    page?: number;
  }) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    }
    const s = params.toString();
    return this.request("GET", `/documents-search/${s ? `?${s}` : ""}`);
  }

  // ---- Auto-pagination ----
  /** Walk every page of a paginated endpoint (count/next/results) up to `cap` items. */
  private async paginate(
    getPage: (page: number) => Promise<unknown>,
    cap: number,
  ): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; page <= 1000; page++) {
      const res = (await getPage(page)) as { results?: unknown[]; next?: string | null };
      const results = res?.results ?? [];
      all.push(...results);
      if (!res?.next || all.length >= cap) break;
    }
    return all.slice(0, cap);
  }

  /** Every document (most recent first), following pagination up to `cap` (default 500). */
  listAllDocuments(opts: { cap?: number; external_id?: string } = {}): Promise<unknown[]> {
    return this.paginate(
      (page) => this.listDocuments({ page, external_id: opts.external_id }),
      opts.cap ?? 500,
    );
  }

  /** Every search hit, following pagination up to `cap` (default 500). */
  searchAllDocuments(
    query: { q?: string; name?: string; signer_emails?: string; status?: string; signer_data?: boolean },
    cap = 500,
  ): Promise<unknown[]> {
    return this.paginate((page) => this.searchDocuments({ ...query, page }), cap);
  }
}
