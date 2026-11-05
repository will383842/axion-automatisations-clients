import { nomBaseDe } from "../provisionnement/etapes-base.js";
import type { Restauration } from "./restaurer-client.js";

// Bascule d'une restauration (T2-40, B-041, C-048) : DEUX confirmations, chacune avec sa propre réauthentification (jeton à usage unique, T1A-08),
// par la même personne ou par deux personnes. L'ancienne base est renommée « cli_<id>_avant_<n> » et gardée : jamais supprimée ici.
// La console ne rejoue rien après la bascule (C-474) : ce module ne touche ni à la boîte d'envoi ni au Hub.

export interface Acteur {
  id: string;
  /** Faux pour un utilisateur de client. */
  equipe: boolean;
  /** Jeton de la réauthentification qui précède cette confirmation ; il ne sert qu'une fois. */
  reauthJeton: string;
}
export interface Confirmation {
  acteurId: string;
  reauthJeton: string;
}
export interface PortsBascule {
  lire(tenantId: string, id: string): Promise<(Restauration & { confirmations: Confirmation[]; basculee: boolean }) | undefined>;
  ajouterConfirmation(tenantId: string, id: string, c: Confirmation): Promise<void>;
  marquerBasculee(tenantId: string, id: string): Promise<void>;
  /** PgBouncer : PAUSE de cette base (le renommage exige qu'aucune connexion ne soit ouverte), puis RESUME. */
  pauser(nomBase: string): Promise<void>;
  reprendre(nomBase: string): Promise<void>;
  renommer(de: string, vers: string): Promise<void>;
  journaliser(evenement: "confirmation_posee" | "bascule_faite" | "bascule_echouee", tenantId: string, id: string): Promise<void>;
}

const NECESSAIRES = 2;

export async function confirmerBascule(p: PortsBascule, tenantId: string, id: string, acteur: Acteur): Promise<{ confirmations: number; basculee: boolean }> {
  if (!acteur.equipe) throw new Error("action_interdite");
  const r = await p.lire(tenantId, id);
  if (!r) throw new Error("restauration_introuvable");
  if (r.basculee) throw new Error("deja_basculee");
  if (r.confirmations.some((c) => c.reauthJeton === acteur.reauthJeton)) throw new Error("reauthentification_requise");
  await p.ajouterConfirmation(tenantId, id, { acteurId: acteur.id, reauthJeton: acteur.reauthJeton });
  await p.journaliser("confirmation_posee", tenantId, id);
  const n = r.confirmations.length + 1;
  if (n < NECESSAIRES) return { confirmations: n, basculee: false };
  await basculer(p, tenantId, id);
  return { confirmations: n, basculee: true };
}

export async function basculer(p: PortsBascule, tenantId: string, id: string): Promise<void> {
  const r = await p.lire(tenantId, id);
  if (!r) throw new Error("restauration_introuvable");
  if (r.basculee) throw new Error("deja_basculee");
  if (r.confirmations.length < NECESSAIRES) throw new Error("confirmation_manquante");
  const cible = nomBaseDe(tenantId);
  const avant = `${cible}_avant_${r.numero}`;
  let ancienneRenommee = false;
  await p.pauser(cible);
  try {
    await p.renommer(cible, avant);
    ancienneRenommee = true;
    await p.renommer(r.nomBase, cible);
    await p.marquerBasculee(tenantId, id);
  } catch (e) {
    if (ancienneRenommee) await p.renommer(avant, cible);
    await p.journaliser("bascule_echouee", tenantId, id);
    throw e;
  } finally {
    await p.reprendre(cible);
  }
  await p.journaliser("bascule_faite", tenantId, id);
}
