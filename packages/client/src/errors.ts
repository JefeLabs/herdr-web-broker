/** The broker's error envelope {code, message, ...details}, mapped 1:1. */
export class BrokerApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BrokerApiError";
  }
}

/** The broker never answered — DNS, refused connection, aborted request. */
export class BrokerNetworkError extends Error {
  constructor(readonly cause: unknown) {
    super(`broker unreachable: ${String(cause)}`);
    this.name = "BrokerNetworkError";
  }
}
