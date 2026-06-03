/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { buildCsp } from "./src/csp";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const cspOpts = {
    apiBase: env.VITE_API_BASE || "http://localhost:8000",
    auth0Domain: env.VITE_AUTH0_DOMAIN || "",
  };

  return {
    plugins: [react()],
    // Dev server gets an HMR-compatible policy; `vite preview` (the production-build
    // serving path) gets the strict one.
    server: {
      port: 5173,
      headers: { "Content-Security-Policy": buildCsp({ ...cspOpts, dev: true }) },
    },
    preview: {
      headers: { "Content-Security-Policy": buildCsp({ ...cspOpts, dev: false }) },
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
