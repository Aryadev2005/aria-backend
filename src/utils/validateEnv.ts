// Validates required environment variables at startup.
// Throws on missing critical vars so the process exits early with a clear message
// rather than crashing later with a confusing undefined-reference error.

const REQUIRED = [
  "DATABASE_URL",
  "REDIS_URL",
  "OPENAI_API_KEY",
  "TOKEN_ENCRYPTION_KEY",
  "FIREBASE_PROJECT_ID",
] as const;

const RECOMMENDED_IN_PROD = [
  "ADMIN_SECRET",
  "ALLOWED_ORIGINS",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
] as const;

export function validateEnv(): void {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  if (process.env.NODE_ENV === "production") {
    const missingRecommended = RECOMMENDED_IN_PROD.filter((k) => !process.env[k]);
    if (missingRecommended.length > 0) {
      console.warn(
        `[ARIA] WARNING — missing recommended production env vars: ${missingRecommended.join(", ")}`,
      );
    }
  }

  const encKey = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(encKey)) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (no spaces, no newlines). " +
      `Current value has length ${encKey.length} and contains non-hex chars: ${!/^[0-9a-fA-F]+$/.test(encKey)}`,
    );
  }
}
