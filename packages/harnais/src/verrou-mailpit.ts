import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Les fichiers de test tournent en parallèle mais partagent un seul Mailpit, que chacun vide :
// ce verrou les fait passer l'un après l'autre. Un verrou de plus de 2 minutes est considéré comme abandonné.
const DOSSIER = join(tmpdir(), "axion-harnais-mailpit.verrou");
const PERIME_MS = 120_000;

export async function prendreVerrouMailpit(): Promise<() => void> {
  for (;;) {
    try {
      mkdirSync(DOSSIER);
      return () => rmSync(DOSSIER, { recursive: true, force: true });
    } catch {
      try {
        if (Date.now() - statSync(DOSSIER).mtimeMs > PERIME_MS) rmSync(DOSSIER, { recursive: true, force: true });
      } catch {
        // le verrou vient d'être libéré
      }
      await new Promise((ok) => setTimeout(ok, 50));
    }
  }
}
