import crypto from "crypto";
import { cache } from "../config/redis";

const NONCE_TTL = 600; // 10 minutes — OAuth flow must complete within this window
const NONCE_PREFIX = "oauth_nonce:";

export async function createOAuthNonce(userId: string): Promise<string> {
  const nonce = crypto.randomBytes(32).toString("hex");
  await cache.set(`${NONCE_PREFIX}${nonce}`, userId, NONCE_TTL);
  return nonce;
}

// Returns the userId the nonce was created for, or null if invalid/expired.
// Deletes the nonce on success — one-time use only.
export async function validateOAuthNonce(nonce: string): Promise<string | null> {
  if (!nonce || !/^[0-9a-f]{64}$/.test(nonce)) return null;
  const key = `${NONCE_PREFIX}${nonce}`;
  const userId = (await cache.get(key)) as string | null;
  if (userId) {
    await cache.del(key);
  }
  return userId;
}
