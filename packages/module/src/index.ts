/** Bumped only on a BREAKING change to BrokerModuleApi. A module whose
 * `abi` does not equal the broker's is refused at load with a message
 * naming both numbers — a version mismatch should never present as a
 * mysterious missing method. */
export const BROKER_MODULE_ABI = 1;

/** Capability names. Duplicated from the broker's src/capabilities.ts ON
 * PURPOSE: this package is what third-party authors compile against, and
 * it must not import from the broker's internals. A test in the broker
 * asserts the two lists stay identical, so the duplication is checked
 * rather than trusted. */
export type Capability =
  | "git.read"
  | "git.write"
  | "files"
  | "workspaces"
  | "agents"
  | "rpc"
  | "events";

export interface RouteCtx {
  /** from `?workspace_id=`, or a `:workspaceId` segment in the route */
  workspaceId: string;
  sessionId: string;
  instance: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** the authenticated caller's token NAME — never the token itself */
  tokenName: string;
}

export type RouteHandler = (ctx: RouteCtx) => Promise<unknown> | unknown;

export interface GitApi {
  /** granted by `git.read`. argv is an ARRAY — there is no shell, so
   * there is nothing to inject into. argv[0] is checked against a
   * denylist of the operations whose broker equivalents audit and
   * confirm. */
  raw(workspaceId: string, repo: string, argv: string[]): Promise<string>;
  diff(workspaceId: string, repo: string, base?: string): Promise<unknown>;
  log(workspaceId: string, repo: string, limit?: number): Promise<unknown>;
  tree(workspaceId: string, repo: string): Promise<unknown>;
  /** granted by `git.write` — audited */
  commit?(workspaceId: string, repo: string, message: string): Promise<unknown>;
  push?(workspaceId: string, repo: string): Promise<unknown>;
}

export interface FilesApi {
  read(workspaceId: string, relPath: string): Promise<string>;
  write(workspaceId: string, relPath: string, data: string, opts?: { append?: boolean }): Promise<void>;
  list(workspaceId: string, relDir: string): Promise<string[]>;
}

export interface WorkspacesApi {
  list(): Promise<Array<{ workspace_id: string; cwd: string; label?: string }>>;
  cwd(workspaceId: string): Promise<string>;
}

export interface AgentsApi {
  list(): Promise<unknown[]>;
  prompt(paneId: string, text: string): Promise<unknown>;
  /** Takes the SAME per-pane lock core `ask` takes — a second concurrent
   * ask on one pane throws `pane_busy`, whether it came from a module or
   * a core route. Two asks would interleave two answer-file contracts at
   * one agent, and the agent cannot tell which prompt it is answering. */
  ask(paneId: string, prompt: string, opts?: { timeoutMs?: number }): Promise<unknown>;
}

/** Every capability is OPTIONAL because an ungranted one is absent from
 * the object entirely — not a stub that throws. If your module declares
 * `capabilities: ["files"]`, `api.git` is `undefined` at runtime and this
 * type reflects that. */
export interface BrokerModuleApi {
  route(method: "GET" | "POST" | "PUT" | "DELETE", path: string, handler: RouteHandler): void;
  /** Consume only. There is deliberately no `emit`: module-to-module
   * eventing would make this ABI a message bus. */
  on?(event: string, handler: (e: Record<string, unknown>) => void | Promise<void>): void;
  git?: GitApi;
  files?: FilesApi;
  workspaces?: WorkspacesApi;
  agents?: AgentsApi;
  rpc?(method: string, params: unknown): Promise<unknown>;
  /** always present — carries no authority */
  log(msg: string, extra?: Record<string, unknown>): void;
  /** Appends to the broker's existing audit trail, tagged with this
   * module's id as the actor, so "what did this module do" is answerable
   * from the same file that records privileged core actions. */
  audit(action: string, target?: string): void;
  badRequest(msg: string): Error;
  notFound(msg: string): Error;
}

export interface BrokerModule {
  /** unique; also the URL segment at /v1/modules/{id}/... */
  id: string;
  abi: number;
  capabilities: Capability[];
  register(api: BrokerModuleApi): void;
}
