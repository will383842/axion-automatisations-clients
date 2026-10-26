import { createHash } from "node:crypto";

// SHA-256 de module.js + manifest.json + sbom.cdx.json, dans cet ordre, séparés par un saut de ligne.
export function empreinte(...fichiers: [Uint8Array, Uint8Array, Uint8Array]): string {
  const h = createHash("sha256");
  fichiers.forEach((f, i) => h.update(i ? "\n" : "").update(f));
  return h.digest("hex");
}
