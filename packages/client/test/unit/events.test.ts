import { afterEach, describe, expect, test, vi } from "vitest";
import { BrokerApiError } from "../../src/errors.js";
import { EventChannel } from "../../src/events.js";

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { wasClean: boolean }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.({ wasClean: true });
  }

  emitOpen() {
    this.readyState = 1;
    this.onopen?.(undefined);
  }

  emitMessage(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  emitDrop() {
    this.readyState = 3;
    this.onclose?.({ wasClean: false });
  }
}

function channel(probeStatus = 200) {
  FakeSocket.instances = [];
  const probes: string[] = [];
  const ch = new EventChannel({
    origin: "http://broker:7591",
    token: () => "tok",
    wsFactory: (url, protocols) => new FakeSocket(url, protocols) as unknown as WebSocket,
    fetchFn: (async (url: string | URL | Request) => {
      probes.push(String(url));
      return new Response(probeStatus === 200 ? "{}" : '{"code":"unauthorized","message":"nope"}', {
        status: probeStatus,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  return Object.assign(ch, { probes });
}

afterEach(() => vi.useRealTimers());

describe("EventChannel", () => {
  test("connect uses the ws origin and bearer subprotocols; open event fires", () => {
    const ch = channel();
    const opened: unknown[] = [];
    ch.on("open", (e) => opened.push(e));
    ch.connect();
    const sock = FakeSocket.instances[0];
    expect(sock.url).toBe("ws://broker:7591/events");
    expect(sock.protocols).toEqual(["bearer", "tok"]);
    sock.emitOpen();
    expect(opened.length).toBe(1);
    ch.close();
  });

  test("event frames dispatch to typed subscribers; dotted names normalize", () => {
    const ch = channel();
    const statuses: unknown[] = [];
    const online: unknown[] = [];
    ch.on("agent_status", (e) => statuses.push(e));
    ch.on("instance_online", (e) => online.push(e));
    ch.connect();
    const sock = FakeSocket.instances[0];
    sock.emitOpen();
    sock.emitMessage({ event: { type: "agent_status", agent: { id: "w1:p1", status: "working" } } });
    sock.emitMessage({ event: { type: "instance.online", instance: "laptop" } });
    expect((statuses[0] as { agent: { id: string } }).agent.id).toBe("w1:p1");
    expect((online[0] as { instance: string }).instance).toBe("laptop");
    ch.close();
  });

  test("rpc frames round-trip by id; error frames reject typed", async () => {
    const ch = channel();
    ch.connect();
    const sock = FakeSocket.instances[0];
    sock.emitOpen();
    const p1 = ch.rpc("runtime", "default", "agent.list");
    const p2 = ch.rpc("runtime", "default", "nope.method");
    const f1 = JSON.parse(sock.sent[0]) as { id: string; method: string };
    const f2 = JSON.parse(sock.sent[1]) as { id: string };
    expect(f1.method).toBe("agent.list");
    sock.emitMessage({ id: f2.id, error: { code: "not_found", message: "unknown method" } });
    sock.emitMessage({ id: f1.id, result: { type: "agent_list", agents: [] } });
    expect(((await p1) as { type: string }).type).toBe("agent_list");
    const err = (await p2.catch((e) => e)) as BrokerApiError;
    expect(err.code).toBe("not_found");
    ch.close();
  });

  test("unclean close reconnects with backoff; clean close() does not", async () => {
    vi.useFakeTimers();
    const ch = channel();
    ch.connect();
    FakeSocket.instances[0].emitOpen();
    FakeSocket.instances[0].emitDrop();
    await vi.advanceTimersByTimeAsync(1500);
    expect(FakeSocket.instances.length).toBe(2);
    FakeSocket.instances[1].emitOpen();
    ch.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances.length).toBe(2);
  });

  test("a revoked token stops the reconnect loop with auth_failed instead of retrying forever", async () => {
    vi.useFakeTimers();
    const ch = channel(401);
    const authFailures: unknown[] = [];
    ch.on("auth_failed", (e) => authFailures.push(e));
    ch.connect();
    FakeSocket.instances[0].emitOpen();
    FakeSocket.instances[0].emitDrop(); // kicked: server terminated the socket
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances.length).toBe(1); // no reconnect attempts against a dead token
    expect(authFailures.length).toBe(1);
    expect(ch.probes.length).toBeGreaterThan(0);

    // after fixing the token, connect() works again
    ch.connect();
    expect(FakeSocket.instances.length).toBe(2);
  });
});
