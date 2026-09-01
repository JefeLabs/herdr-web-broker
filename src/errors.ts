const STATUS: Record<string, number> = {
  unauthorized: 401,
  bad_request: 400,
  method_denied: 403,
  unknown_instance: 404,
  unknown_session: 404,
  unknown_workspace: 404,
  unknown_repo: 404,
  instance_offline: 503,
  upstream_timeout: 504,
  proto_mismatch: 400,
  git_error: 502,
  env_disabled: 403,
  mint_disabled: 403,
  env_hook_failed: 502,
  unknown_env: 404,
  unknown_model: 404,
  unknown_token: 404,
  unknown_bundle: 404,
  pane_busy: 409,
  email_taken: 409,
  stale_confirm: 409,
  unknown_email: 404,
  provision_failed: 502,
  rate_limited: 429,
  unknown_context: 404,
  unknown_file: 404,
  agent_unresponsive: 504,
  model_switch_unsupported: 400,
  // roadmap 31: the kind has no wire-verified resume syntax — a property of
  // the request, not a missing resource, so 400 rather than 404.
  resume_unsupported: 400,
  unknown_session_ref: 404,
  // roadmap 33: the CLI started and is unusable — the broker's own config-dir
  // redirect orphaned its credentials. 502 because the failure is in the
  // thing downstream of us, not in the caller's request; the caller's remedy
  // (POST .../env, then retry) has no 4xx in this table that fits.
  agent_unauthenticated: 502,
};

/** Unknown codes are herdr passthrough errors → 502 per spec §6. */
export function httpStatus(code: string): number {
  return STATUS[code] ?? 502;
}

export class BrokerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BrokerError";
  }

  toEnvelope(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}
