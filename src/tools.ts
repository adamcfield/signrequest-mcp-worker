/**
 * Shared SignRequest tool registration.
 *
 * Used by BOTH the stdio server (src/index.ts) and the Cloudflare Worker, so the
 * tool surface, schemas, and safety annotations stay identical across transports.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SignRequestClient, SignRequestError } from "./signrequest.js";

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

  server.registerTool(
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
          }),
        );
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    "signrequest_resend",
    {
      description:
        "Resend the signature request email as a reminder to all signers who received it but haven't signed yet. Sends real emails each call.",
      inputSchema: { uuid: z.string() },
      annotations: {
        title: "Resend reminder emails",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ uuid }) => run(() => client.resend(uuid)),
  );

  server.registerTool(
    "signrequest_get_document",
    {
      description:
        "Get a document by UUID — conversion status, the signed PDF URL (once signed), security hash and signing log.",
      inputSchema: { uuid: z.string() },
      annotations: { title: "Get document", ...READ_ONLY },
    },
    async ({ uuid }) => run(() => client.getDocument(uuid)),
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
}
