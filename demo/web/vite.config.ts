import react from "@vitejs/plugin-react";
import type { HttpProxy } from "vite";
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

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, proxy },
  preview: { host: true, port: 5173, proxy },
  test: { environment: "node" },
});
