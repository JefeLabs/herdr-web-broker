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
  rate_limited: 429,
  unknown_context: 404,
  unknown_file: 404,
  agent_unresponsive: 504,
  model_switch_unsupported: 400,
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
