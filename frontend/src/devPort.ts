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
  if (raw === undefined || raw.trim() === "") return DEFAULT_DEV_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_DEV_PORT;
  return port;
}
