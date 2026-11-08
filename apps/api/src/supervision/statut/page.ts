import { ErreurApi } from "../../plugins/erreurs.js";
import { COMPOSANTS_PUBLICS, estComposantPublic, etatsComposants, pire, type ComposantPublic, type EtatBrique, type EtatComposant } from "./composants.js";

export const TYPES_MESSAGE = ["incident", "maintenance"] as const;
export const TEXTE_MAX = 280;
export interface MessageStatut { type: (typeof TYPES_MESSAGE)[number]; texte: string }
// Incident tel que le fournit la supervision (T5-08) : le titre et l'identifiant restent internes, la page ne les lit jamais.
export interface Incident { id: string; gravite: "critique" | "majeure" | "mineure"; debut: string; composant?: string; titre?: string }
export interface DepotStatut {
  lire(): Promise<MessageStatut | null>;
  ecrire(m: MessageStatut): Promise<void>;
}
export interface PagePublique {
  composants: Array<{ nom: ComposantPublic; etat: EtatComposant }>;
  message: MessageStatut | null;
  incidents: Array<{ composant: ComposantPublic; debut: string; gravite: Incident["gravite"] }>;
}

// Le message est écrit par l'équipe puis publié : on refuse tout ce qui ressemble à une adresse IP ou à un hôte interne.
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const HOTE_INTERNE = /\b[\w-]+(?:\.[\w-]+)*\.(?:interne|internal|local|lan|test|corp)\b/i;
export function validerMessage(corps: unknown): MessageStatut {
  const c = corps as { type?: unknown; texte?: unknown } | null;
  if (typeof c !== "object" || c === null || Object.keys(c).sort().join() !== "texte,type") throw new ErreurApi("schema_invalide", "Message invalide.");
  if (!(TYPES_MESSAGE as readonly unknown[]).includes(c.type) || typeof c.texte !== "string") throw new ErreurApi("schema_invalide", "Message invalide.");
  const texte = c.texte.trim();
  if (texte.length === 0 || texte.length > TEXTE_MAX || IPV4.test(texte) || HOTE_INTERNE.test(texte)) throw new ErreurApi("schema_invalide", "Message invalide.");
  return { type: c.type as MessageStatut["type"], texte };
}

export function construirePage(briques: Readonly<Record<string, EtatBrique>>, incidents: readonly Incident[], message: MessageStatut | null): PagePublique {
  const etats = etatsComposants(briques);
  // Un incident sans composant public (brique interne, composant inconnu) n'est PAS publié : ni son heure de début ni sa gravité ne sortent.
  const visibles: PagePublique["incidents"] = [];
  for (const i of incidents) {
    if (!estComposantPublic(i.composant)) continue;
    visibles.push({ composant: i.composant, debut: i.debut, gravite: i.gravite });
    etats[i.composant] = pire(etats[i.composant], i.gravite === "critique" ? "panne" : "degrade");
  }
  return { composants: COMPOSANTS_PUBLICS.map((nom) => ({ nom, etat: etats[nom] })), message, incidents: visibles };
}
