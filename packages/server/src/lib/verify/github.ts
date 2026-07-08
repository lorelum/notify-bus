/**
 * GitHub webhook signature verification.
 *
 * STATUS: stub. Implemented in M1.
 *
 * SECURITY-CRITICAL (see AGENTS.md). The rules:
 *
 *   1. The signature is HMAC-SHA256 over the *raw request body bytes* — NOT
 *      the JSON-parsed-then-restringified body. Re-serializing changes byte
 *      ordering/whitespace and breaks verification. The raw buffer is
 *      captured in `routes/webhook.ts` BEFORE Elysia's body parser runs.
 *   2. Compare against the `X-Hub-Signature-256` header, formatted as
 *      `sha256=<lowercase hex>`.
 *   3. Use constant-time comparison (`crypto.timingSafeEqual`) to prevent
 *      timing attacks.
 *   4. The secret comes from `GITHUB_WEBHOOK_SECRET` env var — never the DB
 *      or config file.
 *
 * A known-good test vector MUST live in github.test.ts (M1).
 *
 * Reference: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */

/**
 * Verify a GitHub webhook signature.
 *
 * @param rawBody     the exact bytes of the request body (captured pre-parse)
 * @param signature   the value of `X-Hub-Signature-256` (`sha256=<hex>`)
 * @param secret      the webhook secret (from env)
 * @returns           true if the signature is valid
 */
export function verifyGitHubSignature(
  _rawBody: Uint8Array,
  _signature: string,
  _secret: string,
): boolean {
  // M1: implement with crypto.createHmac("sha256", secret).update(rawBody)
  // and crypto.timingSafeEqual against the parsed hex. Constant-time.
  throw new Error("verifyGitHubSignature: not implemented (M1)");
}
