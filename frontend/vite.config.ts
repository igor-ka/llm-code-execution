/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { buildCsp } from "./src/csp";

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

  // The production policy takes the RAW value, mirroring api.ts's `?? default` exactly. The dev
  // fallback must not leak in here: the production image builds with VITE_API_BASE="" (the API is
  // same-origin), and `"" || "http://localhost:8000"` would bake a plaintext localhost origin
  // into connect-src — shipped in csp.txt, and caught by the image check as a build defect.
  const prodCsp = buildCsp({ apiBase: env.VITE_API_BASE ?? "", auth0Domain, dev: false });
  // The dev server keeps the convenience fallback; nothing it emits is ever deployed.
  const devCsp = buildCsp({
    apiBase: env.VITE_API_BASE || "http://localhost:8000",
    auth0Domain,
    dev: true,
  });

  return {
    plugins: [react(), emitCsp(prodCsp)],
    // Dev server gets an HMR-compatible policy; `vite preview` (the production-build serving
    // path) gets the strict one.
    server: {
      port: 5173,
      headers: { "Content-Security-Policy": devCsp },
    },
    preview: {
      headers: { "Content-Security-Policy": prodCsp },
    },
    test: {
      environment: "jsdom",
      globals: true,
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
