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
}

export interface QuickCreateParams extends DocumentParams {
  signers: Signer[];
  from_email?: string;
  from_email_name?: string;
  subject?: string;
  message?: string;
  send_reminders?: boolean;
  who?: "m" | "o" | "mo";
}

export interface ListQuery {
  page?: number;
  external_id?: string;
}

export class SignRequestClient {
  private token: string;
  private baseUrl: string;
  private maxRetries: number;
  private timeoutMs: number;

  constructor(opts: {
    token: string;
    baseUrl?: string;
    /** Max retry attempts for transient failures on idempotent (GET) calls. Default 3. */
    maxRetries?: number;
    /** Per-request timeout in ms. Default 30000. */
    timeoutMs?: number;
  }) {
    if (!opts.token) throw new Error("SignRequestClient requires an API token");
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  /** Exponential backoff with jitter; honors Retry-After (seconds) when present. */
  private backoff(attempt: number, retryAfter: string | null): Promise<void> {
    let delayMs: number;
    const secs = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(secs)) {
      delayMs = secs * 1000;
    } else {
      delayMs = Math.min(1000 * 2 ** attempt, 8000);
    }
    delayMs += Math.floor(Math.random() * 250); // jitter
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private async request<T = unknown>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Token ${this.token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const url = `${this.baseUrl}${path}`;
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

  // ---- Templates ----
  listTemplates(query?: ListQuery) {
    return this.request("GET", `/templates/${this.buildQuery(query)}`);
  }
}
