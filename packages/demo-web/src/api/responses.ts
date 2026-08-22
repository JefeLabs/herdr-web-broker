/** Success-response schemas per operation id, hand-aligned with the broker
 * source. The OpenAPI generator falls back here when a catalog entry
 * declares no inline `response`, so every operation is codegen-complete
 * without bloating the catalog itself. */

type Schema = Record<string, unknown>;

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const bool = { type: "boolean" } as const;
const strArr = { type: "array", items: str } as const;

const counts: Schema = {
  type: "object",
  properties: { working: num, blocked: num, idle: num },
  required: ["working", "blocked", "idle"],
};

const rollup: Schema = {
  type: "object",
  properties: { instance: str, online: bool, as_of: str, counts },
  required: ["instance", "online", "as_of", "counts"],
};

const presenceEntry: Schema = {
  type: "object",
  properties: { token: str, name: str, email: str, since: str, last_seen: str },
  required: ["token", "since", "last_seen"],
};

const sentReceipt: Schema = {
  type: "object",
  properties: { status: { type: "string", enum: ["sent"] }, pane_id: str, kind: str, model: str, command: str },
  required: ["status", "pane_id", "kind", "command"],
};

const contextEntry: Schema = {
  type: "object",
  properties: { name: str, size: num, content_type: str, active: bool, uploaded_at: str },
  required: ["name", "size", "content_type", "active", "uploaded_at"],
};

const bundleFiles: Schema = {
  type: "object",
  description: "member file name → content",
  additionalProperties: {
    type: "object",
    properties: { content: str, size: num, truncated: bool, binary: bool },
    required: ["content", "size"],
  },
};

const treeNode: Schema = {
  type: "object",
  description: "recursive: children hold further TreeNodes",
  properties: {
    name: str,
    type: { type: "string", enum: ["dir", "file"] },
    children: { type: "array", items: { type: "object", description: "TreeNode (recursive)" } },
  },
  required: ["name", "type"],
};

const deleted: Schema = {
  type: "object",
  properties: { status: { type: "string", enum: ["deleted"] } },
  required: ["status"],
};

export const RESPONSES: Record<string, Schema> = {
  health: {
    type: "object",
    properties: { ok: bool, name: str, version: str, pid: num },
    required: ["ok", "name", "version", "pid"],
  },
  instances: {
    type: "object",
    properties: {
      instances: { type: "array", items: rollup },
      in_use_by: { type: "array", items: presenceEntry },
    },
    required: ["instances", "in_use_by"],
  },
  instance: {
    type: "object",
    properties: {
      instance: str,
      online: bool,
      as_of: str,
      platform: str,
      herdr_version: str,
      counts,
      sessions: strArr,
    },
    required: ["instance", "online", "as_of", "counts", "sessions"],
  },
  sessions: {
    type: "object",
    properties: {
      sessions: {
        type: "array",
        items: { type: "object", properties: { name: str, counts }, required: ["name", "counts"] },
      },
    },
    required: ["sessions"],
  },
  workspaces: {
    type: "object",
    properties: {
      workspaces: {
        type: "array",
        items: {
          type: "object",
          properties: {
            workspace_id: str,
            cwd: { type: ["string", "null"] },
            label: str,
            agents: {
              type: "array",
              items: {
                type: "object",
                properties: { agent: str, pane_id: str, status: { type: "string", enum: ["working", "blocked", "idle"] } },
                required: ["agent", "pane_id", "status"],
              },
            },
            repos: {
              type: "array",
              items: {
                type: "object",
                properties: { name: str, path: str, branch: str, dirty: bool },
                required: ["name", "path", "branch", "dirty"],
              },
            },
          },
          required: ["workspace_id", "agents", "repos"],
        },
      },
    },
    required: ["workspaces"],
  },
  tree: {
    type: "object",
    properties: { workspace_id: str, repo: str, tree: treeNode, truncated: bool },
    required: ["workspace_id", "repo", "tree", "truncated"],
  },
  diff: {
    type: "object",
    properties: {
      workspace_id: str,
      repo: str,
      branch: str,
      status: {
        type: "array",
        items: { type: "object", properties: { path: str, state: str }, required: ["path", "state"] },
      },
      diff: str,
      truncated: bool,
      full_bytes: num,
    },
    required: ["workspace_id", "repo", "branch", "status", "diff", "truncated"],
  },
  "git-log": {
    type: "object",
    properties: {
      workspace_id: str,
      repo: str,
      commits: {
        type: "array",
        items: {
          type: "object",
          properties: { sha: str, subject: str, author: str, when: str },
          required: ["sha", "subject", "author", "when"],
        },
      },
    },
    required: ["workspace_id", "repo", "commits"],
  },
  "git-push": {
    type: "object",
    properties: { workspace_id: str, repo: str, pushed: bool, remote: str, branch: str, detail: str },
    required: ["workspace_id", "repo", "pushed", "remote", "branch", "detail"],
  },
  "git-checkout": {
    type: "object",
    properties: { workspace_id: str, repo: str, branch: str },
    required: ["workspace_id", "repo", "branch"],
  },
  "context-list": {
    type: "object",
    properties: { workspace_id: str, attachments: { type: "array", items: contextEntry } },
    required: ["workspace_id", "attachments"],
  },
  "context-set": contextEntry,
  "context-delete": deleted,
  slash: sentReceipt,
  "agent-model": sentReceipt,
  "spec-drive": {
    type: "object",
    properties: {
      workspace_id: str,
      bundle: str,
      dir: str,
      files: strArr,
      version: str,
      status: { type: "string", enum: ["prompted"] },
    },
    required: ["workspace_id", "bundle", "dir", "files", "version", "status"],
  },
  "spec-plan": {
    type: "object",
    properties: { workspace_id: str, bundle: str, dir: str, file: str, status: { type: "string", enum: ["prompted"] } },
    required: ["workspace_id", "bundle", "dir", "file", "status"],
  },
  "spec-list": {
    type: "object",
    properties: {
      workspace_id: str,
      bundles: {
        type: "array",
        items: { type: "object", properties: { bundle: str, files: strArr }, required: ["bundle", "files"] },
      },
    },
    required: ["workspace_id", "bundles"],
  },
  "spec-get": {
    oneOf: [
      {
        type: "object",
        properties: { workspace_id: str, bundle: str, dir: str, version: str, files: bundleFiles },
        required: ["workspace_id", "bundle", "dir", "version", "files"],
      },
      {
        type: "object",
        description: "long-poll window elapsed with no change",
        properties: { workspace_id: str, bundle: str, version: str, unchanged: { type: "boolean", enum: [true] } },
        required: ["workspace_id", "bundle", "version", "unchanged"],
      },
    ],
  },
  rpc: {
    type: "object",
    properties: { result: { description: "the herdr method's result, verbatim" } },
    required: ["result"],
  },
  "env-set": {
    type: "object",
    properties: {
      status: { type: "string", enum: ["stored"] },
      name: str,
      scope: { type: "object", properties: { kind: str, session: str } },
    },
    required: ["status", "name", "scope"],
  },
  "env-list": {
    type: "object",
    properties: {
      vars: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: str,
            scope: { type: "object", properties: { kind: str, session: str } },
            source: { type: "string", enum: ["manual", "hook"] },
            set_at: str,
          },
          required: ["name", "scope", "source", "set_at"],
        },
      },
    },
    required: ["vars"],
  },
  "env-delete": deleted,
  "models-list": {
    type: "object",
    properties: {
      models: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: str,
            id: str,
            label: str,
            context_window: num,
            max_output: num,
            notes: str,
            source: { type: "string", enum: ["builtin", "config"] },
          },
          required: ["kind", "id", "source"],
        },
      },
    },
    required: ["models"],
  },
  "git-pull": {
    type: "object",
    properties: {
      workspace_id: str,
      repo: str,
      pulled: { type: "boolean" },
      commit: str,
      branch: str,
      conflicts: strArr,
    },
    required: ["workspace_id", "repo", "pulled"],
  },
  "git-discard": {
    type: "object",
    properties: {
      workspace_id: str,
      repo: str,
      would_discard: strArr,
      confirm: str,
      discarded: { type: "boolean" },
      files: strArr,
    },
    required: ["workspace_id", "repo"],
  },
  "git-stash": {
    type: "object",
    properties: { workspace_id: str, repo: str, stashed: { type: "boolean" }, clean: { type: "boolean" } },
    required: ["workspace_id", "repo", "stashed"],
  },
  "git-stash-list": {
    type: "object",
    properties: {
      workspace_id: str,
      repo: str,
      stashes: {
        type: "array",
        items: { type: "object", properties: { ref: str, subject: str }, required: ["ref", "subject"] },
      },
    },
    required: ["workspace_id", "repo", "stashes"],
  },
  "git-stash-pop": {
    type: "object",
    properties: { workspace_id: str, repo: str, popped: { type: "boolean" }, conflicts: strArr },
    required: ["workspace_id", "repo", "popped"],
  },
  "admin-owners": {
    type: "object",
    properties: {
      owners: {
        type: "array",
        items: {
          type: "object",
          properties: { email: str, session: str, token: str, created_at: str },
          required: ["email", "session", "token", "created_at"],
        },
      },
    },
    required: ["owners"],
  },
  "admin-owner-rebind": {
    type: "object",
    properties: { rebound: str, session: str, token: str },
    required: ["rebound", "session", "token"],
  },
  "admin-owner-kill": {
    type: "object",
    properties: {
      torn_down: str,
      email: str,
      workspaces_closed: { type: "number" },
      token_revoked: { type: "boolean" },
      sockets_closed: { type: "number" },
    },
    required: ["torn_down", "email", "workspaces_closed", "token_revoked", "sockets_closed"],
  },
  "admin-status": {
    type: "object",
    properties: {
      listen: str,
      instances: { type: "array", items: rollup },
      children: strArr,
      in_use_by: { type: "array", items: presenceEntry },
    },
    required: ["listen", "instances", "children", "in_use_by"],
  },
  "admin-child-add": {
    type: "object",
    properties: { name: str, secret: str },
    required: ["name", "secret"],
  },
  "admin-child-revoke": {
    type: "object",
    properties: { revoked: str },
    required: ["revoked"],
  },
  "admin-token-revoke": {
    type: "object",
    properties: { revoked: str, remaining: num },
    required: ["revoked", "remaining"],
  },
  "admin-reload": {
    type: "object",
    properties: { reloaded: bool },
    required: ["reloaded"],
  },
};
