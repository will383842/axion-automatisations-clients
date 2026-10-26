import { ErreurConnecteur, type Champ, type MessageLu, type MessageSortant } from "@axion-auto/connecteurs-commun";

export const ENTETE_INTENTION = "X-Axion-Intention";

const CHAMP_GRAPH: Record<Champ, string> = { expediteur: "from", objet: "subject", corps: "body", date: "receivedDateTime", etiquettes: "categories" };

type Brut = Record<string, unknown> & { from?: { emailAddress?: { address?: string } }; body?: { content?: string } };

export function selection(champs: Champ[]): string {
  return champs.map((c) => CHAMP_GRAPH[c] ?? ((): never => { throw new ErreurConnecteur("definitive", "champ_inconnu"); })()).join(",");
}

// Ne rend que les champs demandés ; un champ que Graph n'a pas renvoyé est une erreur, jamais une valeur vide.
export function versMessageLu(brut: unknown, id: string, champs: Champ[]): MessageLu {
  if (typeof brut !== "object" || brut === null) throw new ErreurConnecteur("definitive", "reponse_inattendue");
  const b = brut as Brut;
  const valeurs: Record<Champ, unknown> = { expediteur: b.from?.emailAddress?.address, objet: b["subject"], corps: b.body?.content, date: b["receivedDateTime"], etiquettes: b["categories"] };
  const sortie: Record<string, unknown> = { id };
  for (const c of champs) {
    if (valeurs[c] === undefined || valeurs[c] === null) throw new ErreurConnecteur("definitive", "champ_absent");
    sortie[c] = valeurs[c];
  }
  return sortie as MessageLu;
}

// Le Message-ID choisi et l'intention sont posés dès la création : c'est ce qui permet de chercher le message après coup.
export const versBrouillon = (m: MessageSortant) => ({
  subject: m.objet,
  body: { contentType: "text", content: m.corps },
  toRecipients: [{ emailAddress: { address: m.destinataire } }],
  internetMessageId: m.messageId,
  internetMessageHeaders: [{ name: ENTETE_INTENTION, value: m.messageId }],
});
