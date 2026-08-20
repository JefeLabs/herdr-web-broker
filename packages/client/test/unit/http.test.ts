import { describe, expect, test } from "vitest";
import { BrokerApiError, BrokerNetworkError } from "../../src/errors.js";
import { request } from "../../src/http.js";

function fake(status: number, body: string, ct = "application/json") {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status, headers: { "content-type": ct } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("request", () => {
  test("bearer + query + body land on the wire", async () => {
    const { calls, fetchFn } = fake(200, '{"ok":true}');
    await request({ origin: "http://b", token: "tok", fetchFn }, "POST", "/x", {
      query: { base: "origin/main" },
      body: { a: 1 },
    });
    expect(calls[0].url).toBe("http://b/x?base=origin%2Fmain");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer tok");
    expect(h["content-type"]).toBe("application/json");
    expect(calls[0].init.body).toBe('{"a":1}');
  });

  test("admin calls use x-admin-token, never the bearer", async () => {
    const { calls, fetchFn } = fake(200, "{}");
    await request({ origin: "", token: "t", adminToken: "adm", fetchFn }, "GET", "/admin/status", { admin: true });
    const h = calls[0].init.headers as Record<string, string>;
    expect(h["x-admin-token"]).toBe("adm");
    expect(h.authorization).toBeUndefined();
  });

  test("error envelope maps 1:1 onto BrokerApiError", async () => {
    const { fetchFn } = fake(404, '{"code":"unknown_model","message":"no","known":["gpt-5"]}');
    const err = (await request({ origin: "", fetchFn }, "GET", "/x").catch((e) => e)) as BrokerApiError;
    expect(err).toBeInstanceOf(BrokerApiError);
    expect(err.code).toBe("unknown_model");
    expect(err.status).toBe(404);
    expect(err.details.known).toEqual(["gpt-5"]);
  });

  test("non-JSON error bodies still throw a typed error", async () => {
    const { fetchFn } = fake(502, "Bad Gateway", "text/plain");
    const err = (await request({ origin: "", fetchFn }, "GET", "/x").catch((e) => e)) as BrokerApiError;
    expect(err.code).toBe("http_error");
    expect(err.message).toContain("Bad Gateway");
  });

  test("network failure throws BrokerNetworkError", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(request({ origin: "", fetchFn }, "GET", "/x")).rejects.toBeInstanceOf(BrokerNetworkError);
  });
});
