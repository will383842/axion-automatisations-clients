import { ErreurApi } from "../plugins/erreurs.js";
import { autorise } from "./matrice.js";
import type { MembreDroits } from "./exiger-droit.js";

// Absence de Will (C-617). Annoncée : par Will (début, fin). Constatée : ouverte par le second administrateur avec un motif, Will alerté tout de suite ; fermée par Will seul.
// Les droits en plus (matrice.ts) ne valent que pendant une absence EN COURS, relue à chaque requête ; jamais l'argent.
export interface AbsenceEnregistree { id: string; nature: "annoncee" | "constatee"; debut: Date; fin: Date | null; ouvertePar: string; fermeePar: string | null }
export interface DepsAbsence {
  maintenant(): Date;
  ouverte(): Promise<AbsenceEnregistree | undefined>;
  creer(a: Omit<AbsenceEnregistree, "id">): Promise<AbsenceEnregistree>;
  fermer(id: string, par: string): Promise<void>;
  // E-mail à Will par la table des envois (service) ; le motif part dans la trace du journal, jamais dans le message.
  alerterDirigeant(m: { type: "absence_constatee"; ouvertePar: string }): Promise<void>;
  tracer(e: { evenement: "absence_constatee" | "absence_annoncee" | "absence_fermee"; sujet: string; motif?: string }): Promise<void>;
}

export function absenceEnCours(a: AbsenceEnregistree | undefined, maintenant: Date): boolean {
  return a !== undefined && a.debut <= maintenant && (a.fin === null || a.fin > maintenant);
}
const interdit = () => new ErreurApi("action_interdite", "Action non permise.");

export function creerServiceAbsence(d: DepsAbsence) {
  return {
    async annoncer(acteur: MembreDroits, debut: Date, fin: Date): Promise<AbsenceEnregistree> {
      if (acteur.role !== "dirigeant" || !acteur.actif) throw interdit();
      if (!(fin > debut)) throw new ErreurApi("schema_invalide", "Requête invalide.");
      if (await d.ouverte()) throw new ErreurApi("regle_metier", "Une absence est déjà ouverte.");
      const a = await d.creer({ nature: "annoncee", debut, fin, ouvertePar: acteur.sujet, fermeePar: null });
      await d.tracer({ evenement: "absence_annoncee", sujet: acteur.sujet });
      return a;
    },
    async constater(acteur: MembreDroits, motif: string): Promise<AbsenceEnregistree> {
      if (acteur.role !== "second_administrateur" || !acteur.actif) throw interdit();
      const m = motif.trim();
      if (m.length < 1 || m.length > 500) throw new ErreurApi("schema_invalide", "Requête invalide.");
      if (await d.ouverte()) throw new ErreurApi("regle_metier", "Une absence est déjà ouverte.");
      // L'alerte part AVANT l'ouverture : si elle échoue, rien n'est ouvert (aucun droit en plus sans que Will soit prévenu).
      await d.alerterDirigeant({ type: "absence_constatee", ouvertePar: acteur.sujet });
      const a = await d.creer({ nature: "constatee", debut: d.maintenant(), fin: null, ouvertePar: acteur.sujet, fermeePar: null });
      await d.tracer({ evenement: "absence_constatee", sujet: acteur.sujet, motif: m });
      return a;
    },
    async fermer(acteur: MembreDroits, id: string): Promise<void> {
      if (!autorise(acteur.role, "utilisateurs_roles") || !acteur.actif) throw interdit();
      const o = await d.ouverte();
      if (!o || o.id !== id) throw new ErreurApi("introuvable", "Ressource introuvable.");
      await d.fermer(id, acteur.sujet);
      await d.tracer({ evenement: "absence_fermee", sujet: acteur.sujet });
    },
  };
}
