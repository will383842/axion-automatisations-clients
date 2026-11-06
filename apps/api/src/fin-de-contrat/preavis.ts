import { exigerAucunGel } from "../gel/garde.js";
import type { GelLitige } from "../retention/purger.js";
import { createHash } from "node:crypto";
import { echeance, TOLERANCE_RETARD_MS, type EtapeFin, type JourPreavis, type Preavis } from "./machine.js";

// Export (T2-42) et préavis (A-255). Un préavis est « envoyé » dès que son e-mail de service est déposé ; il n'est « prouvé » qu'avec l'accusé du client.
export type EtatPreuve = "non_envoye" | "envoye_sans_accuse" | "prouve";
export const etatPreuve = (p: Preavis): EtatPreuve => (p.envoyeLe === null ? "non_envoye" : p.accuse?.trim().startsWith("recu:") ? "prouve" : "envoye_sans_accuse");

// Identifiant de demande d'export STABLE par client et date de fin (forme d'UUID) : un export rejoué ou lancé deux fois écrit la même demande, jamais une seconde.
export function demandeExportFin(tenantId: string, dateFin: string): string {
  const h = createHash("sha256").update(`export-fin:${tenantId}:${dateFin}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export interface PortsExporter {
  // Export de T2-42 (motif fin_de_contrat), valable 30 jours, sous la demande stable : le même appel rejoué rend le même export.
  lancer(tenantId: string, demande: string): Promise<{ reference: string; expireLe: Date }>;
  // La première référence gagne : UPDATE … SET export_reference = $ref WHERE export_reference IS NULL.
  enregistrer(tenantId: string, reference: string, expireLe: Date): Promise<void>;
  gel: Pick<GelLitige, "gelActif">;
}
export function etapeExporter(d: PortsExporter): EtapeFin {
  return {
    nom: "exporter",
    // Un export remet les données au client : suspendu par un gel pour litige.
    sousGel: true,
    // Minuit Europe/Paris de la date de fin : pas d'export des mois à l'avance.
    echeance: (dossier) => echeance(dossier.dateFin, 0),
    dejaFait: async (_t, dossier) => dossier.exportReference !== null,
    async faire(t, dossier) {
      await exigerAucunGel(d.gel, t, "preavis");
      const e = await d.lancer(t, demandeExportFin(t, dossier.dateFin));
      await d.enregistrer(t, e.reference, e.expireLe);
    },
  };
}

export interface PortsPreavis {
  envoyer(tenantId: string, jour: JourPreavis, dateFin: string): Promise<void>;
  // Première date gagne : UPDATE … SET preavis_jN_envoye_le = $quand WHERE preavis_jN_envoye_le IS NULL.
  marquer(tenantId: string, jour: JourPreavis, quand: Date): Promise<void>;
  // Tâche « relance téléphonique » dans la liste de l'équipe (alerte), clé stable par client et jour : jamais un appel automatique.
  relancer(tenantId: string, jour: JourPreavis): Promise<void>;
  gel: Pick<GelLitige, "gelActif">;
  maintenant(): Date;
}
export function etapePreavis(jour: JourPreavis, d: PortsPreavis): EtapeFin {
  return {
    nom: `preavis_j${jour}`,
    sousGel: true,
    echeance: (dossier) => echeance(dossier.dateFin, jour),
    // Trop en retard sur son échéance (panne, date erronée) : le préavis ne part pas, la machine lève une alerte.
    limite: (dossier) => new Date(echeance(dossier.dateFin, jour).getTime() + TOLERANCE_RETARD_MS),
    dejaFait: async (_t, dossier) => dossier.preavis[jour].envoyeLe !== null,
    async faire(t, dossier) {
      if (dossier.preavis[jour].envoyeLe !== null) return;
      await exigerAucunGel(d.gel, t, "preavis");
      // Dépôt, relance puis marque, dans cet ordre : chacun est sans effet s'il est rejoué, et la marque (lue par dejaFait) vient en dernier.
      await d.envoyer(t, jour, dossier.dateFin);
      if (jour !== 1 && dossier.exportTelechargeLe === null) await d.relancer(t, jour);
      await d.marquer(t, jour, d.maintenant());
    },
  };
}
