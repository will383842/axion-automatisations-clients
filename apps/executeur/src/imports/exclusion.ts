import { empreinteEmail } from "@axion-auto/contrats/src/c3/evenements-crm-vers-console.ts";
import { ErreurImport, type Ligne } from "./lecteur.ts";

// Liste d'exclusion du client (désinscriptions comprises) ET liste de la plateforme (C-633) : une ligne exclue n'entre jamais.
export interface ListesExclusion {
  client(empreinte: string): Promise<boolean>;
  plateforme(empreinte: string): Promise<boolean>;
}
export type Verdict = "a_importer" | "exclue_client" | "exclue_plateforme";

// Email, E-mail, courriel : sans tenir compte de la casse, des accents ni des tirets.
const ENTETES_ADRESSE = new Set(["email", "courriel"]);
const normaliserEntete = (e: string): string => e.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Échec fermé : sans colonne d'adresse reconnue, le fichier est refusé, jamais importé sans contrôle d'exclusion.
function colonneAdresse(ligne: Ligne): string {
  const cle = Object.keys(ligne).find((k) => ENTETES_ADRESSE.has(normaliserEntete(k)));
  if (cle === undefined) throw new ErreurImport("colonne_adresse_absente");
  return cle;
}

export async function classerLigne(ligne: Ligne, listes: ListesExclusion): Promise<Verdict> {
  const email = (ligne[colonneAdresse(ligne)] ?? "").trim();
  if (!email) return "a_importer";
  const e = empreinteEmail(email);
  if (await listes.plateforme(e)) return "exclue_plateforme";
  if (await listes.client(e)) return "exclue_client";
  return "a_importer";
}
