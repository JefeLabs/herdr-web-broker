import react from "@vitejs/plugin-react";
import type { Connect, HttpProxy, Plugin } from "vite";
import { defineConfig } from "vitest/config";

// All broker traffic rides the dev-server proxy so the browser stays
// same-origin (the broker sets no CORS headers) and /admin sees a loopback
// peer. The browser WebSocket API cannot set an Authorization header, so
// the ws proxy lifts a ?token= query param into the bearer header at
// upgrade time — the broker only reads the pathname.
const target = process.env.VITE_BROKER_TARGET ?? "http://127.0.0.1:7591";

const proxy = {
  "/events": {
    target,
    ws: true,
    configure(p: HttpProxy.Server) {
      p.on("proxyReqWs", (proxyReq, req) => {
        const token = new URL(req.url ?? "/", "http://placeholder").searchParams.get("token");
        if (token) proxyReq.setHeader("authorization", `Bearer ${token}`);
      });
    },
  },
  "/instances": { target },
  "/auth": { target },
  "/health": { target },
  "/admin": { target },
};

/** Dev-only self-serve tokens: POST /demo/mint forwards to the broker's
 * admin mint endpoint with the x-admin-token header injected SERVER-side —
 * the admin secret never reaches the browser, only the minted bearer does.
 * Mounted only when the site process has BROKER_ADMIN_TOKEN; underneath,
 * the broker still 403s unless [token_mint] enabled = true. */
function demoMint(): Plugin {
  const adminToken = process.env.BROKER_ADMIN_TOKEN;
  // `vite --host` binds 0.0.0.0, so an unauthenticated mint endpoint would
  // hand LAN peers tokens to a possibly-REAL broker. Loopback-only unless
  // explicitly opened (the demo container opts in — its bearer is public
  // anyway); a small throttle stops drive-by token floods either way.
  const allowRemote = process.env.DEMO_MINT_ALLOW_REMOTE === "1";
  const mintTimes: number[] = [];
  const refuse = (res: Parameters<Connect.NextHandleFunction>[1], status: number, code: string, message: string) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ code, message }));
  };
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url !== "/demo/mint" || req.method !== "POST") return next();
    const peer = req.socket.remoteAddress ?? "";
    const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    if (!loopback && !allowRemote) {
      return refuse(res, 403, "forbidden", "self-serve minting is loopback-only on dev servers (demo containers set DEMO_MINT_ALLOW_REMOTE=1)");
    }
    const now = Date.now();
    while (mintTimes.length > 0 && mintTimes[0] < now - 60_000) mintTimes.shift();
    if (mintTimes.length >= 10) {
      return refuse(res, 429, "rate_limited", "too many demo tokens minted — wait a minute");
    }
    mintTimes.push(now);
    void (async () => {
      const name = `demo-${Math.random().toString(36).slice(2, 8)}`;
      const upstream = await fetch(`${target}/admin/tokens`, {
        method: "POST",
        headers: { "x-admin-token": adminToken as string, "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      res.statusCode = upstream.status;
      res.setHeader("content-type", "application/json");
      res.end(await upstream.text());
    })().catch((e) => {
      res.statusCode = 502;
      res.end(JSON.stringify({ code: "mint_proxy_error", message: String(e) }));
    });
  };
  return {
    name: "demo-mint",
    configureServer(server) {
      if (adminToken) server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      if (adminToken) server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), demoMint()],
  server: { host: true, port: 5173, proxy },
  preview: { host: true, port: 5173, proxy },
  // e2e/ belongs to Playwright — vitest must not pick up its *.spec.ts files
  test: { environment: "node", include: ["src/**/*.test.{ts,tsx}"] },
});
