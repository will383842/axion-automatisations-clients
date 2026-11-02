import { ErreurApi } from "../plugins/erreurs.js";
import type { EnvoisService, TypeService } from "../envois/service.js";
import type { GelLitige } from "../retention/purger.js";

// Gel pour litige (C-609). La table gels_litige (T2-30) n'accepte ni suppression ni réécriture hors levée : le port non plus.
// Une levée met une date et un auteur, la ligne reste. Adaptateur SQL : dette (spec/preuves.md, LOT2-dette-T2-43-adaptateur).
export interface Gel {
  id: string;
  tenantId: string;
  motif: string;
  poseeLe: Date;
  poseePar: string;
  leveeLe: Date | null;
  levePar: string | null;
}
export interface DepotGels {
  // Vrai seulement pour l'adaptateur SQL (table gels_litige) ; faux pour la mémoire. Sert d'estReel à la rétention (T2-11).
  readonly persistant: boolean;
  // Adaptateur SQL : la pose et le retrait (dernière transaction d'une mise à l'écart ou d'un effacement) prennent le MÊME verrou par client
  // avant de relire gelActif (dette LOT2-dette-T2-43-adaptateur) ; l'avis est déposé dans la même transaction que le gel.
  ajouter(gel: Gel): Promise<void>;
  // Met la date et l'auteur de levée d'un gel de CE client ; null si le gel n'existe pas chez ce client. Ne supprime rien.
  lever(tenantId: string, idGel: string, quand: Date, par: string): Promise<Gel | null>;
  lister(tenantId: string): Promise<Gel[]>;
}
// Session de l'équipe : rien de ceci ne vient de l'URL ni du corps.
export interface SessionEquipe {
  acteur: string;
  role: string;
  // Le client (tenant) que l'équipe a ouvert ; comparé au client de l'URL. Rien à voir avec l'organisation d'AXION IA.
  clientActifId: string;
  reauthentifie: boolean;
}
export interface DepsGel {
  depot: DepotGels;
  envois: EnvoisService;
  maintenant(): Date;
  nouvelId(): string;
}

export function depotGelsEnMemoire(): DepotGels {
  const lignes: Gel[] = [];
  return {
    persistant: false,
    async ajouter(g) { lignes.push({ ...g }); },
    async lever(tenantId, idGel, quand, par) {
      const g = lignes.find((x) => x.tenantId === tenantId && x.id === idGel);
      if (!g) return null;
      if (g.leveeLe === null) Object.assign(g, { leveeLe: quand, levePar: par });
      return { ...g };
    },
    async lister(tenantId) { return lignes.filter((x) => x.tenantId === tenantId).map((x) => ({ ...x })); },
  };
}

// Vrai s'il existe un gel posé et non levé. Seule fonction consultée par les chemins qui retirent quelque chose.
export async function gelActif(depot: DepotGels, tenantId: string): Promise<boolean> {
  return (await depot.lister(tenantId)).some((g) => g.leveeLe === null);
}
// Pour la rétention (T2-11) : `estReel` suit le dépôt, faux en mémoire, donc l'interrupteur de purge ne s'ouvre pas sans adaptateur SQL.
export function gelReel(depot: DepotGels): GelLitige {
  return { estReel: depot.persistant, gelActif: (tenantId) => gelActif(depot, tenantId) };
}

function exigerDroit(s: SessionEquipe, tenantId: string): string {
  if (s.role !== "administrateur") throw new ErreurApi("action_interdite", "Action réservée à l'administrateur.");
  if (!s.reauthentifie) throw new ErreurApi("reauthentification_requise", "Reconnectez-vous pour continuer.");
  // Le client de l'URL doit être le client actif de la session de l'équipe.
  if (s.clientActifId !== tenantId) throw new ErreurApi("action_interdite", "Client différent de la session.");
  // Jamais de repli sur un acteur « systeme » : un gel a toujours une personne derrière.
  const acteur = s.acteur.trim();
  if (acteur === "" || acteur.toLowerCase() === "systeme") throw new ErreurApi("action_interdite", "Acteur identifié requis.");
  return acteur;
}
function motifNonVide(motif: string): string {
  const m = typeof motif === "string" ? motif.trim() : "";
  if (m === "" || m.length > 500) throw new ErreurApi("schema_invalide", "Requête invalide.");
  return m;
}
const avertir = (d: DepsGel, type: TypeService, g: Gel) => d.envois.deposerService({ type, clientId: g.tenantId, cle: `${type}:${g.tenantId}:${g.id}`, categorie: "service" });

// Une pose ne peut pas remonter au-delà de cette limite ; le début du contrat est une dette (LOT2-dette-T2-43-adaptateur).
const JOURS_MAX_ANTERIEUR = 366;
const JOUR_MS = 86_400_000;

// Reprise sûre : si le gel existe déjà avec le même motif, posé par la même personne, l'avis est redéposé (sans effet en double grâce à la clé)
// et le gel existant est renvoyé. Une autre personne est refusée.
export async function poserGel(d: DepsGel, s: SessionEquipe, tenantId: string, motif: string, poseeLe?: Date): Promise<Gel> {
  const par = exigerDroit(s, tenantId);
  const m = motifNonVide(motif);
  const maintenant = d.maintenant();
  const quand = poseeLe ?? maintenant;
  if (!Number.isFinite(quand.getTime()) || quand.getTime() > maintenant.getTime() || quand.getTime() < maintenant.getTime() - JOURS_MAX_ANTERIEUR * JOUR_MS) throw new ErreurApi("schema_invalide", "Requête invalide.");
  const actif = (await d.depot.lister(tenantId)).find((g) => g.leveeLe === null && g.motif === m);
  if (actif) {
    if (actif.poseePar !== par) throw new ErreurApi("regle_metier", "Ce gel est déjà posé.");
    await avertir(d, "avis_gel_pose", actif);
    return actif;
  }
  const gel: Gel = { id: d.nouvelId(), tenantId, motif: m, poseeLe: quand, poseePar: par, leveeLe: null, levePar: null };
  await d.depot.ajouter(gel);
  await avertir(d, "avis_gel_pose", gel);
  return gel;
}

// Le motif de levée est exigé mais la table n'a pas de colonne pour lui (dette LOT2-dette-T2-43-motif-levee).
// Reprise sûre : un gel déjà levé par la même personne voit son avis redéposé et est renvoyé ; une autre personne est refusée.
export async function leverGel(d: DepsGel, s: SessionEquipe, tenantId: string, idGel: string, motif: string): Promise<Gel> {
  const par = exigerDroit(s, tenantId);
  motifNonVide(motif);
  const existant = (await d.depot.lister(tenantId)).find((g) => g.id === idGel);
  if (!existant) throw new ErreurApi("introuvable", "Ressource introuvable.");
  if (existant.leveeLe !== null) {
    if (existant.levePar !== par) throw new ErreurApi("regle_metier", "Ce gel est déjà levé.");
    await avertir(d, "avis_gel_leve", existant);
    return existant;
  }
  const gel = await d.depot.lever(tenantId, idGel, d.maintenant(), par);
  if (!gel) throw new ErreurApi("introuvable", "Ressource introuvable.");
  await avertir(d, "avis_gel_leve", gel);
  return gel;
}
