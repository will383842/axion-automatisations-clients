import { validerTenant } from "../coffre/coffre.js";
import type { Alertes } from "../alertes/port.js";

// Surveillance de la dépense d'IA (C-598 c, e) : une clé volée qui boucle dépense bien plus vite que d'habitude.
// Au-delà du seuil : alerte soupcon_acces_non_autorise (identifiant du client seulement, jamais son nom), puis blocage de la clé.

export type CodeSurveillance = "tenant_invalide" | "mesure_invalide" | "alerte_impossible" | "blocage_impossible";

export class ErreurSurveillance extends Error {
  constructor(readonly code: CodeSurveillance) {
    super(code);
    this.name = "ErreurSurveillance";
  }
}

export interface SourceDepense {
  depenseDerniereHeure(tenantId: string): Promise<number>;
  rythmeHabituel(tenantId: string): Promise<number>;
}

export interface OptionsSurveillance {
  source: SourceDepense;
  alertes: Alertes;
  bloquerCle: (tenantId: string, motif: string) => Promise<void>;
  seuil: number;
  plafondCle: number;
}

const HEURES_PAR_MOIS = 720;
const mesure = (n: unknown): number => {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new ErreurSurveillance("mesure_invalide");
  return n;
};

export function creerSurveillance(o: OptionsSurveillance) {
  return {
    async verifier(tenantId: string): Promise<"normal" | "alerte"> {
      try {
        validerTenant(tenantId);
      } catch {
        throw new ErreurSurveillance("tenant_invalide");
      }
      const derniere = mesure(await o.source.depenseDerniereHeure(tenantId));
      const habituel = mesure(await o.source.rythmeHabituel(tenantId));
      // Client neuf ou rythme nul : le plafond lissé sur le mois sert de référence. Le seuil ne dépasse jamais le plafond de la clé.
      const reference = Math.max(habituel, o.plafondCle / HEURES_PAR_MOIS);
      if (derniere <= Math.min(o.seuil * reference, o.plafondCle)) return "normal";
      let alerteEnvoyee = true;
      try {
        await o.alertes.envoyer({ type: "soupcon_acces_non_autorise", clientId: tenantId });
      } catch {
        alerteEnvoyee = false; // le blocage ne dépend pas de l'alerte
      }
      try {
        await o.bloquerCle(tenantId, "rythme de dépense anormal");
      } catch {
        throw new ErreurSurveillance("blocage_impossible");
      }
      if (!alerteEnvoyee) throw new ErreurSurveillance("alerte_impossible");
      return "alerte";
    },
  };
}
