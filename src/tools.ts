/**
 * Shared SignRequest tool registration.
 *
 * Used by BOTH the stdio server (src/index.ts) and the Cloudflare Worker, so the
 * tool surface, schemas, and safety annotations stay identical across transports.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SignRequestClient, SignRequestError, mapLimit, type Signer } from "./signrequest.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run an API call and normalize errors into a tool error (never throw). */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof SignRequestError) {
      return fail(`SignRequest API error ${err.status}\n${err.body}`);
    }
    return fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- Helpers shared by the high-level convenience tools ----
type AnyRec = Record<string, any>;

/** SignRequest 2-letter document status codes -> human-readable. */
const DOC_STATUS: Record<string, string> = {
  co: "converting", ne: "new", se: "sent", vi: "viewed", si: "signed",
  do: "signed (downloaded)", sd: "signed (downloaded)", ca: "cancelled",
  de: "declined", ex: "expired", er: "error",
};
export const readableStatus = (code?: string): string => (code && DOC_STATUS[code]) || code || "unknown";
export const isSignedCode = (code?: string): boolean => code === "si" || code === "sd" || code === "do";

/** Flatten a signer's filled inputs to a { external_id: value } map (text/date/checkbox). */
export function extractFields(signer: AnyRec | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const inp of (signer?.inputs as AnyRec[]) ?? []) {
    const id = inp?.external_id;
    if (!id) continue;
    const v =
      inp.text != null && inp.text !== "" ? String(inp.text)
      : inp.date_value != null ? String(inp.date_value)
      : inp.checkbox_value != null ? String(inp.checkbox_value)
      : "";
    if (v !== "") out[id] = v;
  }
  return out;
}

/** Pick the relevant signer: the matching email, else the one who signed, else the first non-owner. */
export function pickSigner(doc: AnyRec, email?: string): AnyRec | null {
  const sr = (doc?.signrequest as AnyRec) ?? {};
  const signers: AnyRec[] = sr.signers ?? [];
  if (!signers.length) return null;
  const lower = email?.toLowerCase();
  const owner = String(sr.from_email ?? "").toLowerCase();
  const isOwner = (s: AnyRec) => String(s.email ?? "").toLowerCase() === owner;
  // Precedence: exact email match > signed non-owner > any non-owner > any signed > first.
  // (The sender/owner is often auto-"signed", so we must not return them just because they
  // signed — the field values we care about live on the actual recipient signer.)
  return (
    (lower ? signers.find((s) => String(s.email ?? "").toLowerCase() === lower) : undefined) ??
    signers.find((s) => s.signed && !isOwner(s)) ??
    signers.find((s) => !isOwner(s)) ??
    signers.find((s) => s.signed) ??
    signers[0] ?? null
  );
}

/** Trim a document object to the fields that matter (keeps LLM context small). */
export function compactDoc(doc: AnyRec): AnyRec {
  const sr = (doc?.signrequest as AnyRec) ?? {};
  const signers: AnyRec[] = sr.signers ?? [];
  return {
    uuid: doc.uuid,
    name: doc.name,
    status: readableStatus(doc.status),
    status_code: doc.status ?? null,
    signed_pdf_url: doc.pdf ?? null,
    signing_log_url: doc.signing_log ?? null,
    external_id: doc.external_id ?? null,
    signers: signers.map((s) => ({
      email: s.email,
      signed: !!s.signed,
      declined: !!s.declined,
      viewed: !!(s.viewed ?? s.email_viewed),
      embed_url: s.embed_url ?? null,
    })),
  };
}

/** Build a one-shot signer summary (shared by get_signer_summary + campaign_status). */
export async function buildSignerSummary(
  client: SignRequestClient,
  email: string,
  nameContains?: string,
): Promise<AnyRec> {
  const lower = email.toLowerCase();
  const search = (await client.searchDocuments({ signer_emails: lower, signer_data: true })) as AnyRec;
  let results: AnyRec[] = search?.results ?? [];
  if (nameContains) results = results.filter((r) => String(r.name ?? "").includes(nameContains));
  const documents = results.map((r) => ({ uuid: r.uuid, name: r.name, status: readableStatus(r.status) }));
  const signedHit = results.find((r) => isSignedCode(r.status));
  const target = signedHit ?? results[0];
  if (!target) {
    return {
      email: lower, status: "not_found", matched_documents: 0, documents,
      signed_doc_uuid: null, signed_pdf_url: null, embed_url: null, sign_date: null, fields: {},
    };
  }
  const doc = (await client.getDocument(target.uuid)) as AnyRec;
  const signer = pickSigner(doc, lower);
  const fields = extractFields(signer);
  return {
    email: lower,
    status: readableStatus(doc.status),
    signed: !!signer?.signed,
    matched_documents: results.length,
    documents,
    signed_doc_uuid: signedHit ? doc.uuid : null,
    signed_pdf_url: signedHit ? (doc.pdf ?? null) : null,
    embed_url: signer?.embed_url ?? null,
    sign_date: fields.SignDate ?? null,
    fields,
  };
}

/** Lightweight, non-PII audit line for write operations (surfaced via `wrangler tail`). */
function audit(action: string, meta: Record<string, unknown>): void {
  try {
    console.log(`[signrequest-mcp audit] ${action} ${JSON.stringify(meta)}`);
  } catch {
    /* never let logging break a tool call */
  }
}

const signerSchema = z.object({
  email: z.string().email().describe("Signer email address."),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  order: z
    .number()
    .int()
    .optional()
    .describe("Signing order; lower signs first. The sender is always order 0."),
  language: z
    .string()
    .optional()
    .describe(
      "Email/UI language. Supported: en, en-gb, nl, fr, de, da, fi, hu, it, no, pl, pt, es, sv. Hebrew is NOT supported.",
    ),
  force_language: z.boolean().optional(),
  message: z.string().optional().describe("Per-signer message."),
  redirect_url: z.string().url().optional().describe("URL to redirect to after signing."),
  embed_url_user_id: z
    .string()
    .optional()
    .describe(
      "Enable EMBEDDED signing for this signer: the response includes an 'embed_url' (direct signing link) and SignRequest does NOT email this signer. Value is your app's user id (shows in the signing log).",
    ),
});

const docSourceShape = {
  file_from_url: z
    .string()
    .url()
    .optional()
    .describe("Public URL SignRequest will download. Preferred for anything but tiny files."),
  file_from_content: z
    .string()
    .optional()
    .describe("Base64-encoded file contents. Use only for small files; bloats context otherwise."),
  file_from_content_name: z
    .string()
    .optional()
    .describe("Filename WITH extension for file_from_content, e.g. 'contract.pdf'. Required if file_from_content is set."),
  template: z.string().url().optional().describe("Template resource URL to base the document on."),
};

function validateDocSource(a: {
  file_from_url?: string;
  file_from_content?: string;
  file_from_content_name?: string;
  template?: string;
}) {
  if (!a.file_from_url && !a.file_from_content && !a.template) {
    throw new Error("Provide one of: file_from_url, file_from_content (+name), or template.");
  }
  if (a.file_from_content && !a.file_from_content_name) {
    throw new Error("file_from_content_name is required when file_from_content is provided.");
  }
}

// Annotations: hints so a client knows which tools are safe to auto-run.
// All tools call an external service, so openWorldHint is true throughout.
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

export interface RegisterToolsOptions {
  /** Default sender email if a tool call omits from_email. */
  defaultFromEmail?: string;
  /** When true, write/state-changing tools are not registered at all (reporting-only deploys). */
  readOnly?: boolean;
}

/** Register all SignRequest tools onto the given MCP server. */
export function registerTools(
  server: McpServer,
  client: SignRequestClient,
  opts: RegisterToolsOptions = {},
): void {
  const resolveFromEmail = (provided?: string): string => {
    const v = provided ?? opts.defaultFromEmail;
    if (!v) {
      throw new Error(
        "from_email is required: pass it to the tool or set a default sender (SIGNREQUEST_FROM_EMAIL).",
      );
    }
    return v;
  };

  // Register a write/state-changing tool — a no-op when the server is read-only
  // (MCP_READONLY), so those tools never even appear in tools/list. Reads use
  // server.registerTool directly. Typed as the real method so handler arg
  // inference from the Zod inputSchema is preserved.
  const noop = (() => undefined) as unknown as McpServer["registerTool"];
  const writeTool: McpServer["registerTool"] = opts.readOnly
    ? noop
    : (server.registerTool.bind(server) as McpServer["registerTool"]);

  writeTool(
    "signrequest_quick_create",
    {
      description:
        "Create a document AND send the signature request in one call. The most common entry point. Provide a document source (file_from_url preferred, or base64 file_from_content + name, or a template URL) and at least one signer. Sends real emails.",
      inputSchema: {
        ...docSourceShape,
        signers: z.array(signerSchema).min(1).describe("People who need to sign."),
        from_email: z.string().email().optional().describe("Sender email (must belong to the token's team). Falls back to the configured default sender."),
        from_email_name: z.string().optional(),
        subject: z.string().optional(),
        message: z.string().optional().describe("Email body. Limited HTML allowed (a,b,i,em,strong,ul,ol,li,blockquote,code,abbr,acronym)."),
        send_reminders: z.boolean().optional().describe("Auto-remind signers who haven't signed."),
        who: z.enum(["m", "o", "mo"]).optional().describe("'m'=only me, 'o'=only others, 'mo'=me & others."),
        external_id: z.string().optional().describe("Your reference id for the document."),
        name: z.string().optional().describe("Document display name."),
        events_callback_url: z.string().url().optional().describe("Per-document webhook callback URL."),
        disable_emails: z.boolean().optional().describe("Suppress SignRequest status emails (combine with per-signer embed_url_user_id for a fully silent request)."),
        dry_run: z.boolean().optional().describe("Preview only: report who WOULD be emailed without creating or sending anything."),
      },
      annotations: {
        title: "Send signature request (quick create)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (a) => {
      try {
        validateDocSource(a);
        const from_email = resolveFromEmail(a.from_email);
        if (a.dry_run) {
          const wouldEmail = a.signers.filter((s) => !s.embed_url_user_id).map((s) => s.email);
          return ok({
            dry_run: true,
            action: "quick_create",
            from_email,
            name: a.name ?? null,
            signer_count: a.signers.length,
            would_email: wouldEmail,
            embedded_no_email: a.signers.filter((s) => s.embed_url_user_id).map((s) => s.email),
            note: wouldEmail.length
              ? `Would email ${wouldEmail.length} signer(s). Nothing was created or sent.`
              : "No emails would be sent (all signers embedded). Nothing was created or sent.",
          });
        }
        return await run(() =>
          client.quickCreate({
            file_from_url: a.file_from_url,
            file_from_content: a.file_from_content,
            file_from_content_name: a.file_from_content_name,
            template: a.template,
            signers: a.signers,
            from_email,
            from_email_name: a.from_email_name,
            subject: a.subject,
            message: a.message,
            send_reminders: a.send_reminders,
            who: a.who,
            external_id: a.external_id,
            name: a.name,
            events_callback_url: a.events_callback_url,
            disable_emails: a.disable_emails,
          }),
        );
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  writeTool(
    "signrequest_create_document",
    {
      description:
        "Create a document WITHOUT sending it yet. Returns a document with a 'url' and 'uuid' you can pass to signrequest_send later (useful for chaining or inspecting before sending). Emails no one.",
      inputSchema: {
        ...docSourceShape,
        external_id: z.string().optional(),
        name: z.string().optional(),
        events_callback_url: z.string().url().optional(),
      },
      annotations: {
        title: "Create document (no send)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (a) => {
      try {
        validateDocSource(a);
        return await run(() =>
          client.createDocument({
            file_from_url: a.file_from_url,
            file_from_content: a.file_from_content,
            file_from_content_name: a.file_from_content_name,
            template: a.template,
            external_id: a.external_id,
            name: a.name,
            events_callback_url: a.events_callback_url,
          }),
        );
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  writeTool(
    "signrequest_send",
    {
      description:
        "Send a signature request for an EXISTING document (created via signrequest_create_document). Pass the document's resource URL and the signers. Sends real emails.",
      inputSchema: {
        document: z.string().url().describe("Resource URL of an existing document."),
        signers: z.array(signerSchema).min(1),
        from_email: z.string().email().optional(),
        from_email_name: z.string().optional(),
        subject: z.string().optional(),
        message: z.string().optional(),
        send_reminders: z.boolean().optional(),
        who: z.enum(["m", "o", "mo"]).optional(),
        disable_emails: z
          .boolean()
          .optional()
          .describe(
            "Suppress SignRequest status emails. Combine with per-signer embed_url_user_id (which suppresses the signing email) for a fully silent, no-email request.",
          ),
        dry_run: z.boolean().optional().describe("Preview only: report who WOULD be emailed without sending anything."),
      },
      annotations: {
        title: "Send signature request",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (a) => {
      try {
        const from_email = resolveFromEmail(a.from_email);
        if (a.dry_run) {
          const wouldEmail = a.signers.filter((s) => !s.embed_url_user_id).map((s) => s.email);
          return ok({
            dry_run: true,
            action: "send",
            document: a.document,
            signer_count: a.signers.length,
            would_email_signing_request: wouldEmail,
            status_emails_disabled: !!a.disable_emails,
            note: "Nothing was sent.",
          });
        }
        return await run(() =>
          client.send({
            document: a.document,
            signers: a.signers,
            from_email,
            from_email_name: a.from_email_name,
            subject: a.subject,
            message: a.message,
            send_reminders: a.send_reminders,
            who: a.who,
            disable_emails: a.disable_emails,
          }),
        );
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "signrequest_get",
    {
      description:
        "Get a single signature request by UUID — status, signers, who signed/declined/viewed.",
      inputSchema: { uuid: z.string().describe("SignRequest UUID.") },
      annotations: { title: "Get signature request", ...READ_ONLY },
    },
    async ({ uuid }) => run(() => client.getSignRequest(uuid)),
  );

  server.registerTool(
    "signrequest_list",
    {
      description: "List signature requests (most recent first). Supports paging.",
      inputSchema: {
        page: z.number().int().positive().optional(),
        external_id: z.string().optional().describe("Filter by your document external_id, if supported."),
      },
      annotations: { title: "List signature requests", ...READ_ONLY },
    },
    async ({ page, external_id }) => run(() => client.listSignRequests({ page, external_id })),
  );

  writeTool(
    "signrequest_cancel",
    {
      description:
        "Cancel a signature request by UUID. Signers who haven't signed yet lose access. Only works if not already fully signed/declined.",
      inputSchema: { uuid: z.string() },
      annotations: {
        title: "Cancel signature request",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ uuid }) => run(() => client.cancel(uuid)),
  );

  writeTool(
    "signrequest_resend",
    {
      description:
        "Resend the signature request email as a reminder to all signers who received it but haven't signed yet. Sends real emails each call.",
      inputSchema: {
        uuid: z.string(),
        dry_run: z.boolean().optional().describe("Preview only: confirm the resend target without emailing anyone."),
      },
      annotations: {
        title: "Resend reminder emails",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ uuid, dry_run }) =>
      dry_run
        ? ok({
            dry_run: true,
            action: "resend",
            uuid,
            note: "Would resend the signing-request email to all signers who haven't signed yet. Nothing was sent.",
          })
        : run(() => client.resend(uuid)),
  );

  server.registerTool(
    "signrequest_get_document",
    {
      description:
        "Get a document by UUID — conversion status, the signed PDF URL (once signed), security hash and signing log. Pass compact=true for a trimmed summary (status, signers, signed-PDF URL) that uses far less context.",
      inputSchema: {
        uuid: z.string(),
        compact: z.boolean().optional().describe("Return a trimmed summary instead of the full document."),
      },
      annotations: { title: "Get document", ...READ_ONLY },
    },
    async ({ uuid, compact }) =>
      run(async () => {
        const doc = (await client.getDocument(uuid)) as AnyRec;
        return compact ? compactDoc(doc) : doc;
      }),
  );

  server.registerTool(
    "signrequest_list_documents",
    {
      description: "List documents (most recent first). Filter by external_id or page through results.",
      inputSchema: {
        page: z.number().int().positive().optional(),
        external_id: z.string().optional(),
      },
      annotations: { title: "List documents", ...READ_ONLY },
    },
    async ({ page, external_id }) => run(() => client.listDocuments({ page, external_id })),
  );

  server.registerTool(
    "signrequest_list_templates",
    {
      description:
        "List available templates for the team/account. Use a template's resource URL as 'template' in quick_create or create_document.",
      inputSchema: { page: z.number().int().positive().optional() },
      annotations: { title: "List templates", ...READ_ONLY },
    },
    async ({ page }) => run(() => client.listTemplates({ page })),
  );

  server.registerTool(
    "signrequest_get_template",
    {
      description:
        "Get a single template by UUID — its fields and resource URL. Use that URL as 'template' in quick_create/create_document.",
      inputSchema: { uuid: z.string().describe("Template UUID.") },
      annotations: { title: "Get template", ...READ_ONLY },
    },
    async ({ uuid }) => run(() => client.getTemplate(uuid)),
  );

  server.registerTool(
    "signrequest_list_events",
    {
      description:
        "List events (the webhook delivery log), most recent first — e.g. signed/declined/viewed events. Useful for auditing what fired. Supports paging.",
      inputSchema: { page: z.number().int().positive().optional() },
      annotations: { title: "List events", ...READ_ONLY },
    },
    async ({ page }) => run(() => client.listEvents({ page })),
  );

  server.registerTool(
    "signrequest_get_event",
    {
      description: "Get a single event by UUID from the webhook delivery log.",
      inputSchema: { uuid: z.string().describe("Event UUID.") },
      annotations: { title: "Get event", ...READ_ONLY },
    },
    async ({ uuid }) => run(() => client.getEvent(uuid)),
  );

  server.registerTool(
    "signrequest_list_teams",
    {
      description: "List the teams the token can access (most recent first). Supports paging.",
      inputSchema: { page: z.number().int().positive().optional() },
      annotations: { title: "List teams", ...READ_ONLY },
    },
    async ({ page }) => run(() => client.listTeams({ page })),
  );

  server.registerTool(
    "signrequest_list_team_members",
    {
      description: "List members of the team(s) the token can access. Supports paging.",
      inputSchema: { page: z.number().int().positive().optional() },
      annotations: { title: "List team members", ...READ_ONLY },
    },
    async ({ page }) => run(() => client.listTeamMembers({ page })),
  );

  writeTool(
    "signrequest_delete_document",
    {
      description:
        "Permanently DELETE a document by UUID — also removes its signature requests and the stored file. Irreversible; use with care.",
      inputSchema: { uuid: z.string().describe("Document UUID to delete.") },
      annotations: {
        title: "Delete document",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ uuid }) => run(() => client.deleteDocument(uuid)),
  );

  writeTool(
    "signrequest_add_document_attachment",
    {
      description:
        "Attach an extra file to an existing document (an attached file shown alongside it — NOT a signature field). Provide the document resource URL and a file source: file_from_url (preferred) or base64 file_from_content + name.",
      inputSchema: {
        document: z.string().url().describe("Resource URL of the document to attach to."),
        file_from_url: z.string().url().optional().describe("Public URL SignRequest downloads. Preferred."),
        file_from_content: z.string().optional().describe("Base64-encoded file contents (small files only)."),
        file_from_content_name: z
          .string()
          .optional()
          .describe("Filename WITH extension, e.g. 'addendum.pdf'. Required if file_from_content is set."),
      },
      annotations: {
        title: "Add document attachment",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (a) => {
      try {
        if (!a.file_from_url && !a.file_from_content) {
          throw new Error("Provide file_from_url or file_from_content (+ file_from_content_name).");
        }
        if (a.file_from_content && !a.file_from_content_name) {
          throw new Error("file_from_content_name is required when file_from_content is provided.");
        }
        return await run(() => client.addDocumentAttachment(a));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "signrequest_list_document_attachments",
    {
      description: "List document attachments (most recent first). Supports paging.",
      inputSchema: { page: z.number().int().positive().optional() },
      annotations: { title: "List document attachments", ...READ_ONLY },
    },
    async ({ page }) => run(() => client.listDocumentAttachments({ page })),
  );

  server.registerTool(
    "signrequest_get_document_attachment",
    {
      description: "Get a single document attachment by UUID.",
      inputSchema: { uuid: z.string().describe("Attachment UUID.") },
      annotations: { title: "Get document attachment", ...READ_ONLY },
    },
    async ({ uuid }) => run(() => client.getDocumentAttachment(uuid)),
  );

  server.registerTool(
    "signrequest_search_documents",
    {
      description:
        "Search documents (fast, autocomplete-style) — the efficient way to find a specific person's documents without paging. Filter by signer_emails (documents a given email needs to sign/approve; comma-separate for multiple), free-text q, name, status, or who. Set signer_data=true to include per-signer details in the results.",
      inputSchema: {
        q: z.string().optional().describe("Free-text search query."),
        name: z.string().optional().describe("Filter by document name."),
        signer_emails: z
          .string()
          .optional()
          .describe("Email(s) that need to sign/approve; comma-separate for multiple."),
        status: z.string().optional().describe("Filter by status."),
        who: z.string().optional(),
        signer_data: z.boolean().optional().describe("Include per-signer details in results."),
        page: z.number().int().positive().optional(),
      },
      annotations: { title: "Search documents", ...READ_ONLY },
    },
    async (a) => run(() => client.searchDocuments(a)),
  );

  // ---- High-level convenience + safety tools ----

  server.registerTool(
    "signrequest_whoami",
    {
      description:
        "Health check / identity: verifies the configured SignRequest API token works and returns the team(s) and member(s) it can access, plus the default sender. Call this first if other tools return 401/403 — it confirms the token is valid before you debug anything else.",
      inputSchema: {},
      annotations: { title: "Who am I (token health)", ...READ_ONLY },
    },
    async () =>
      run(async () => {
        const [teams, members] = await Promise.all([
          client.listTeams() as Promise<AnyRec>,
          client.listTeamMembers() as Promise<AnyRec>,
        ]);
        return { ok: true, default_from_email: opts.defaultFromEmail ?? null, teams, members };
      }),
  );

  server.registerTool(
    "signrequest_get_signer_summary",
    {
      description:
        "One-shot status for a person: searches that signer's documents and returns the SIGNED one's details — overall status, signed-PDF URL, embedded signing link (embed_url), and the filled field values as a flat { external_id: value } map (e.g. an amount, reference number, or date). A person can have multiple documents; this always reads the signed one (where entered values live), which a naive 'most recent document' lookup would miss. Scope to a document type with name_contains. Replaces the search -> get_document -> parse-inputs dance.",
      inputSchema: {
        email: z.string().email().describe("The signer's email (matched case-insensitively)."),
        name_contains: z
          .string()
          .optional()
          .describe("Only consider documents whose name contains this substring (e.g. a doc-type keyword)."),
      },
      annotations: { title: "Get signer summary", ...READ_ONLY },
    },
    async ({ email, name_contains }) => run(() => buildSignerSummary(client, email, name_contains)),
  );

  server.registerTool(
    "signrequest_get_document_fields",
    {
      description:
        "Get a document's filled field values as a flat { external_id: value } map (text/date/checkbox flattened) plus a compact signer list — the easy way to read what a signer entered (e.g. an amount or reference) without walking the raw signers[].inputs[] structure. Optionally target a specific signer by email.",
      inputSchema: {
        uuid: z.string().describe("Document UUID."),
        signer_email: z
          .string()
          .email()
          .optional()
          .describe("Which signer's fields to return; defaults to the signed/primary signer."),
      },
      annotations: { title: "Get document fields", ...READ_ONLY },
    },
    async ({ uuid, signer_email }) =>
      run(async () => {
        const doc = (await client.getDocument(uuid)) as AnyRec;
        const signer = pickSigner(doc, signer_email);
        return { ...compactDoc(doc), signer_email: signer?.email ?? null, fields: extractFields(signer) };
      }),
  );

  server.registerTool(
    "signrequest_get_signed_pdf",
    {
      description:
        "Return the freshly-minted signed-PDF download URL and signing-log URL for a document. These are time-limited links, so call this when you need a working URL rather than reusing an old one. Empty until the document is signed.",
      inputSchema: { uuid: z.string().describe("Document UUID.") },
      annotations: { title: "Get signed PDF link", ...READ_ONLY },
    },
    async ({ uuid }) =>
      run(async () => {
        const doc = (await client.getDocument(uuid)) as AnyRec;
        return {
          uuid: doc.uuid,
          name: doc.name,
          status: readableStatus(doc.status),
          signed_pdf_url: doc.pdf ?? null,
          signing_log_url: doc.signing_log ?? null,
        };
      }),
  );

  server.registerTool(
    "signrequest_get_signing_link",
    {
      description:
        "Return the embedded signing link (embed_url) for a signer — the direct URL they open to sign. Only present if the signer was set up for embedded signing (embed_url_user_id at send time). Defaults to the first unsigned signer with a link.",
      inputSchema: {
        uuid: z.string().describe("Document UUID."),
        signer_email: z.string().email().optional().describe("Which signer's link to return."),
      },
      annotations: { title: "Get signing link", ...READ_ONLY },
    },
    async ({ uuid, signer_email }) =>
      run(async () => {
        const doc = (await client.getDocument(uuid)) as AnyRec;
        const sr = (doc.signrequest as AnyRec) ?? {};
        const signers: AnyRec[] = sr.signers ?? [];
        const lower = signer_email?.toLowerCase();
        const signer =
          (lower
            ? signers.find((s) => String(s.email ?? "").toLowerCase() === lower)
            : signers.find((s) => !s.signed && s.embed_url)) ??
          signers.find((s) => s.embed_url) ??
          null;
        return {
          uuid: doc.uuid,
          signer_email: signer?.email ?? null,
          embed_url: signer?.embed_url ?? null,
          signed: !!signer?.signed,
          note: signer?.embed_url ? null : "No embed_url — this signer wasn't set up for embedded signing.",
        };
      }),
  );

  server.registerTool(
    "signrequest_get_documents",
    {
      description:
        "Batch-fetch multiple documents by UUID and return COMPACT summaries (status, signers, signed-PDF URL) — far fewer round-trips and far less context than calling get_document one at a time. Up to 50 UUIDs.",
      inputSchema: { uuids: z.array(z.string()).min(1).max(50).describe("Document UUIDs.") },
      annotations: { title: "Get documents (batch, compact)", ...READ_ONLY },
    },
    async ({ uuids }) =>
      run(async () => {
        const out: AnyRec[] = [];
        const CONC = 5; // modest concurrency so we don't hammer the API
        for (let i = 0; i < uuids.length; i += CONC) {
          const chunk = uuids.slice(i, i + CONC);
          const docs = await Promise.all(
            chunk.map(async (u) => {
              try {
                return compactDoc((await client.getDocument(u)) as AnyRec);
              } catch (e) {
                return { uuid: u, error: e instanceof SignRequestError ? `API ${e.status}` : String(e) };
              }
            }),
          );
          out.push(...docs);
        }
        return { count: out.length, documents: out };
      }),
  );

  writeTool(
    "signrequest_create_embedded_signing_links",
    {
      description:
        "SAFE way to get signing links WITHOUT emailing anyone. Creates+sends a signature request with disable_emails=true and embedded signing forced on for every signer, then returns each signer's embed_url. Provide a document source (file_from_url / base64 file_from_content+name / template) to create+send in one go, OR an existing document URL. Guarantees no signer receives an email — prefer this over quick_create/send when you only want links.",
      inputSchema: {
        ...docSourceShape,
        document: z
          .string()
          .url()
          .optional()
          .describe("Existing document resource URL (alternative to a file/template source)."),
        signers: z
          .array(
            z.object({
              email: z.string().email(),
              first_name: z.string().optional(),
              last_name: z.string().optional(),
              order: z.number().int().optional(),
            }),
          )
          .min(1)
          .describe("Signers — each is automatically set up for embedded signing (no email)."),
        from_email: z.string().email().optional(),
        name: z.string().optional(),
        external_id: z.string().optional(),
      },
      annotations: {
        title: "Create embedded signing links (no emails)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (a) => {
      try {
        const from_email = resolveFromEmail(a.from_email);
        const signers = a.signers.map((s) => ({ ...s, embed_url_user_id: s.email }));
        let resp: AnyRec;
        if (a.document) {
          resp = (await client.send({ document: a.document, signers, from_email, disable_emails: true })) as AnyRec;
        } else {
          validateDocSource(a);
          resp = (await client.quickCreate({
            file_from_url: a.file_from_url,
            file_from_content: a.file_from_content,
            file_from_content_name: a.file_from_content_name,
            template: a.template,
            signers,
            from_email,
            name: a.name,
            external_id: a.external_id,
            disable_emails: true,
          })) as AnyRec;
        }
        const sr = (resp.signrequest as AnyRec) ?? resp;
        const links = ((sr.signers as AnyRec[]) ?? [])
          .filter((s) => s.embed_url)
          .map((s) => ({ email: s.email, embed_url: s.embed_url }));
        return ok({
          emails_sent: false,
          document_uuid: resp.uuid ?? sr.document_uuid ?? null,
          signrequest_uuid: sr.uuid ?? null,
          links,
        });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "signrequest_campaign_status",
    {
      description:
        "Roster-wide rollup: runs the signer-summary lookup for many people with bounded concurrency and returns aggregate counts (signed / pending / with-field-data) plus a per-person summary (status, signed-PDF, embed_url, filled fields). One call to drive a tracking dashboard instead of N search+get round-trips. Up to 200 emails.",
      inputSchema: {
        emails: z.array(z.string().email()).min(1).max(200).describe("Signer emails to roll up."),
        name_contains: z.string().optional().describe("Scope to documents whose name contains this substring."),
        concurrency: z.number().int().min(1).max(8).optional().describe("Parallel lookups (default 5)."),
      },
      annotations: { title: "Campaign status (roster rollup)", ...READ_ONLY },
    },
    async ({ emails, name_contains, concurrency }) =>
      run(async () => {
        const uniq = [...new Set(emails.map((e) => e.toLowerCase()))];
        const people = await mapLimit(uniq, concurrency ?? 5, async (email) => {
          try {
            return await buildSignerSummary(client, email, name_contains);
          } catch (e) {
            return { email, status: "error", error: e instanceof SignRequestError ? `API ${e.status}` : String(e), fields: {} } as AnyRec;
          }
        });
        const by_status: Record<string, number> = {};
        let signed = 0, with_fields = 0, errors = 0;
        for (const p of people) {
          const st = String(p.status ?? "unknown");
          by_status[st] = (by_status[st] ?? 0) + 1;
          if (p.signed) signed++;
          if (p.fields && Object.keys(p.fields).length) with_fields++;
          if (st === "error") errors++;
        }
        return { total: people.length, signed, pending: people.length - signed - errors, with_fields, errors, by_status, people };
      }),
  );

  server.registerTool(
    "signrequest_list_all_documents",
    {
      description:
        "Auto-paginated list of ALL documents (follows pagination so you never page by hand), returned as COMPACT summaries. Cap defaults to 500 (max 2000). Use for inventory/exports without dozens of calls.",
      inputSchema: {
        cap: z.number().int().min(1).max(2000).optional().describe("Max documents to return (default 500)."),
        external_id: z.string().optional().describe("Filter by your external_id."),
      },
      annotations: { title: "List all documents (auto-paginated, compact)", ...READ_ONLY },
    },
    async ({ cap, external_id }) =>
      run(async () => {
        const docs = (await client.listAllDocuments({ cap: cap ?? 500, external_id })) as AnyRec[];
        return { count: docs.length, documents: docs.map((d) => compactDoc(d)) };
      }),
  );

  server.registerTool(
    "signrequest_list_template_fields",
    {
      description:
        "Discover a template's fillable field identifiers (external_id / prefill tags) so you know what to map when prefilling or reading values. Best-effort extraction from the template object.",
      inputSchema: { uuid: z.string().describe("Template UUID.") },
      annotations: { title: "List template fields", ...READ_ONLY },
    },
    async ({ uuid }) =>
      run(async () => {
        const t = (await client.getTemplate(uuid)) as AnyRec;
        const ids = new Set<string>();
        const collect = (arr: AnyRec[] | undefined) => {
          for (const x of arr ?? []) if (x?.external_id) ids.add(String(x.external_id));
        };
        collect(t.prefill_tags as AnyRec[]);
        for (const s of ((t.signrequest as AnyRec)?.signers as AnyRec[]) ?? []) collect(s.inputs as AnyRec[]);
        for (const s of (t.signers as AnyRec[]) ?? []) collect(s.inputs as AnyRec[]);
        return { uuid: t.uuid, name: t.name, url: t.url, field_ids: [...ids], prefill_tags: t.prefill_tags ?? null };
      }),
  );

  server.registerTool(
    "signrequest_wait_until_signed",
    {
      description:
        "Poll a document until it reaches a terminal state (signed / declined / cancelled), up to a bounded timeout — convenience for 'just sent, tell me when it's done'. For long waits use webhooks/events instead. Returns the final status and signed-PDF URL if signed.",
      inputSchema: {
        uuid: z.string().describe("Document UUID."),
        timeout_seconds: z.number().int().min(1).max(25).optional().describe("Max wait (default 15, hard cap 25)."),
        interval_seconds: z.number().int().min(1).max(10).optional().describe("Poll interval (default 3)."),
      },
      annotations: { title: "Wait until signed (bounded poll)", readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ uuid, timeout_seconds, interval_seconds }) =>
      run(async () => {
        const deadline = Date.now() + Math.min(timeout_seconds ?? 15, 25) * 1000;
        const interval = (interval_seconds ?? 3) * 1000;
        for (;;) {
          const doc = (await client.getDocument(uuid)) as AnyRec;
          const code = String(doc.status ?? "");
          if (["si", "sd", "do", "de", "ca"].includes(code)) {
            return { uuid, done: true, status: readableStatus(code), signed_pdf_url: doc.pdf ?? null };
          }
          if (Date.now() + interval >= deadline) {
            return { uuid, done: false, status: readableStatus(code), note: "Timed out; still pending. Poll again or use events." };
          }
          await new Promise((r) => setTimeout(r, interval));
        }
      }),
  );

  writeTool(
    "signrequest_bulk_send",
    {
      description:
        "Send the SAME template (or file) to many recipients as a campaign — one signature request per recipient (each gets their own copy). Bounded concurrency, per-recipient results, dry_run preview, and an `embedded` switch (no emails; returns each embed_url). For onboarding, NDAs, waivers, or any bulk agreement. Up to 200 recipients.",
      inputSchema: {
        template: z.string().url().optional().describe("Template resource URL (each recipient gets a copy)."),
        file_from_url: z.string().url().optional().describe("Or a public file URL SignRequest downloads."),
        recipients: z
          .array(z.object({ email: z.string().email(), first_name: z.string().optional(), last_name: z.string().optional() }))
          .min(1)
          .max(200)
          .describe("Campaign recipients."),
        from_email: z.string().email().optional(),
        name: z.string().optional().describe("Document name applied to each."),
        subject: z.string().optional(),
        message: z.string().optional(),
        embedded: z.boolean().optional().describe("Embedded signing: NO emails sent; returns each embed_url."),
        disable_emails: z.boolean().optional().describe("Suppress status emails (implied by embedded)."),
        concurrency: z.number().int().min(1).max(6).optional().describe("Parallel sends (default 3)."),
        dry_run: z.boolean().optional().describe("Preview recipients/mode without sending."),
      },
      annotations: { title: "Bulk send campaign", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) => {
      try {
        if (!a.template && !a.file_from_url) throw new Error("Provide a template or file_from_url.");
        const from_email = resolveFromEmail(a.from_email);
        const embedded = !!a.embedded;
        if (a.dry_run) {
          return ok({
            dry_run: true,
            action: "bulk_send",
            recipients: a.recipients.length,
            mode: embedded ? "embedded (no emails)" : "email",
            from_email,
            name: a.name ?? null,
            note: embedded
              ? "Would create one embedded request per recipient; no emails sent."
              : `Would email ${a.recipients.length} recipient(s). Nothing sent.`,
          });
        }
        audit("bulk_send", { recipients: a.recipients.length, embedded });
        const results = await mapLimit(a.recipients, a.concurrency ?? 3, async (r) => {
          try {
            const signer: Signer = { email: r.email, first_name: r.first_name, last_name: r.last_name };
            if (embedded) signer.embed_url_user_id = r.email;
            const resp = (await client.quickCreate({
              template: a.template,
              file_from_url: a.file_from_url,
              signers: [signer],
              from_email,
              name: a.name,
              subject: a.subject,
              message: a.message,
              disable_emails: embedded || a.disable_emails,
            })) as AnyRec;
            const sr = (resp.signrequest as AnyRec) ?? resp;
            const s0 = ((sr.signers as AnyRec[]) ?? []).find(
              (s) => String(s.email ?? "").toLowerCase() === r.email.toLowerCase(),
            );
            return { email: r.email, ok: true, document_uuid: resp.uuid ?? null, signrequest_uuid: sr.uuid ?? null, embed_url: s0?.embed_url ?? null };
          } catch (e) {
            return { email: r.email, ok: false, error: e instanceof SignRequestError ? `API ${e.status}: ${e.body.slice(0, 120)}` : String(e) };
          }
        });
        const sent = results.filter((r) => r.ok).length;
        return ok({ emails_sent: !embedded, sent, failed: results.length - sent, results });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
