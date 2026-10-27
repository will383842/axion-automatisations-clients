import type { JetonCourt } from "@axion-auto/connecteurs-commun";
import type { ClientGmail } from "./gmail.ts";

export type Verification = "trouve" | "absent" | "indetermine";

// Gmail n'a pas de clé anti-doublon : avant tout renvoi, on cherche le message dans « Envoyés » par son Message-ID.
// Toute erreur ou réponse inattendue est « indetermine » : jamais « absent », qui autoriserait un renvoi.
export async function verifierApresCoup(gmail: ClientGmail, jeton: JetonCourt, messageId: string): Promise<Verification> {
  try {
    const q = encodeURIComponent(`rfc822msgid:${messageId.replace(/^<|>$/g, "")} in:sent`);
    const reponse = (await gmail.requete(jeton, "GET", `/messages?q=${q}&maxResults=1`)) as { messages?: unknown; resultSizeEstimate?: unknown } | undefined;
    if (Array.isArray(reponse?.messages)) return reponse.messages.length > 0 ? "trouve" : "absent";
    return reponse?.messages === undefined && reponse?.resultSizeEstimate === 0 ? "absent" : "indetermine";
  } catch {
    return "indetermine";
  }
}
