import type { AuthStatus } from "../../public/types.js";
/** Passive only. Cached native credentials are never read, refreshed or extracted. */
export async function inspectAntigravityAuth(
  _env: NodeJS.ProcessEnv,
): Promise<AuthStatus> {
  return {
    authenticated: false,
    state: "unknown",
    source: "unknown",
  };
}
