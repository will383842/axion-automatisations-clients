// Déclencheurs d'une instance (A-292). `webhook` arrive en T4-24.
export type Declencheur =
  | { type: "cron"; id: string; expression: string }
  | { type: "sondage"; id: string; intervalleMs: number };

export const FUSEAU = "Europe/Paris";

export type Repetition = { pattern: string; tz: string } | { every: number };

export function versRepetition(d: Declencheur): Repetition {
  return d.type === "cron" ? { pattern: d.expression, tz: FUSEAU } : { every: d.intervalleMs };
}

// Travail unique : la clé est la demande, deux clics sur la même demande ne font qu'un travail.
export function demandeManuelle(instanceId: string, demande: string) {
  return { jobId: `manuel:${instanceId}:${demande}`, data: { instanceId } };
}

export interface Curseurs {
  lire(instanceId: string, declencheurId: string): Promise<string | undefined>;
  ecrire(instanceId: string, declencheurId: string, curseur: string): Promise<void>;
}

export class CurseursMemoire implements Curseurs {
  #m = new Map<string, string>();
  async lire(i: string, d: string) {
    return this.#m.get(`${i}:${d}`);
  }
  async ecrire(i: string, d: string, c: string) {
    this.#m.set(`${i}:${d}`, c);
  }
}

// Le curseur n'avance qu'après le relevé : une panne entre les deux rejoue au lieu de perdre.
export async function executerSondage<T>(
  curseurs: Curseurs,
  instanceId: string,
  declencheurId: string,
  relever: (depuis: string | undefined) => Promise<{ elements: T[]; curseur: string }>,
): Promise<{ elements: T[]; curseur: string }> {
  const resultat = await relever(await curseurs.lire(instanceId, declencheurId));
  await curseurs.ecrire(instanceId, declencheurId, resultat.curseur);
  return resultat;
}
