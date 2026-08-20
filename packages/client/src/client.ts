import { AgentHandle } from "./agent.js";
import { BundleScope } from "./bundles.js";
import { BrokerApiError } from "./errors.js";
import { EventChannel, type WsFactory } from "./events.js";
import { request, type HttpConfig } from "./http.js";
import type {
  AgentInfo,
  CommitResult,
  DiffResult,
  EnvEntry,
  FileContent,
  InstanceDetail,
  InstanceRollup,
  LogEntry,
  ModelInfo,
  PushResult,
  SessionSummary,
  SpawnOpts,
  SpawnResult,
  TreeNode,
  Workspace,
} from "./types.js";

const enc = encodeURIComponent;

export interface BrokerClientOpts {
  /** e.g. "http://127.0.0.1:7591", or "" when served behind a same-origin proxy */
  origin: string;
  token?: string;
  adminToken?: string;
  fetchFn?: typeof fetch;
  wsFactory?: WsFactory;
}

export class BrokerClient {
  readonly cfg: HttpConfig;
  #origin: string;
  #wsFactory?: WsFactory;
  #events?: EventChannel;

  constructor(opts: BrokerClientOpts) {
    this.cfg = { origin: opts.origin, token: opts.token, adminToken: opts.adminToken, fetchFn: opts.fetchFn };
    this.#origin = opts.origin;
    this.#wsFactory = opts.wsFactory;
  }

  setToken(token: string): void {
    this.cfg.token = token;
  }

  /** The auth-gate primitive: a stored token is not authentication until the
   * broker accepts it live. Auth failures report, they don't throw. */
  async verify(): Promise<{ ok: boolean; error?: BrokerApiError }> {
    try {
      await request(this.cfg, "GET", "/parent");
      return { ok: true };
    } catch (e) {
      if (e instanceof BrokerApiError) return { ok: false, error: e };
      throw e;
    }
  }

  async instances(): Promise<InstanceRollup[]> {
    const r = await request<{ instances: InstanceRollup[] }>(this.cfg, "GET", "/parent");
    return r.instances;
  }

  instance(name: string): InstanceHandle {
    return new InstanceHandle(this.cfg, name);
  }

  /** One channel per client; lazily created, connect() to start. */
  get events(): EventChannel {
    this.#events ??= new EventChannel({
      origin: this.#origin,
      token: () => this.cfg.token ?? "",
      wsFactory: this.#wsFactory,
    });
    return this.#events;
  }
}

export class InstanceHandle {
  constructor(
    private readonly cfg: HttpConfig,
    readonly name: string,
  ) {}

  #base(): string {
    return `/parent/${enc(this.name)}`;
  }

  detail(): Promise<InstanceDetail> {
    return request(this.cfg, "GET", this.#base());
  }

  async sessions(): Promise<SessionSummary[]> {
    const r = await request<{ sessions: SessionSummary[] }>(this.cfg, "GET", `${this.#base()}/sessions`);
    return r.sessions;
  }

  async models(kind?: string): Promise<ModelInfo[]> {
    const r = await request<{ models: ModelInfo[] }>(this.cfg, "GET", `${this.#base()}/models`, {
      ...(kind ? { query: { kind } } : {}),
    });
    return r.models;
  }

  session(name: string): SessionHandle {
    return new SessionHandle(this.cfg, this.name, name);
  }

  readonly env = {
    set: (name: string, value: string, scope: { kind?: string; session?: string } = {}) =>
      request(this.cfg, "POST", `${this.#base()}/env`, { body: { name, value, ...scope } }),
    list: async (): Promise<EnvEntry[]> => {
      const r = await request<{ vars: EnvEntry[] }>(this.cfg, "GET", `${this.#base()}/env`);
      return r.vars;
    },
    delete: (name: string, scope: { kind?: string; session?: string } = {}) =>
      request(this.cfg, "DELETE", `${this.#base()}/env/${enc(name)}`, {
        query: Object.fromEntries(Object.entries(scope).filter(([, v]) => v !== undefined)) as Record<string, string>,
      }),
  };
}

export class SessionHandle {
  constructor(
    readonly cfg: HttpConfig,
    readonly instance: string,
    readonly name: string,
  ) {}

  base(): string {
    return `/parent/${enc(this.instance)}/sessions/${enc(this.name)}`;
  }

  async agents(opts: { fresh?: boolean } = {}): Promise<AgentInfo[]> {
    const r = await request<{ agents: AgentInfo[] }>(this.cfg, "GET", `${this.base()}/agents`, {
      ...(opts.fresh ? { query: { fresh: "1" } } : {}),
    });
    return r.agents;
  }

  async workspaces(): Promise<Workspace[]> {
    const r = await request<{ workspaces: Workspace[] }>(this.cfg, "GET", `${this.base()}/workspaces`);
    return r.workspaces;
  }

  async spawn(opts: SpawnOpts): Promise<AgentHandle> {
    const spawned = await request<SpawnResult>(this.cfg, "POST", `${this.base()}/agents`, { body: opts });
    return new AgentHandle(this, spawned.pane_id, spawned);
  }

  /** Attach to an agent that already lives in a pane. */
  agent(paneId: string): AgentHandle {
    return new AgentHandle(this, paneId);
  }

  repo(workspaceId: string, repo: string): RepoHandle {
    return new RepoHandle(this, workspaceId, repo);
  }

  bundles(workspaceId: string): BundleScope {
    return new BundleScope(this, workspaceId);
  }

  /** herdr passthrough escape hatch — any socket method. */
  rpc(method: string, params: unknown = {}, timeoutMs?: number): Promise<unknown> {
    return request(this.cfg, "POST", `${this.base()}/rpc`, {
      body: { method, params, ...(timeoutMs ? { timeout_ms: timeoutMs } : {}) },
      ...(timeoutMs ? { timeoutMs: timeoutMs + 15_000 } : {}),
    });
  }
}

export class RepoHandle {
  constructor(
    private readonly session: SessionHandle,
    readonly workspaceId: string,
    readonly repo: string,
  ) {}

  #base(): string {
    // discoverRepos reports the workspace-root repo as path "." — the API's
    // token for it is "-", and browsers would collapse a literal /./ segment
    // out of the URL entirely, so translate here.
    const repo = this.repo === "." ? "-" : this.repo;
    return `${this.session.base()}/workspaces/${enc(this.workspaceId)}/repos/${enc(repo)}`;
  }

  async tree(): Promise<{ tree: TreeNode; truncated: boolean }> {
    return request(this.session.cfg, "GET", `${this.#base()}/tree`);
  }

  diff(base?: string): Promise<DiffResult> {
    return request(this.session.cfg, "GET", `${this.#base()}/git/diff`, {
      ...(base ? { query: { base } } : {}),
    });
  }

  file(path: string): Promise<FileContent> {
    return request(this.session.cfg, "GET", `${this.#base()}/file`, { query: { path } });
  }

  /* ── basic git verbs (vibe-coding loop) ── */

  commit(opts: {
    message: string;
    addAll?: boolean;
    author?: { name: string; email: string };
  }): Promise<CommitResult> {
    return request(this.session.cfg, "POST", `${this.#base()}/git/commit`, {
      body: {
        message: opts.message,
        ...(opts.addAll === false ? { add_all: false } : {}),
        ...(opts.author ? { author: opts.author } : {}),
      },
      timeoutMs: 60_000,
    });
  }

  async log(limit?: number): Promise<LogEntry[]> {
    const r = await request<{ commits: LogEntry[] }>(this.session.cfg, "GET", `${this.#base()}/git/log`, {
      ...(limit ? { query: { limit: String(limit) } } : {}),
    });
    return r.commits;
  }

  push(opts: { remote?: string; branch?: string } = {}): Promise<PushResult> {
    return request(this.session.cfg, "POST", `${this.#base()}/git/push`, { body: opts, timeoutMs: 90_000 });
  }

  checkout(ref: string, opts: { create?: boolean } = {}): Promise<{ branch: string }> {
    return request(this.session.cfg, "POST", `${this.#base()}/git/checkout`, {
      body: { ref, ...(opts.create ? { create: true } : {}) },
      timeoutMs: 60_000,
    });
  }
}
