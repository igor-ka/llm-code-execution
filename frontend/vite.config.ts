/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { buildCsp } from "./src/csp";
import { resolveApiBase } from "./src/apiBase";
import { resolveDevPort } from "./src/devPort";

/**
 * Emit the production CSP alongside the bundle.
 *
 * Without this the policy exists only as a header set by the Vite dev/preview servers, so a
 * static deploy of dist/ ships with no CSP whatsoever. The server that hosts dist/ reads this
 * file and sets the header, which keeps buildCsp() the single source of truth.
 */
function emitCsp(policy: string): Plugin {
  return {
    name: "emit-csp",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "csp.txt", source: `${policy}\n` });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const auth0Domain = env.VITE_AUTH0_DOMAIN || "";

  // THE SAME resolution the bundle uses (src/apiBase.ts), not a lookalike. `?? ""` here and
  // `?? "http://localhost:8000"` in the app would agree when the variable is set and diverge
  // when it is unset — shipping a bundle that calls localhost under a policy that forbids it,
  // with every check still green because the policy looks strict.
  //
  // The production image builds with VITE_API_BASE="" (same-origin API), so connect-src reduces
  // to 'self'; an unset value means a local build, which really does call localhost.
  const apiBase = resolveApiBase(env.VITE_API_BASE);
  // Slot-derived so two worktrees can serve the SPA at once. `loadEnv` merges prefixed
  // process.env over the .env files, so Compose can set this without a per-worktree file.
  const devPort = resolveDevPort(env.VITE_DEV_PORT);
  const prodCsp = buildCsp({ apiBase, auth0Domain, dev: false });
  const devCsp = buildCsp({ apiBase, auth0Domain, dev: true });

  return {
    plugins: [react(), emitCsp(prodCsp)],
    // Dev server gets an HMR-compatible policy; `vite preview` (the production-build serving
    // path) gets the strict one.
    server: {
      port: devPort,
      // Never silently hop to the next free port: the next port is an origin Auth0 has not
      // been told about, and the failure would surface as a login error far from its cause.
      strictPort: true,
      headers: { "Content-Security-Policy": devCsp },
    },
    preview: {
      // The SAME slot port as the dev server, not Vite's 4173 default. `preview` and `dev` are
      // never both running in one worktree, and reusing the port keeps the Auth0 origin pool at
      // four — a separate preview port per slot would need four more registered origins, and an
      // unregistered one fails login with no useful error.
      port: devPort,
      strictPort: true,
      headers: { "Content-Security-Policy": prodCsp },
    },
    test: {
      environment: "jsdom",
      globals: true,
      // Pin the API base the unit tests see. `api.ts` and `history.ts` read
      // `import.meta.env.VITE_API_BASE` at module load, so without this the suite inherits
      // whatever `.env.local` says — and in a worktree that is the slot's own port, which turns
      // every URL assertion into a failure about the developer's local config rather than about
      // the client's URL construction, which is the thing under test.
      env: { VITE_API_BASE: "http://localhost:8000" },
      setupFiles: "./src/test/setup.ts",
      css: false,
      coverage: {
        provider: "v8",
        reporter: ["text", "html"],
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/main.tsx", "src/vite-env.d.ts", "src/test/**"],
      },
    },
  };
});
