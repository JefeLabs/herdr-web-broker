import { describe, expect, test } from "vitest";
import { buildUrl, send, toCurl, wsUrl, type EndpointRequest } from "./client";

const get = (path: string): EndpointRequest => ({ method: "GET", path, auth: "bearer" });

describe("buildUrl", () => {
  test("bare path passes through", () => {
    expect(buildUrl(get("/parent"))).toBe("/parent");
  });

  test("query params are appended encoded", () => {
    expect(buildUrl({ ...get("/x"), query: { base: "origin/main", fresh: "1" } })).toBe(
      "/x?base=origin%2Fmain&fresh=1",
    );
  });

  test("origin prefixes the path", () => {
    expect(buildUrl(get("/health"), "http://box:7591")).toBe("http://box:7591/health");
  });
});

describe("send", () => {
  function capture(status = 200, body = '{"ok":true}', contentType = "application/json") {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(body, { status, headers: { "content-type": contentType } });
    }) as typeof fetch;
    return { calls, fetchFn };
  }

  test("bearer auth sets the authorization header", async () => {
    const { calls, fetchFn } = capture();
    await send(get("/parent"), { bearer: "tok-1" }, fetchFn);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
  });

  test("admin auth sets x-admin-token, not authorization", async () => {
    const { calls, fetchFn } = capture();
    await send({ method: "GET", path: "/admin/status", auth: "admin" }, { admin: "adm-1" }, fetchFn);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-admin-token"]).toBe("adm-1");
    expect(headers.authorization).toBeUndefined();
  });

  test("json body is serialized with content-type", async () => {
    const { calls, fetchFn } = capture();
    await send({ method: "POST", path: "/x", auth: "bearer", body: { kind: "copilot" } }, {}, fetchFn);
    expect(calls[0].init.body).toBe('{"kind":"copilot"}');
    expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  test("parses json replies and reports status", async () => {
    const { fetchFn } = capture(404, '{"code":"unknown_instance"}');
    const res = await send(get("/parent/nope"), {}, fetchFn);
    expect(res.status).toBe(404);
    expect(res.ok).toBe(false);
    expect(res.body).toEqual({ code: "unknown_instance" });
  });

  test("non-json replies fall back to raw text", async () => {
    const { fetchFn } = capture(200, "plain", "text/plain");
    const res = await send(get("/x"), {}, fetchFn);
    expect(res.body).toBe("plain");
  });
});

describe("toCurl", () => {
  test("GET with bearer", () => {
    const cmd = toCurl(get("/parent"), { bearer: "tok" }, "http://127.0.0.1:7591");
    expect(cmd).toBe("curl -H 'Authorization: Bearer tok' http://127.0.0.1:7591/parent");
  });

  test("POST with body single-quotes the json", () => {
    const cmd = toCurl(
      { method: "POST", path: "/p", auth: "bearer", body: { a: "it's" } },
      { bearer: "t" },
      "http://h",
    );
    expect(cmd).toContain("-X POST");
    expect(cmd).toContain(`--data '{"a":"it'\\''s"}'`);
  });

  test("admin uses the x-admin-token header", () => {
    const cmd = toCurl({ method: "POST", path: "/admin/reload", auth: "admin" }, { admin: "adm" }, "http://h");
    expect(cmd).toContain("-H 'x-admin-token: adm'");
  });
});

describe("wsUrl", () => {
  test("http origin becomes ws with encoded token", () => {
    expect(wsUrl("a/b c", { protocol: "http:", host: "localhost:5173" })).toBe(
      "ws://localhost:5173/parent/ws?token=a%2Fb%20c",
    );
  });

  test("https origin becomes wss", () => {
    expect(wsUrl("t", { protocol: "https:", host: "h" })).toBe("wss://h/parent/ws?token=t");
  });
});
