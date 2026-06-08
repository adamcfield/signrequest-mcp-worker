import { describe, it, expect, vi, afterEach } from "vitest";
import { SignRequestClient, mapLimit } from "../src/signrequest.js";

const mkClient = () => new SignRequestClient({ token: "t", backoffBaseMs: 1, maxRetries: 2 });

function mockFetch(responses: Array<{ status: number; body: string; headers?: Record<string, string> }>) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(r.body, { status: r.status, headers: r.headers });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SignRequestClient.request", () => {
  it("returns parsed JSON on 200", async () => {
    vi.stubGlobal("fetch", mockFetch([{ status: 200, body: JSON.stringify({ uuid: "x" }) }]));
    expect(await mkClient().getDocument("x")).toEqual({ uuid: "x" });
  });

  it("throws SignRequestError carrying status + body on 4xx", async () => {
    vi.stubGlobal("fetch", mockFetch([{ status: 400, body: '{"error":"bad"}' }]));
    await expect(mkClient().getDocument("x")).rejects.toMatchObject({
      name: "SignRequestError",
      status: 400,
      body: '{"error":"bad"}',
    });
  });

  it("retries an idempotent GET on 429, then succeeds", async () => {
    const f = mockFetch([
      { status: 429, body: "", headers: { "retry-after": "0" } },
      { status: 200, body: JSON.stringify({ ok: true }) },
    ]);
    vi.stubGlobal("fetch", f);
    expect(await mkClient().getDocument("x")).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("never retries a POST (no double-send), even on 500", async () => {
    const f = mockFetch([{ status: 500, body: "boom" }]);
    vi.stubGlobal("fetch", f);
    await expect(
      mkClient().send({ document: "u", signers: [{ email: "a@x.com" }] }),
    ).rejects.toMatchObject({ status: 500 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("auto-paginates listAllDocuments until next is null", async () => {
    const f = mockFetch([
      { status: 200, body: JSON.stringify({ next: "p2", results: [{ uuid: "a" }, { uuid: "b" }] }) },
      { status: 200, body: JSON.stringify({ next: null, results: [{ uuid: "c" }] }) },
    ]);
    vi.stubGlobal("fetch", f);
    const all = (await mkClient().listAllDocuments({ cap: 100 })) as Array<{ uuid: string }>;
    expect(all.map((d) => d.uuid)).toEqual(["a", "b", "c"]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("honors the cap when paginating", async () => {
    const f = mockFetch([{ status: 200, body: JSON.stringify({ next: "more", results: [{ uuid: "a" }, { uuid: "b" }] }) }]);
    vi.stubGlobal("fetch", f);
    const all = (await mkClient().listAllDocuments({ cap: 1 })) as unknown[];
    expect(all).toHaveLength(1);
  });
});

describe("mapLimit", () => {
  it("preserves input order and caps concurrency", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    const out = await mapLimit(items, 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return n * 2;
    });
    expect(out).toEqual(items.map((n) => n * 2));
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });

  it("rejects if any task throws", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("SignRequestClient.searchAllDocuments", () => {
  it("follows pagination across pages", async () => {
    const f = mockFetch([
      { status: 200, body: JSON.stringify({ next: "p2", results: [{ uuid: "a" }] }) },
      { status: 200, body: JSON.stringify({ next: null, results: [{ uuid: "b" }] }) },
    ]);
    vi.stubGlobal("fetch", f);
    const all = (await mkClient().searchAllDocuments({ q: "x" })) as Array<{ uuid: string }>;
    expect(all.map((d) => d.uuid)).toEqual(["a", "b"]);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
