import { defineConfig, devices } from "@playwright/test";

// Deux projets à chaque PR : ordinateur 1440 (Chromium) et iPhone 390 (WebKit). Les captures de référence sont produites
// dans l'image Playwright épinglée de la CI (workflow visuel-design.yml), jamais ailleurs.
export default defineConfig({
  testDir: "tests",
  testMatch: "visuel.spec.ts",
  snapshotPathTemplate: "{testDir}/__captures__/{arg}{ext}",
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: { command: "pnpm exec vite galerie --host 127.0.0.1 --port 4173 --strictPort", url: "http://127.0.0.1:4173/console-alertes.html", reuseExistingServer: false },
  projects: [
    { name: "ordinateur-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "iphone-390", use: { ...devices["iPhone 13"] } },
  ],
});
