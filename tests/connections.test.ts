import { afterEach, describe, expect, it } from "vitest";
import { documentAiEndpoint, getSafeAvailability } from "../src/server/connections.js";

const managedNames = [
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_DOCUMENT_AI_PROCESSOR_ID",
  "GOOGLE_CLOUD_CREDENTIALS_JSON",
  "VERCEL",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_PROJECT_ID",
] as const;
const original = Object.fromEntries(managedNames.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of managedNames) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("disponibilidad segura de conexiones", () => {
  it("usa el endpoint regional de Document AI", () => {
    expect(documentAiEndpoint("eu")).toBe("eu-documentai.googleapis.com");
  });

  it("no declara disponibilidad cuando faltan credenciales", () => {
    for (const name of managedNames) delete process.env[name];
    const availability = getSafeAvailability();
    expect(availability.status).toBe("pending_configuration");
    expect(availability.connections.gemini).toBe(false);
    expect(availability.connections.documentAi).toBe(false);
  });

  it("solo devuelve nombres de configuración, nunca valores", () => {
    process.env.GEMINI_API_KEY = "do-not-leak-this-value";
    delete process.env.GEMINI_MODEL;
    const serialized = JSON.stringify(getSafeAvailability());
    expect(serialized).toContain("GEMINI_MODEL");
    expect(serialized).not.toContain("do-not-leak-this-value");
  });
});
