// Journal du courtier (A-055) : qui a demandé quoi pour quel client. Trace d'accès au coffre, SANS valeur.
// Liste blanche : seuls des champs d'identification de forme sûre passent ; tout le reste est écarté.
const IDENTIFIANT = /^[A-Za-z0-9._-]{1,64}$/;
const CHAMPS = ["evenement", "cellule", "tenantId", "instanceId", "executionId", "connexionId", "famille", "code"] as const;

export type Ecrire = (ligne: string) => void;
export interface Journal { tracer(evenement: Partial<Record<(typeof CHAMPS)[number], string>>): void }

export function creerJournal(ecrire: Ecrire): Journal {
  return {
    tracer(evenement) {
      const ligne: Record<string, string> = {};
      for (const champ of CHAMPS) {
        const v = evenement[champ];
        if (typeof v === "string" && IDENTIFIANT.test(v)) ligne[champ] = v;
      }
      ecrire(JSON.stringify(ligne));
    },
  };
}
