import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StatutConsole } from "../crm/statuts.ts";

// Liste des clients de la console (T3-10). Sans base : le dépôt des lignes est un port (adaptateur PostgreSQL = dette T3-10-dette-adaptateur).
export const FORMULES = ["abonnement", "achat", "installation_maintenance"] as const;
export const SANTES = ["vert", "orange", "rouge"] as const;
export const STATUTS = ["prospect", "en_signature", "client", "ancien_client"] as const;
export type Formule = (typeof FORMULES)[number];
export interface LigneClient { id: string; nom: string; formule: Formule; sante: (typeof SANTES)[number]; statut: StatutConsole; apporteur: string | null; modeleIa: string | null; metier: string | null }

export const LIBELLE_FORMULE: Readonly<Record<Formule, string>> = { abonnement: "Abonnement", achat: "Achat", installation_maintenance: "Installation et maintenance" };

// Liste FERMÉE de filtres : toute autre clé est refusée (aucun paramètre n'ajoute une colonne ni un champ).
export const SchemaFiltres = z.strictObject({
  q: z.string().trim().max(100).optional(),
  formule: z.enum(FORMULES).optional(),
  sante: z.enum(SANTES).optional(),
  statut: z.enum(STATUTS).optional(),
  apporteur: z.string().max(100).optional(),
  modele_ia: z.string().max(128).optional(),
  metier: z.string().max(100).optional(),
});
export type FiltresClients = z.infer<typeof SchemaFiltres>;

// B-320 (V1, abonnement seul) : vue prête, commune à tous, jamais écrite en base.
export const VUE_PRETE_ABONNEMENTS = { id: "mes-abonnements", nom: "Mes abonnements", filtres: { formule: "abonnement" } as FiltresClients };

const norme = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const ordre = (a: LigneClient, b: LigneClient) => (a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function filtrerClients(lignes: readonly LigneClient[], f: FiltresClients): LigneClient[] {
  const mot = f.q ? norme(f.q) : "";
  return lignes
    .filter((l) =>
      (!mot || [l.nom, l.apporteur, l.metier].some((t) => t !== null && norme(t).includes(mot)))
      && (!f.formule || l.formule === f.formule) && (!f.sante || l.sante === f.sante) && (!f.statut || l.statut === f.statut)
      && (!f.apporteur || l.apporteur === f.apporteur) && (!f.modele_ia || l.modeleIa === f.modele_ia) && (!f.metier || l.metier === f.metier))
    .sort(ordre);
}

// Curseur opaque = dernière ligne vue (nom, id) : jamais un décalage (B-175).
export function paginer(lignes: readonly LigneClient[], curseur: string | undefined, taille: number): { lignes: LigneClient[]; curseurSuivant: string | null } {
  let debut = 0;
  if (curseur !== undefined) {
    let c: unknown;
    try { c = JSON.parse(Buffer.from(curseur, "base64url").toString("utf8")); } catch { c = null; }
    const { nom, id } = (c ?? {}) as { nom?: unknown; id?: unknown };
    if (typeof nom !== "string" || typeof id !== "string") throw new Error("curseur invalide");
    debut = lignes.findIndex((l) => ordre(l, { id, nom } as LigneClient) > 0);
    if (debut < 0) debut = lignes.length;
  }
  const page = lignes.slice(debut, debut + taille);
  const dernier = page.at(-1);
  const suite = dernier !== undefined && debut + taille < lignes.length;
  return { lignes: page, curseurSuivant: suite ? Buffer.from(JSON.stringify({ nom: dernier.nom, id: dernier.id })).toString("base64url") : null };
}

export const versDto = (l: LigneClient) => ({ id: l.id, nom: l.nom, formule: l.formule, badge_formule: LIBELLE_FORMULE[l.formule], sante: l.sante, statut: l.statut, apporteur: l.apporteur, modele_ia: l.modeleIa, metier: l.metier });

// Vues enregistrées (table vues_enregistrees de T3-05, écran « clients »). Non partagées : chaque lecture passe par le sujet du membre.
export interface VueEnregistree { id: string; nom: string; filtres: FiltresClients }
export interface DepotVues {
  lister(sujet: string): Promise<VueEnregistree[]>;
  creer(sujet: string, v: { nom: string; filtres: FiltresClients }): Promise<VueEnregistree>;
  lire(sujet: string, id: string): Promise<VueEnregistree | undefined>;
}
export function depotVuesEnMemoire(): DepotVues {
  const parSujet = new Map<string, VueEnregistree[]>();
  return {
    async lister(s) { return [...(parSujet.get(s) ?? [])]; },
    async lire(s, id) { return (parSujet.get(s) ?? []).find((v) => v.id === id); },
    // Même nom pour un même membre : la vue est remplacée (contrainte d'unicité de la table).
    async creer(s, v) {
      const vue = { id: randomUUID(), ...v };
      parSujet.set(s, [...(parSujet.get(s) ?? []).filter((x) => x.nom !== v.nom), vue]);
      return vue;
    },
  };
}
