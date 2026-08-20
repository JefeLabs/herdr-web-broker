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
  "/parent/ws": {
    target,
    ws: true,
    configure(p: HttpProxy.Server) {
      p.on("proxyReqWs", (proxyReq, req) => {
        const token = new URL(req.url ?? "/", "http://placeholder").searchParams.get("token");
        if (token) proxyReq.setHeader("authorization", `Bearer ${token}`);
      });
    },
  },
  "/parent": { target },
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
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url !== "/demo/mint" || req.method !== "POST") return next();
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
