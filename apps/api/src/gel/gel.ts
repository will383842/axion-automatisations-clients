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
  ajouter(gel: Gel): Promise<void>;
  // Met la date et l'auteur de levée d'un gel de CE client ; null si le gel n'existe pas chez ce client. Ne supprime rien.
  lever(tenantId: string, idGel: string, quand: Date, par: string): Promise<Gel | null>;
  lister(tenantId: string): Promise<Gel[]>;
}
// Session de l'équipe : rien de ceci ne vient de l'URL ni du corps.
export interface SessionEquipe {
  acteur: string;
  role: string;
  organisationId: string;
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
// Implémentation réelle pour la rétention (T2-11) : `estReel` vrai, l'interrupteur de purge peut s'ouvrir.
export function gelReel(depot: DepotGels): GelLitige {
  return { estReel: true, gelActif: (tenantId) => gelActif(depot, tenantId) };
}

function exigerDroit(s: SessionEquipe, tenantId: string): string {
  if (s.role !== "administrateur") throw new ErreurApi("action_interdite", "Action réservée à l'administrateur.");
  if (!s.reauthentifie) throw new ErreurApi("reauthentification_requise", "Reconnectez-vous pour continuer.");
  // Le client de l'URL doit être celui de la session de l'équipe.
  if (s.organisationId !== tenantId) throw new ErreurApi("action_interdite", "Client différent de la session.");
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

export async function poserGel(d: DepsGel, s: SessionEquipe, tenantId: string, motif: string, poseeLe?: Date): Promise<Gel> {
  const par = exigerDroit(s, tenantId);
  const m = motifNonVide(motif);
  const maintenant = d.maintenant();
  const quand = poseeLe ?? maintenant;
  if (!Number.isFinite(quand.getTime()) || quand.getTime() > maintenant.getTime()) throw new ErreurApi("schema_invalide", "Requête invalide.");
  if ((await d.depot.lister(tenantId)).some((g) => g.leveeLe === null && g.motif === m)) throw new ErreurApi("regle_metier", "Ce gel est déjà posé.");
  const gel: Gel = { id: d.nouvelId(), tenantId, motif: m, poseeLe: quand, poseePar: par, leveeLe: null, levePar: null };
  await d.depot.ajouter(gel);
  await avertir(d, "avis_gel_pose", gel);
  return gel;
}

// Le motif de levée est exigé mais la table n'a pas de colonne pour lui (dette LOT2-dette-T2-43-motif-levee).
export async function leverGel(d: DepsGel, s: SessionEquipe, tenantId: string, idGel: string, motif: string): Promise<Gel> {
  const par = exigerDroit(s, tenantId);
  motifNonVide(motif);
  const existant = (await d.depot.lister(tenantId)).find((g) => g.id === idGel);
  if (!existant) throw new ErreurApi("introuvable", "Ressource introuvable.");
  if (existant.leveeLe !== null) throw new ErreurApi("regle_metier", "Ce gel est déjà levé.");
  const gel = await d.depot.lever(tenantId, idGel, d.maintenant(), par);
  if (!gel) throw new ErreurApi("introuvable", "Ressource introuvable.");
  await avertir(d, "avis_gel_leve", gel);
  return gel;
}
