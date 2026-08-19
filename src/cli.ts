import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./config.js";
import { ensureAdminToken, readLock } from "./state.js";

interface Ctx {
  configDir: string;
  stateDir: string;
}

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      const key = rest[i].slice(2);
      if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
        flags.set(key, rest[++i]);
      } else {
        flags.set(key, "");
      }
    }
  }
  return { command, flags };
}

function need(flags: Map<string, string>, name: string): string {
  const v = flags.get(name);
  if (!v) {
    console.error(`missing required --${name}`);
    process.exit(1);
  }
  return v;
}

async function adminFetch(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | undefined> {
  const lock = readLock(ctx.stateDir);
  if (!lock) return undefined;

  const bodyStr = body ? JSON.stringify(body) : undefined;
  const url = `http://${lock.listen}${path}`;

  try {
    return await fetch(url, {
      method,
      headers: {
        "x-admin-token": ensureAdminToken(ctx.stateDir),
        ...(bodyStr ? { "content-type": "application/json" } : {}),
      },
      body: bodyStr,
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const ctx: Ctx = {
    configDir:
      flags.get("config-dir") ??
      process.env.HERDR_PLUGIN_CONFIG_DIR ??
      join(homedir(), ".config/herdr-web-broker"),
    stateDir:
      flags.get("state-dir") ??
      process.env.HERDR_PLUGIN_STATE_DIR ??
      join(homedir(), ".local/state/herdr-web-broker"),
  };

  if (command === "status") {
    const res = await adminFetch(ctx, "GET", "/admin/status");
    if (!res) {
      console.log(JSON.stringify({ running: false }));
      return;
    }
    console.log(JSON.stringify({ running: true, ...(await res.json()) }, null, 2));
    return;
  }

  if (command === "issue-secret") {
    const name = need(flags, "name");
    const res = await adminFetch(ctx, "POST", "/admin/children", { name });
    if (!res) {
      console.error("daemon not running — run the start action first");
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`daemon refused: ${await res.text()}`);
      process.exit(1);
    }
    console.log(JSON.stringify(await res.json()));
    return;
  }

  if (command === "revoke") {
    const name = need(flags, "name");
    const res = await adminFetch(ctx, "DELETE", `/admin/children/${encodeURIComponent(name)}`);
    if (!res) {
      console.error("daemon not running — run the start action first");
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`daemon refused: ${await res.text()}`);
      process.exit(1);
    }
    console.log(JSON.stringify(await res.json()));
    return;
  }

  if (command === "pair") {
    const config = loadConfig(ctx.configDir);
    config.parent = {
      address: need(flags, "address"),
      secret: need(flags, "secret"),
      name: need(flags, "name"),
    };
    saveConfig(ctx.configDir, config);
    await adminFetch(ctx, "POST", "/admin/reload"); // best effort
    console.log(JSON.stringify({ paired: config.parent.name, address: config.parent.address }));
    return;
  }

  if (command === "start") {
    const res = await adminFetch(ctx, "GET", "/admin/status");
    if (res) {
      console.log(JSON.stringify({ running: true, started: false }));
      return;
    }
    const daemonPath = join(dirname(fileURLToPath(import.meta.url)), "daemon.js");
    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HERDR_PLUGIN_CONFIG_DIR: ctx.configDir,
        HERDR_PLUGIN_STATE_DIR: ctx.stateDir,
      },
    });
    child.unref();
    console.log(JSON.stringify({ started: true, pid: child.pid }));
    return;
  }

  console.error(`unknown command '${command}' — one of: status issue-secret revoke pair start`);
  process.exit(1);
}

void main();
