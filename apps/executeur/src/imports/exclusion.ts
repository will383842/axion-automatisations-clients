import { empreinteEmail } from "@axion-auto/contrats/src/c3/evenements-crm-vers-console.ts";
import type { Ligne } from "./lecteur.ts";

// Liste d'exclusion du client (désinscriptions comprises) ET liste de la plateforme (C-633) : une ligne exclue n'entre jamais.
export interface ListesExclusion {
  client(empreinte: string): Promise<boolean>;
  plateforme(empreinte: string): Promise<boolean>;
}
export type Verdict = "a_importer" | "exclue_client" | "exclue_plateforme";

export async function classerLigne(ligne: Ligne, listes: ListesExclusion): Promise<Verdict> {
  const email = (ligne["email"] ?? "").trim();
  if (!email) return "a_importer";
  const e = empreinteEmail(email);
  if (await listes.plateforme(e)) return "exclue_plateforme";
  if (await listes.client(e)) return "exclue_client";
  return "a_importer";
}
