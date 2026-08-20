import { BrokerApiError, BrokerNetworkError } from "./errors.js";

export interface HttpConfig {
  origin: string;
  token?: string;
  adminToken?: string;
  fetchFn?: typeof fetch;
}

export async function request<T = unknown>(
  cfg: HttpConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; admin?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  let url = cfg.origin + path;
  if (opts.query && Object.keys(opts.query).length > 0) url += "?" + new URLSearchParams(opts.query).toString();
  const headers: Record<string, string> = {};
  if (opts.admin) {
    if (cfg.adminToken) headers["x-admin-token"] = cfg.adminToken;
  } else if (cfg.token) {
    headers.authorization = `Bearer ${cfg.token}`;
  }
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await (cfg.fetchFn ?? fetch)(url, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
  } catch (e) {
    throw new BrokerNetworkError(e);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined; // non-JSON reply — surfaced via the error path below
  }
  if (!res.ok) {
    const env = (parsed ?? {}) as { code?: string; message?: string; [k: string]: unknown };
    const { code, message, ...details } = env;
    throw new BrokerApiError(code ?? "http_error", message ?? text.slice(0, 200), res.status, details);
  }
  return parsed as T;
}
