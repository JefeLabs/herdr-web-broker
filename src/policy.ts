export const DEFAULT_REMOTE_DENY = ["server.stop", "server.reload_config", "plugin.*"];

/** Deny globs: exact method name, "prefix.*" (matches any deeper suffix), or "*". */
export function methodDenied(method: string, denyGlobs: string[]): boolean {
  return denyGlobs.some((glob) => {
    if (glob === "*") return true;
    if (glob.endsWith(".*")) return method.startsWith(glob.slice(0, -1));
    return method === glob;
  });
}
