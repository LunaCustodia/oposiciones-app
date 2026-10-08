import { defineHandler } from "nitro";
import { requireOcrOwner } from "../../../src/server/auth.js";
import { getSafeAvailability } from "../../../src/server/connections.js";

export default defineHandler((event) => {
  requireOcrOwner(event);
  event.res.headers.set("cache-control", "no-store");
  return getSafeAvailability();
});
