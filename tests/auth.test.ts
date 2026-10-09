import { describe, expect, it } from "vitest";
import { hash } from "@node-rs/argon2";
import {
  authenticateOcrUser,
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
    const token = createSessionToken(ownerA, secret, 1_000, "csrf-token-with-at-least-thirty-two-characters");
    expect(verifySessionToken(token, secret, 1_001)?.sub).toBe(ownerA);
    expect(verifySessionToken(token, secret, 1_000 + 8 * 60 * 60)).toBeNull();
  });

  it("valida la contraseña con Argon2id y rechaza credenciales incorrectas", async () => {
    const previous = {
      email: process.env.OCR_AUTH_EMAIL,
      password: process.env.OCR_AUTH_PASSWORD_ARGON2ID,
      session: process.env.OCR_SESSION_SECRET,
    };
    try {
      process.env.OCR_AUTH_EMAIL = "owner@example.test";
      process.env.OCR_AUTH_PASSWORD_ARGON2ID = await hash("correct-password");
      process.env.OCR_SESSION_SECRET = secret;

      await expect(authenticateOcrUser("owner@example.test", "wrong-password")).resolves.toBeNull();
      await expect(authenticateOcrUser("OWNER@example.test", "correct-password")).resolves.toMatch(
        /^[a-f0-9]{64}$/,
      );
    } finally {
      if (previous.email === undefined) delete process.env.OCR_AUTH_EMAIL;
      else process.env.OCR_AUTH_EMAIL = previous.email;
      if (previous.password === undefined) delete process.env.OCR_AUTH_PASSWORD_ARGON2ID;
      else process.env.OCR_AUTH_PASSWORD_ARGON2ID = previous.password;
      if (previous.session === undefined) delete process.env.OCR_SESSION_SECRET;
      else process.env.OCR_SESSION_SECRET = previous.session;
    }
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
