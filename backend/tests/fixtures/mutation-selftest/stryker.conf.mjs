export default {
  packageManager: "npm",
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  reporters: ["json"],
  mutate: ["src/toggle.ts"],
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
