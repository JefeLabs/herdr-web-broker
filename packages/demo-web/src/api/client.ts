/** Transport layer: every request the console sends is described as a plain
 * EndpointRequest so the same value can be executed (send), displayed
 * (toCurl), and documented (the spec page) without drift. */

export interface EndpointRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  auth: "bearer" | "admin" | "none";
}

export interface Tokens {
  bearer?: string;
  admin?: string;
}

export interface BrokerResult {
  status: number;
  ok: boolean;
  ms: number;
  body: unknown;
}

export function buildUrl(req: EndpointRequest, origin = ""): string {
  let url = origin + req.path;
  if (req.query && Object.keys(req.query).length > 0) {
    url += "?" + new URLSearchParams(req.query).toString();
  }
  return url;
}

function headers(req: EndpointRequest, tokens: Tokens): Record<string, string> {
  const h: Record<string, string> = {};
  if (req.auth === "bearer" && tokens.bearer) h.authorization = `Bearer ${tokens.bearer}`;
  if (req.auth === "admin" && tokens.admin) h["x-admin-token"] = tokens.admin;
  if (req.body !== undefined) h["content-type"] = "application/json";
  return h;
}

export async function send(req: EndpointRequest, tokens: Tokens, fetchFn: typeof fetch = fetch): Promise<BrokerResult> {
  const started = performance.now();
  const res = await fetchFn(buildUrl(req), {
    method: req.method,
    headers: headers(req, tokens),
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // non-json reply (or empty) — surface the raw text
  }
  return { status: res.status, ok: res.ok, ms: Math.round(performance.now() - started), body };
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function toCurl(req: EndpointRequest, tokens: Tokens, origin: string): string {
  const parts = ["curl"];
  if (req.method !== "GET") parts.push("-X", req.method);
  if (req.auth === "bearer") parts.push("-H", shellQuote(`Authorization: Bearer ${tokens.bearer ?? "$TOKEN"}`));
  if (req.auth === "admin") parts.push("-H", shellQuote(`x-admin-token: ${tokens.admin ?? "$ADMIN_TOKEN"}`));
  if (req.body !== undefined) {
    parts.push("-H", shellQuote("content-type: application/json"));
    parts.push("--data", shellQuote(JSON.stringify(req.body)));
  }
  parts.push(buildUrl(req, origin));
  return parts.join(" ");
}

/** The browser WebSocket API cannot set an Authorization header; the Vite
 * proxy lifts this ?token= into the bearer header at upgrade time. */
export function wsUrl(token: string, loc: { protocol: string; host: string }): string {
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${loc.host}/events?token=${encodeURIComponent(token)}`;
}
