/** Wire types, hand-aligned with the broker's OpenAPI response schemas. */

export interface Counts {
  working: number;
  blocked: number;
  idle: number;
}

export interface InstanceRollup {
  instance: string;
  online: boolean;
  as_of: string;
  counts: Counts;
}

export interface InstanceDetail {
  instance: string;
  online: boolean;
  as_of: string;
  platform?: string;
  herdr_version?: string;
  counts: Counts;
  sessions: string[];
}

export interface SessionSummary {
  name: string;
  counts: Counts;
}

export interface AgentInfo {
  id: string;
  title: string;
  status: "working" | "blocked" | "idle";
  /** herdr's unfolded five-valued status — a dead-but-listed agent shows here */
  raw_status?: string;
  interactive_ready?: boolean;
  launch_pending?: boolean;
}

export interface WorkspaceAgent {
  agent: string;
  pane_id: string;
  status: "working" | "blocked" | "idle";
}

export interface RepoInfo {
  name: string;
  path: string;
  branch: string;
  dirty: boolean;
}

export interface Workspace {
  workspace_id: string;
  cwd: string | null;
  label?: string;
  agents: WorkspaceAgent[];
  repos: RepoInfo[];
}

export interface TreeNode {
  name: string;
  type: "dir" | "file";
  children?: TreeNode[];
}

export interface DiffResult {
  workspace_id: string;
  repo: string;
  branch: string;
  status: { path: string; state: string }[];
  diff: string;
  truncated: boolean;
  full_bytes?: number;
}

export interface FileContent {
  workspace_id: string;
  repo: string;
  path: string;
  size: number;
  content: string;
  truncated?: boolean;
  binary?: boolean;
}

export interface SpawnOpts {
  kind: string;
  cwd?: string;
  workspace_id?: string;
  label?: string;
  name?: string;
  args?: string[];
  timeout_ms?: number;
}

/** `agent` is a STRING (the agent's name); `status` is top-level. */
export interface SpawnResult {
  workspace_id: string;
  pane_id: string;
  agent: string;
  status: "working" | "blocked" | "idle";
}

export interface AskResult {
  answer: unknown;
  raw?: string;
  truncated?: boolean;
  parse_error?: boolean;
  full_bytes?: number;
}

export type ScreenSource = "visible" | "recent";

export interface Screen {
  pane_id: string;
  source: ScreenSource;
  text: string;
  version: string;
  as_of: string;
  truncated?: boolean;
}

export interface ScreenUnchanged {
  pane_id: string;
  source: ScreenSource;
  version: string;
  unchanged: true;
}

export interface PromptReceipt {
  status: "prompted";
  pane_id: string;
  kind: string;
  agent: string;
}

export interface SentReceipt {
  status: "sent";
  pane_id: string;
  kind: string;
  model?: string;
  command: string;
}

export interface ModelInfo {
  kind: string;
  id: string;
  label?: string;
  context_window?: number;
  max_output?: number;
  notes?: string;
  source: "builtin" | "config";
}

export interface EnvEntry {
  name: string;
  scope: { kind?: string; session?: string };
  source: "manual" | "hook";
  set_at: string;
}

export interface CommitResult {
  workspace_id?: string;
  repo?: string;
  committed: boolean;
  clean?: boolean;
  commit?: string;
  branch?: string;
  subject?: string;
}

export interface LogEntry {
  sha: string;
  subject: string;
  author: string;
  when: string;
}

export interface PushResult {
  workspace_id?: string;
  repo?: string;
  pushed: true;
  remote: string;
  branch: string;
  detail: string;
}

export interface PresenceEntry {
  token: string;
  name?: string;
  email?: string;
  since: string;
  last_seen: string;
}

export interface ContextEntry {
  name: string;
  size: number;
  content_type: string;
  /** active attachments are listed in every prompt/ask/spec sent to agents */
  active: boolean;
  uploaded_at: string;
}

export interface BundleMember {
  content: string;
  size: number;
  truncated?: boolean;
  binary?: boolean;
}

export interface Bundle {
  workspace_id: string;
  bundle: string;
  dir: string;
  version: string;
  files: Record<string, BundleMember>;
}

export interface BundleSummary {
  bundle: string;
  files: string[];
}

export interface BundleReceipt {
  workspace_id: string;
  bundle: string;
  dir: string;
  files?: string[];
  file?: string;
  version?: string;
  status: "prompted";
}
