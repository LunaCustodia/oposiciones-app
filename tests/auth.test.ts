import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  createTechnicalJobId,
  verifySessionToken,
  verifyTechnicalJobOwner,
} from "../src/server/auth.js";

describe("autenticación y propiedad de OCR-01", () => {
  const secret = "test-only-secret-with-enough-entropy";
  const ownerA = "owner-a";
  const ownerB = "owner-b";

  it("acepta una sesión firmada vigente y rechaza una caducada", () => {
    const token = createSessionToken(ownerA, secret, 1_000);
    expect(verifySessionToken(token, secret, 1_001)).toBe(ownerA);
    expect(verifySessionToken(token, secret, 1_000 + 8 * 60 * 60)).toBeNull();
  });

  it("vincula el identificador del trabajo a su propietario", () => {
    const jobId = createTechnicalJobId(ownerA, "retry-key", secret);
    expect(verifyTechnicalJobOwner(jobId, ownerA, secret)).toBe(true);
    expect(verifyTechnicalJobOwner(jobId, ownerB, secret)).toBe(false);
  });

  it("produce el mismo identificador ante el mismo reintento", () => {
    expect(createTechnicalJobId(ownerA, "same-click", secret)).toBe(
      createTechnicalJobId(ownerA, "same-click", secret),
    );
    expect(createTechnicalJobId(ownerA, "same-click", secret)).not.toBe(
      createTechnicalJobId(ownerA, "different-click", secret),
    );
  });
});
