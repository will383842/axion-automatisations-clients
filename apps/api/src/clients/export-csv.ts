import { createHash } from "node:crypto";
import type { LigneClient } from "./liste.ts";

// Colonnes de la liste SEULEMENT : aucun secret, aucun contenu de base client, aucune colonne choisie par la requête.
export const COLONNES_CSV = ["id", "nom", "formule", "sante", "statut", "apporteur", "modele_ia", "metier"] as const;

// Une cellule qui commence par = + - @ tabulation ou retour chariot serait lue comme une formule : on la préfixe d'une apostrophe.
export const neutraliser = (v: string): string => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const cellule = (v: string | null) => `"${neutraliser(v ?? "").replaceAll('"', '""')}"`;

export function versCsv(lignes: readonly LigneClient[]): string {
  const corps = lignes.map((l) => [l.id, l.nom, l.formule, l.sante, l.statut, l.apporteur, l.modeleIa, l.metier].map(cellule).join(","));
  return [COLONNES_CSV.join(","), ...corps].join("\r\n") + "\r\n";
}
export const empreinteCsv = (csv: string): string => createHash("sha256").update(csv).digest("hex");
