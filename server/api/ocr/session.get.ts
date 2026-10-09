import { defineHandler } from "nitro";
import { getAuthenticatedSession } from "../../../src/server/auth.js";

export default defineHandler((event) => {
  event.res.headers.set("cache-control", "no-store");
  const session = getAuthenticatedSession(event);
  return session
    ? { authenticated: true, csrf: session.csrf }
    : { authenticated: false };
});
