/**
 * POST /webhook — GitHub webhook ingestion.
 *
 * STATUS: scaffold. Core logic lands in M1.
 *
 * ★ SECURITY-CRITICAL — RAW BODY CAPTURE ★
 * GitHub computes its HMAC-SHA256 signature over the *exact raw request
 * bytes*. Elysia's body parser runs in `parse` and would hand us a parsed
 * object. If we JSON.parse-then-stringify to recompute the signature, byte
 * ordering/whitespace diverges and verification fails — the classic bug.
 *
 * The M1 implementation MUST capture the raw body in a `beforeHandle` hook
 * (or via `request.text()` / the raw stream) BEFORE any schema parse, and
 * stash it on the request for the verifier. The signature header
 * `X-Hub-Signature-256` is then verified against those raw bytes.
 *
 * See src/lib/verify/github.ts for the verification contract.
 */
import { Elysia } from "elysia";

export const webhookRoute = new Elysia().post(
  "/webhook",
  async ({ request, set, headers }) => {
    // M1 TODO (in order):
    //   1. Read the raw body ONCE, before any parse. Stash it.
    //      const raw = new Uint8Array(await request.arrayBuffer());
    //   2. const signature = headers["x-hub-signature-256"];
    //   3. if (!verifyGitHubSignature(raw, signature, secret)) { 401; return }
    //   4. const event = headers["x-github-event"];
    //   5. const payload = JSON.parse(new TextDecoder().decode(raw));
    //   6. Build EventMessage, run pipeline, dispatch, log.

    const eventType = headers["x-gitHub-event"] ?? "ping";

    set.status = 501;
    return {
      status: "not_implemented",
      detail: "webhook ingestion lands in M1",
      event: eventType,
      receivedAt: new Date().toISOString(),
    };
  },
);
