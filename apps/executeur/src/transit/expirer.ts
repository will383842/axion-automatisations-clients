import type { Horloge, PortTransit } from "./port.ts";

export const DUREE_TRANSIT_MS = 24 * 3_600_000;
const HEURE_MS = 3_600_000;

// Deuxième niveau d'expiration (C-023) : efface toute copie de 24 h ou plus, même si la règle de cycle de vie du compartiment est absente.
// Une suppression qui échoue n'arrête pas le balayage ; elle sera retentée à l'heure suivante. Rend le nombre de copies effacées.
export async function expirer(d: { port: PortTransit; horloge: Horloge }): Promise<number> {
  const maintenant = d.horloge.maintenant();
  let effaces = 0;
  for (const o of await d.port.lister()) {
    if (maintenant - o.ecritLe < DUREE_TRANSIT_MS) continue;
    try {
      await d.port.supprimer(o.cle);
      effaces++;
    } catch {
      // retenté au tour suivant
    }
  }
  return effaces;
}

// Balayage horaire : une panne du stockage ne tue pas la boucle. S'arrête au signal.
export async function balayerChaqueHeure(d: { port: PortTransit; horloge: Horloge }, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await expirer(d).catch(() => undefined);
    // L'horloge ne rend pas la main sur arrêt : la boucle s'arrête d'elle-même au signal.
    await Promise.race([d.horloge.attendre(HEURE_MS, signal), new Promise<void>((fin) => signal.addEventListener("abort", () => fin(), { once: true }))]);
  }
}
