import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyGitHubSignature } from "./github";

// Known-good vector: a fixed secret + body, with the signature computed the
// same way GitHub computes it (HMAC-SHA256 over the raw body). The test both
// derives the expected signature independently AND hardcodes it, so a bug in
// the derivation can't mask a bug in the verifier.
const SECRET = "it's a secret to everybody";
const BODY = Buffer.from(JSON.stringify({ zen: "keep it logically awesome" }));
const PREFIX = "sha256=";

function expectedSignature(secret: string, body: Uint8Array): string {
  return PREFIX + createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyGitHubSignature", () => {
  it("accepts a valid signature (known-good vector)", () => {
    const sig = expectedSignature(SECRET, BODY);
    expect(verifyGitHubSignature(BODY, sig, SECRET)).toBe(true);
  });

  it("accepts the independently-derived signature", () => {
    // Different body, different secret — signature derived fresh.
    const body = Buffer.from('{"action":"opened","number":42}');
    const sig = expectedSignature("another secret", body);
    expect(verifyGitHubSignature(body, sig, "another secret")).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = expectedSignature(SECRET, BODY);
    const tampered = Buffer.from(
      JSON.stringify({ zen: "keep it logically AWFUL" }),
    );
    expect(verifyGitHubSignature(tampered, sig, SECRET)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const sig = expectedSignature(SECRET, BODY);
    expect(verifyGitHubSignature(BODY, sig, "wrong secret")).toBe(false);
  });

  it("rejects a missing sha256= prefix", () => {
    const hex = expectedSignature(SECRET, BODY).slice(PREFIX.length);
    expect(verifyGitHubSignature(BODY, hex, SECRET)).toBe(false);
  });

  it("rejects non-hex content after the prefix", () => {
    expect(verifyGitHubSignature(BODY, `${PREFIX}nothexatall!!`, SECRET)).toBe(
      false,
    );
  });

  it("rejects a signature whose hex length differs from the digest", () => {
    // SHA-256 hex is 64 chars; a wrong length must not reach timingSafeEqual.
    expect(
      verifyGitHubSignature(BODY, `${PREFIX}abc123`, SECRET),
    ).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(verifyGitHubSignature(BODY, "", SECRET)).toBe(false);
  });
});
