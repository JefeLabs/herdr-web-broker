/** Events the BROKER knows and herdr cannot.
 *
 * `broker.ask.unresponsive` is the clearest case for this layer existing:
 * it carries the `evidence` field from the transcript tier, so a handler
 * can tell a transcript-proven stall from an inferred one. No herdr event
 * can express that. */
export const BROKER_EVENTS = [
  "broker.agent.spawned",
  "broker.agent.spawn_failed",
  "broker.ask.completed",
  "broker.ask.unresponsive",
  "broker.repo.pushed",
  "broker.exec.finished",
  // Roadmap 31(f). herdr reaped a workspace and told us — including reaps no
  // broker call caused. `indexed` says whether it was one of ours (cleared)
  // or an orphan (announced, untouched), which is classifySession's
  // adopt/orphan split arriving as a push instead of a poll.
  "broker.workspace.reaped",
] as const;

export type BrokerEventName = (typeof BROKER_EVENTS)[number];
export type BrokerEventHandler = (e: Record<string, unknown>) => void | Promise<void>;

/** Fire-and-forget, at-most-once. `WS /events` is already live-only with
 * no replay; a layer promising at-least-once on top of a stream that
 * cannot replay would be a false guarantee. A consumer needing durability
 * owns it.
 *
 * Handlers CONSUME only. There is deliberately no way for a module to
 * emit: module-to-module eventing would make the ABI a message bus, and a
 * message bus owes its users delivery ordering, cycle detection and
 * inter-module failure semantics — permanent obligations in exchange for
 * a capability nobody has asked for. */
export class BrokerEvents {
  #handlers = new Map<BrokerEventName, BrokerEventHandler[]>();
  #inflight: Promise<void>[] = [];
  #errors = 0;

  on(name: BrokerEventName, handler: BrokerEventHandler): void {
    const list = this.#handlers.get(name) ?? [];
    list.push(handler);
    this.#handlers.set(name, list);
  }

  /** Never throws and never awaits — a slow or broken handler must not
   * affect the request that emitted. A handler's failure is counted, not
   * propagated: the emitting operation already succeeded, and failing it
   * retroactively because an observer threw would be the wrong causality. */
  emit(name: BrokerEventName, data: Record<string, unknown>): void {
    const list = this.#handlers.get(name);
    if (!list || list.length === 0) return;
    const payload = { ...data, name, at: new Date().toISOString() };
    for (const h of list) {
      try {
        const r = h(payload);
        if (r instanceof Promise) {
          this.#inflight.push(
            r.catch(() => {
              this.#errors++;
            }),
          );
        }
      } catch {
        this.#errors++;
      }
    }
  }

  /** Tests await this; production does not — emit is fire-and-forget. */
  async drain(): Promise<void> {
    const pending = this.#inflight;
    this.#inflight = [];
    await Promise.all(pending);
  }

  counts(): { errors: number } {
    return { errors: this.#errors };
  }
}
