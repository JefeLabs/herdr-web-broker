export type WsFactory = (url: string, protocols: string[]) => WebSocket;

export type EventType = "agent_status" | "instance_online" | "instance_offline" | "open" | "close";

export interface EventChannelOpts {
  origin: string;
  token: () => string;
  wsFactory?: WsFactory;
}

export class EventChannel {
  constructor(private readonly opts: EventChannelOpts) {}

  connect(): void {
    throw new Error("not implemented");
  }

  close(): void {
    throw new Error("not implemented");
  }

  on(type: EventType, cb: (data: unknown) => void): () => void {
    throw new Error("not implemented");
  }

  rpc(instance: string, session: string, method: string, params: unknown = {}, timeoutMs = 30_000): Promise<unknown> {
    throw new Error("not implemented");
  }
}
