/**
 * Which port the Vite dev server binds — defined ONCE, for the same reason as `apiBase.ts`.
 *
 * Parallel worktrees each run their own stack on slot-derived ports (see the "Parallel
 * worktrees" section of README.md). The frontend port is the one that is NOT free to drift:
 * Auth0's allowed callback / logout / web origins are an exact-match allowlist, so an
 * unexpected origin fails login rather than warning. `vite.config.ts` pairs this with
 * `strictPort: true` so a taken port is an error, not a silent hop to 5174.
 */
export const DEFAULT_DEV_PORT = 5173;

export function resolveDevPort(raw: string | undefined): number {
  // Unset means slot 0 — the main checkout, whose port every doc already names.
  if (raw === undefined || raw.trim() === "") return DEFAULT_DEV_PORT;
  const port = Number(raw);
  // A malformed value must NOT fall back to the default. 5173 is a real, registered origin, so
  // a typo would quietly serve this worktree on slot 0's port: Auth0 accepts it, nothing warns,
  // and the mistake only surfaces later as a bind conflict from the tree that owns that port.
  // `config.ts`'s tcpPort() refuses malformed input for exactly this reason.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `VITE_DEV_PORT is ${JSON.stringify(raw)}, which is not a TCP port (1-65535). ` +
        `Leave it unset for the default ${DEFAULT_DEV_PORT}.`,
    );
  }
  return port;
}
