import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

// Racine du dépôt : le suivi des fichiers de la sortie autonome doit voir packages/design.
const racine = fileURLToPath(new URL("../../", import.meta.url));

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: racine,
  poweredByHeader: false,
  transpilePackages: ["@axion-auto/design"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default config;
