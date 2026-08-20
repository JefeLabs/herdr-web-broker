import type { SessionHandle } from "./client.js";
import { request } from "./http.js";
import type {
  AskResult,
  BundleReceipt,
  PromptReceipt,
  Screen,
  ScreenSource,
  ScreenUnchanged,
  SentReceipt,
  SpawnResult,
} from "./types.js";

export interface ScreenOpts {
  source?: ScreenSource;
  version?: string;
  waitMs?: number;
}

export interface WatchScreenOpts {
  source?: ScreenSource;
  waitMs?: number;
  onError?: (e: unknown) => void;
}

const enc = encodeURIComponent;
const BUNDLE_ID = /^\d{4}-\d{2}-\d{2}-/;

/** The conversation: the pane id is the handle, and the agent CLI keeps its
 * full context inside that pane between calls. */
export class AgentHandle {
  constructor(
    private readonly session: SessionHandle,
    readonly paneId: string,
    /** present when this handle came from spawn() */
    readonly spawned?: SpawnResult,
  ) {}

  #base(): string {
    return `${this.session.base()}/agents/${enc(this.paneId)}`;
  }

  /** Fire-and-forget steering — returns as soon as the prompt is delivered. */
  prompt(text: string): Promise<PromptReceipt> {
    return request(this.session.cfg, "POST", `${this.#base()}/prompt`, { body: { text } });
  }

  /** Structured turn: blocks until the agent writes its {"answer"} file. */
  ask(prompt: string, opts: { timeoutMs?: number } = {}): Promise<AskResult> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    return request(this.session.cfg, "POST", `${this.#base()}/ask`, {
      body: { prompt, timeout_ms: timeoutMs },
      timeoutMs: timeoutMs + 60_000,
    });
  }

  slash(command: string, args?: string): Promise<SentReceipt> {
    return request(this.session.cfg, "POST", `${this.#base()}/slash/${enc(command)}`, {
      body: args?.trim() ? { args: args.trim() } : {},
    });
  }

  setModel(model: string): Promise<SentReceipt> {
    return request(this.session.cfg, "POST", `${this.#base()}/model`, { body: { model } });
  }

  /** The portable hard interrupt: Escape into the pane, then re-prompt. */
  async interrupt(): Promise<void> {
    await this.session.rpc("pane.send_keys", { pane_id: this.paneId, keys: ["Escape"] });
  }

  /** The pane's visible terminal text — the confirmation channel for "sent"
   * semantics. */
  async read(): Promise<string> {
    const r = (await this.session.rpc("pane.read", { pane_id: this.paneId, source: "visible" })) as {
      result?: { read?: { text?: string } };
    };
    return r.result?.read?.text ?? "";
  }

  /** One frame of the pane's terminal — pass the previous `version` plus
   * `waitMs` to long-poll: the reply arrives the moment the screen changes,
   * or `{unchanged: true}` at the deadline. */
  screen(opts: ScreenOpts = {}): Promise<Screen | ScreenUnchanged> {
    const query: Record<string, string> = {};
    if (opts.source) query.source = opts.source;
    if (opts.version) query.version = opts.version;
    if (opts.waitMs) query.wait_ms = String(opts.waitMs);
    return request(this.session.cfg, "GET", `${this.session.base()}/panes/${enc(this.paneId)}/screen`, {
      query,
      timeoutMs: (opts.waitMs ?? 0) + 15_000,
    });
  }

  /** Managed live view: one long-poll in flight, version threading, and
   * exponential backoff (1s → 30s, reset on success) — the callback fires
   * only on changed frames. Returns an unsubscribe that stops the loop. */
  watchScreen(cb: (s: Screen) => void, opts: WatchScreenOpts = {}): () => void {
    const waitMs = opts.waitMs ?? 25_000;
    let stopped = false;
    let version: string | undefined;
    let backoff = 1_000;
    const run = async () => {
      while (!stopped) {
        try {
          const reply = await this.screen({
            ...(opts.source ? { source: opts.source } : {}),
            ...(version ? { version, waitMs } : {}),
          });
          backoff = 1_000;
          if (stopped) return;
          version = reply.version;
          if (!(reply as ScreenUnchanged).unchanged) cb(reply as Screen);
        } catch (e) {
          if (stopped) return;
          opts.onError?.(e);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    };
    void run();
    return () => {
      stopped = true;
    };
  }

  /** Type text into the pane as if at the keyboard (Enter included) — the
   * write half of the pane viewer, e.g. answering a trust dialog. */
  async type(text: string): Promise<void> {
    await this.session.rpc("pane.send_input", { pane_id: this.paneId, text, keys: ["Enter"] });
  }

  /** Raw key presses into the pane (herdr key names, e.g. "Down", "Enter"). */
  async keys(keys: string[]): Promise<void> {
    await this.session.rpc("pane.send_keys", { pane_id: this.paneId, keys });
  }

  /** Drive a spec bundle: a name starts (or dates) one, a full bundle id
   * continues it; `file` focuses the page the user is viewing. */
  spec(nameOrBundle: string, prompt: string, opts: { file?: string } = {}): Promise<BundleReceipt> {
    const key = BUNDLE_ID.test(nameOrBundle) ? { bundle: nameOrBundle } : { name: nameOrBundle };
    return request(this.session.cfg, "POST", `${this.#base()}/spec-bundles`, {
      body: { ...key, prompt, ...(opts.file ? { file: opts.file } : {}) },
      timeoutMs: 60_000,
    });
  }

  plan(bundle: string, prompt?: string): Promise<BundleReceipt> {
    return request(this.session.cfg, "POST", `${this.#base()}/spec-bundles/${enc(bundle)}/plan`, {
      body: prompt?.trim() ? { prompt: prompt.trim() } : {},
      timeoutMs: 60_000,
    });
  }
}
