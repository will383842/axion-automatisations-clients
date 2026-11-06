import { exigerAucunGel } from "../gel/garde.js";
import type { GelLitige } from "../retention/purger.js";
import { ErreurEtape, type LigneBase } from "../provisionnement/machine.js";
import type { EtapeFin } from "./machine.js";

// Base gelée (A-254) : bases_client.etat = gelee. Le service des données (T2-37) et le courtier (T2-36) refusent déjà toute base non active ; les automatisations sont en pause ;
// le fait C3 `contrat.resilie` part (intention stable). Rien n'est supprimé : les données restent, seul l'accès est fermé.
const GELEES: readonly LigneBase["etat"][] = ["gelee", "exportee", "a_l_ecart", "effacee"];
export interface PortsGeler {
  etatBase(tenantId: string): Promise<LigneBase["etat"] | undefined>;
  // UPDATE … SET etat = 'gelee' WHERE etat = 'active' : sans effet si la base n'est plus active.
  geler(tenantId: string): Promise<void>;
  pauserInstances(tenantId: string): Promise<void>;
  instancesActives(tenantId: string): Promise<number>;
  emettreResilie(tenantId: string, dateFin: string): Promise<void>;
  gel: Pick<GelLitige, "gelActif">;
}
export function etapeGeler(d: PortsGeler): EtapeFin {
  return {
    nom: "geler_base",
    dejaFait: async (t) => {
      const etat = await d.etatBase(t);
      return etat !== undefined && GELEES.includes(etat) && (await d.instancesActives(t)) === 0;
    },
    async faire(t, dossier) {
      await exigerAucunGel(d.gel, t, "preavis");
      const etat = await d.etatBase(t);
      if (etat === undefined || (etat !== "active" && !GELEES.includes(etat))) throw new ErreurEtape("base_non_active");
      // Ordre pensé pour le rejeu : le fait C3 et la pause d'abord, la bascule de la base en dernier (c'est elle que lit dejaFait).
      await d.emettreResilie(t, dossier.dateFin);
      await d.pauserInstances(t);
      if (etat === "active") await d.geler(t);
    },
  };
}
