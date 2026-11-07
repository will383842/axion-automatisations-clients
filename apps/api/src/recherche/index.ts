import { PLATEFORME_ID } from "../db/schema/aides.js";
import type { MembrePortee } from "../droits/portee.js";
import { TOUS_LES_CLIENTS } from "../droits/portee.js";

// Recherche globale de la console (T3-09a, ADR 0133) : un registre FERMÉ de sources, un terme normalisé, une portée tirée du membre seulement.
// T3-40 ajoutera ses sources (automatisation, préréglage) : UNE entrée chacune dans SOURCES, avec sa requête dans depot-sql.ts.
export const SOURCES = ["client", "contact", "facture", "demande", "instance"] as const;
export type TypeResultat = (typeof SOURCES)[number];

export type LigneRecherche =
  | { type: "client"; id: string; client_id: string; libelle: string; statut: string }
  | { type: "contact"; id: string; client_id: string; client_nom: string; libelle: string; email: string; role: string }
  | { type: "facture"; id: string; client_id: string; client_nom: string; libelle: string; statut: string; periode_debut: string; periode_fin: string }
  | { type: "demande"; id: string; client_id: string; client_nom: string; libelle: string; statut: string; cree_le: string }
  | { type: "instance"; id: string; client_id: string; client_nom: string; libelle: string; automatisation_nom: string | null; etat: string };

export interface PorteeRecherche { tous: boolean; clients: string[] }
// Tout ce que le dépôt reçoit : jamais de requête brute. `motif` et `debut` sont déjà échappés pour LIKE (clause ESCAPE).
export interface ParametresRecherche extends PorteeRecherche {
  terme: string;
  motif: string;
  debut: string;
  siren: string | null;
  idDemande: string | null;
  limite: number;
}
// Le dépôt rend les lignes des cinq sources (chacune au plus `limite`), la portée et la plateforme étant appliquées AVANT la limite.
export interface DepotRecherche { chercher(p: ParametresRecherche): Promise<LigneRecherche[]> }

export const MOTIF_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Même classe que client-actif.ts (CONTROLE).
const PLAGES_INVISIBLES: [number, number][] = [[0x200b, 0x200f], [0x202a, 0x202e], [0x2028, 0x2029], [0x2060, 0x206f], [0xfeff, 0xfeff], [0x061c, 0x061c], [0x180e, 0x180e], [0x00ad, 0x00ad], [0x3164, 0x3164]];
export const CONTROLE = new RegExp(`[\\p{Cc}${PLAGES_INVISIBLES.map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join("")}]`, "u");
export const TERME_MIN = 2;
export const TERME_MAX = 100;

// Terme : NFC, espaces de bord retirés, espaces multiples réduits à un ; 2 à 100 caractères ; aucun caractère de contrôle. Refus = undefined (la valeur n'est jamais reprise).
export function normaliserTerme(brut: string): string | undefined {
  if (CONTROLE.test(brut)) return undefined;
  const terme = brut.normalize("NFC").trim().replace(/ {2,}/g, " ");
  const longueur = [...terme].length;
  return longueur < TERME_MIN || longueur > TERME_MAX ? undefined : terme;
}

// Barre oblique inverse d'abord, puis pourcent et souligné.
export const echapperLike = (texte: string): string => texte.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

// La portée ne vient JAMAIS de la requête. « * » = tous les clients ; sinon les seuls identifiants au motif UUID, dédoublonnés. Liste vide ou rôle inconnu = rien (échec fermé).
export function porteeDe(m: MembrePortee): PorteeRecherche {
  if (m.role === "dirigeant") return { tous: true, clients: [] };
  if (m.role !== "second_administrateur") return { tous: false, clients: [] };
  if (m.portee.clients.includes(TOUS_LES_CLIENTS)) return { tous: true, clients: [] };
  const clients = new Set<string>();
  for (const c of m.portee.clients) if (typeof c === "string" && MOTIF_UUID.test(c)) clients.add(c.toLowerCase());
  return { tous: false, clients: [...clients] };
}

// Liste blanche, champ par champ : un champ en trop du dépôt (montant, texte de référence) ne sort jamais.
export function versResultat(l: LigneRecherche): LigneRecherche {
  switch (l.type) {
    case "client": return { type: l.type, id: l.id, client_id: l.client_id, libelle: l.libelle, statut: l.statut };
    case "contact": return { type: l.type, id: l.id, client_id: l.client_id, client_nom: l.client_nom, libelle: l.libelle, email: l.email, role: l.role };
    case "facture": return { type: l.type, id: l.id, client_id: l.client_id, client_nom: l.client_nom, libelle: l.libelle, statut: l.statut, periode_debut: l.periode_debut, periode_fin: l.periode_fin };
    case "demande": return { type: l.type, id: l.id, client_id: l.client_id, client_nom: l.client_nom, libelle: l.libelle, statut: l.statut, cree_le: l.cree_le };
    case "instance": return { type: l.type, id: l.id, client_id: l.client_id, client_nom: l.client_nom, libelle: l.libelle, automatisation_nom: l.automatisation_nom, etat: l.etat };
  }
}

export interface ReponseRecherche { groupes: { type: TypeResultat; resultats: LigneRecherche[] }[] }
const vide = (): ReponseRecherche => ({ groupes: SOURCES.map((type) => ({ type, resultats: [] })) });

// `ecart` reçoit le type d'une ligne hors portée rendue par erreur (anomalie, sans aucune valeur).
export async function rechercher(depot: DepotRecherche, membre: MembrePortee, terme: string, limite: number, ecart?: (type: string) => void): Promise<ReponseRecherche> {
  const portee = porteeDe(membre);
  const reponse = vide();
  if (!portee.tous && portee.clients.length === 0) return reponse;
  const echappe = echapperLike(terme);
  const lignes = await depot.chercher({
    ...portee,
    terme,
    motif: `%${echappe}%`,
    debut: `${echappe}%`,
    siren: /^[0-9]{9}$/.test(terme) ? terme : null,
    idDemande: MOTIF_UUID.test(terme) ? terme.toLowerCase() : null,
    limite,
  });
  for (const ligne of lignes) {
    // Ceinture : la portée est déjà dans le WHERE ; une ligne qui passerait quand même est écartée.
    if (ligne.client_id === PLATEFORME_ID || !(portee.tous || portee.clients.includes(ligne.client_id))) { ecart?.(ligne.type); continue; }
    const groupe = reponse.groupes.find((g) => g.type === ligne.type);
    if (groupe && groupe.resultats.length < limite) groupe.resultats.push(versResultat(ligne));
  }
  return reponse;
}
