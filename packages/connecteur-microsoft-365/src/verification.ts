import type { JetonCourt } from "@axion-auto/connecteurs-commun";
import type { ClientGraph } from "./graph.ts";

export type Verification = "trouve" | "absent" | "indetermine";

// Graph n'a pas de clé anti-doublon : avant tout renvoi, on cherche le message dans « Éléments envoyés ».
// Toute erreur ou réponse inattendue est « indetermine » : jamais « absent », qui autoriserait un renvoi.
export async function verifierApresCoup(graph: ClientGraph, jeton: JetonCourt, messageId: string): Promise<Verification> {
  try {
    const filtre = encodeURIComponent(`internetMessageId eq '${messageId.replaceAll("'", "''")}'`);
    const reponse = await graph.requete(jeton, "GET", `/me/mailFolders/SentItems/messages?$filter=${filtre}&$select=id`);
    const trouves = (reponse as { value?: unknown } | undefined)?.value;
    if (!Array.isArray(trouves)) return "indetermine";
    return trouves.length > 0 ? "trouve" : "absent";
  } catch {
    return "indetermine";
  }
}
