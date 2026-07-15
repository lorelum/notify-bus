/**
 * GitHub webhook signature verification.
 *
 * SECURITY-CRITICAL (see AGENTS.md). The rules:
 *
 *   1. The signature is HMAC-SHA256 over the *raw request body bytes* — NOT
 *      the JSON-parsed-then-restringified body. Re-serializing changes byte
 *      ordering/whitespace and breaks verification. The raw buffer is
 *      captured in `routes/webhook.ts` BEFORE Elysia's body parser runs
 *      (via the `onParse` lifecycle hook).
 *   2. Compare against the `X-Hub-Signature-256` header, formatted as
 *      `sha256=<lowercase hex>`.
 *   3. Use constant-time comparison (`timingSafeEqual`) to prevent timing
 *      attacks.
 *   4. The secret comes from `GITHUB_WEBHOOK_SECRET` env var — never the DB
 *      or config file.
 *
 * Reference: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";
const HEX_LENGTH = 64; // SHA-256 digest = 32 bytes = 64 hex chars

/**
 * Verify a GitHub webhook signature.
 *
 * @param rawBody     the exact bytes of the request body (captured pre-parse)
 * @param signature   the value of `X-Hub-Signature-256` (`sha256=<hex>`)
 * @param secret      the webhook secret (from env)
 * @returns           true if the signature is valid
 */
export function verifyGitHubSignature(
  rawBody: Uint8Array,
  signature: string,
  secret: string,
): boolean {
  if (!signature.startsWith(PREFIX)) return false;
  const receivedHex = signature.slice(PREFIX.length);
  if (receivedHex.length !== HEX_LENGTH) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(receivedHex, "utf8");

  // Buffer.from(..., "utf8") yields the literal chars; we then compare the
  // hex strings in constant time. Lengths are equal (both 64) by the guard
  // above + the digest length, so timingSafeEqual won't throw.
  const expectedHex = Buffer.from(expected.toString("hex"), "utf8");
  return (
    expectedHex.length === received.length &&
    timingSafeEqual(expectedHex, received)
  );
}
