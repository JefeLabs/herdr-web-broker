import type { SessionHandle } from "./client.js";
import { request } from "./http.js";
import type { AskResult, BundleReceipt, PromptReceipt, SentReceipt, SpawnResult } from "./types.js";

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
