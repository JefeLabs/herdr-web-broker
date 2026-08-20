import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function mintSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function verifySecret(secret: string, expectedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function matchIndex(header: string | undefined, tokens: { token: string }[]): number {
  if (!header?.startsWith("Bearer ")) return -1;
  const presented = createHash("sha256").update(header.slice(7)).digest();
  let idx = -1;
  for (let i = 0; i < tokens.length; i++) {
    // no early exit — every entry is compared so timing stays uniform
    if (timingSafeEqual(presented, createHash("sha256").update(tokens[i].token).digest()) && idx === -1) idx = i;
  }
  return idx;
}

/** Constant-time bearer check: compare sha256 digests so lengths never leak. */
export function checkBearer(header: string | undefined, tokens: { token: string }[]): boolean {
  return matchIndex(header, tokens) !== -1;
}

/** Same constant-time comparison, but reports WHICH token matched (by name)
 * — the handle presence and kickout key on. */
export function matchToken(
  header: string | undefined,
  tokens: { name: string; token: string }[],
): string | undefined {
  const idx = matchIndex(header, tokens);
  return idx === -1 ? undefined : tokens[idx].name;
}
