import { API_VERSION } from "@jefelabs/herdr-broker-client";
import { expect, test } from "vitest";
import { proxy } from "../../vite.config";

// Regression guard for 78c77b2, which moved every SDK URL under /v1 but left
// this site's proxy table listing only the bare prefixes. The prefixed
// requests never reached the broker — vite's SPA fallback answered them with
// 200 text/html, so `useAgents` parsed HTML, threw, swallowed the error, and
// rendered "— no agents —". A 404 would have been loud; a 200 was silent.
//
// Asserting against the SDK's own constant rather than a literal "/v1" is the
// point: the bug was two copies of the version drifting apart, so a future v2
// has to break this test rather than the demo.
test("the site proxies the version prefix the SDK actually emits", () => {
  expect(Object.keys(proxy)).toContain(`/${API_VERSION}`);
});

test("the unversioned prefixes the SDK still uses stay proxied", () => {
  // /auth, /health, /admin and the /events websocket are deliberately NOT
  // versioned — they are pre-negotiation or transport, not API surface.
  for (const prefix of ["/events", "/auth", "/health", "/admin"]) {
    expect(Object.keys(proxy)).toContain(prefix);
  }
});
