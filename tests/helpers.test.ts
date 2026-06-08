import { describe, it, expect } from "vitest";
import {
  extractFields,
  pickSigner,
  compactDoc,
  readableStatus,
  isSignedCode,
  buildSignerSummary,
} from "../src/tools.js";

describe("status helpers", () => {
  it("maps known codes and passes through unknown", () => {
    expect(readableStatus("si")).toBe("signed");
    expect(readableStatus("se")).toBe("sent");
    expect(readableStatus("zz")).toBe("zz");
    expect(readableStatus(undefined)).toBe("unknown");
  });
  it("isSignedCode covers signed variants only", () => {
    expect(isSignedCode("si")).toBe(true);
    expect(isSignedCode("sd")).toBe(true);
    expect(isSignedCode("do")).toBe(true);
    expect(isSignedCode("se")).toBe(false);
    expect(isSignedCode(undefined)).toBe(false);
  });
});

describe("extractFields", () => {
  it("flattens text/date/checkbox and skips empties + id-less inputs", () => {
    const signer = {
      inputs: [
        { external_id: "Reference", text: "REF-001" },
        { external_id: "SignDate", date_value: "2026-06-01" },
        { external_id: "Agree", checkbox_value: true },
        { external_id: "Empty", text: "" },
        { text: "no id" },
      ],
    };
    expect(extractFields(signer)).toEqual({ Reference: "REF-001", SignDate: "2026-06-01", Agree: "true" });
  });
  it("handles a null signer", () => {
    expect(extractFields(null)).toEqual({});
  });
});

describe("pickSigner", () => {
  const doc = {
    signrequest: {
      from_email: "owner@x.com",
      signers: [
        { email: "owner@x.com", signed: true },
        { email: "alice@x.com", signed: false },
        { email: "bob@x.com", signed: true },
      ],
    },
  };
  it("matches by email (case-insensitive)", () => {
    expect(pickSigner(doc, "ALICE@x.com")?.email).toBe("alice@x.com");
  });
  it("prefers a signed non-owner when no email given", () => {
    expect(pickSigner(doc)?.email).toBe("bob@x.com");
  });
  it("returns null when there are no signers", () => {
    expect(pickSigner({})).toBeNull();
  });
});

describe("compactDoc", () => {
  it("trims to the fields that matter and drops the rest", () => {
    const doc = {
      uuid: "u1", name: "Doc", status: "si", pdf: "http://pdf", signing_log: "http://log",
      external_id: "e1", extra: "dropped",
      signrequest: { signers: [{ email: "a@x.com", signed: true, declined: false, viewed: true, embed_url: "http://e" }] },
    };
    const c = compactDoc(doc);
    expect(c).toMatchObject({ uuid: "u1", name: "Doc", status: "signed", status_code: "si", signed_pdf_url: "http://pdf" });
    expect(c.signers[0]).toEqual({ email: "a@x.com", signed: true, declined: false, viewed: true, embed_url: "http://e" });
    expect((c as Record<string, unknown>).extra).toBeUndefined();
  });
});

describe("buildSignerSummary", () => {
  it("reads the SIGNED doc (not the most recent) and extracts fields", async () => {
    const fakeClient = {
      searchDocuments: async () => ({
        results: [
          { uuid: "d-sent", name: "Service Agreement A", status: "se" },
          { uuid: "d-signed", name: "Service Agreement A", status: "si" },
        ],
      }),
      getDocument: async (uuid: string) => ({
        uuid,
        status: "si",
        pdf: "http://pdf",
        signrequest: {
          from_email: "owner@x.com",
          signers: [
            { email: "owner@x.com", signed: true },
            { email: "alice@x.com", signed: true, embed_url: "http://e", inputs: [{ external_id: "Reference", text: "REF-001" }] },
          ],
        },
      }),
    } as never;
    const s = await buildSignerSummary(fakeClient, "ALICE@x.com", "Agreement");
    expect(s.status).toBe("signed");
    expect(s.signed).toBe(true);
    expect(s.signed_doc_uuid).toBe("d-signed");
    expect(s.signed_pdf_url).toBe("http://pdf");
    expect(s.embed_url).toBe("http://e");
    expect(s.fields).toEqual({ Reference: "REF-001" });
    expect(s.matched_documents).toBe(2);
  });
  it("returns not_found when no documents match", async () => {
    const fakeClient = {
      searchDocuments: async () => ({ results: [] }),
      getDocument: async () => ({}),
    } as never;
    const s = await buildSignerSummary(fakeClient, "nobody@x.com", "Agreement");
    expect(s.status).toBe("not_found");
    expect(s.signed_doc_uuid).toBeNull();
    expect(s.fields).toEqual({});
  });
});

describe("edge cases", () => {
  it("extractFields includes a false checkbox", () => {
    expect(extractFields({ inputs: [{ external_id: "Agree", checkbox_value: false }] })).toEqual({ Agree: "false" });
  });
  it("pickSigner falls back to the owner when they are the only signer", () => {
    const doc = { signrequest: { from_email: "o@x.com", signers: [{ email: "o@x.com", signed: true }] } };
    expect(pickSigner(doc)?.email).toBe("o@x.com");
  });
  it("compactDoc tolerates a missing signrequest block", () => {
    const c = compactDoc({ uuid: "u", name: "N", status: "se" });
    expect(c.signers).toEqual([]);
    expect(c.status).toBe("sent");
    expect(c.signed_pdf_url).toBeNull();
  });
  it("readableStatus maps an empty code to unknown", () => {
    expect(readableStatus("")).toBe("unknown");
  });
});
