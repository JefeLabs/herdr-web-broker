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

/** Constant-time bearer check: compare sha256 digests so lengths never leak. */
export function checkBearer(header: string | undefined, tokens: { token: string }[]): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = createHash("sha256").update(header.slice(7)).digest();
  return tokens.some((t) =>
    timingSafeEqual(presented, createHash("sha256").update(t.token).digest()),
  );
}
