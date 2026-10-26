import { ImapFlow } from "imapflow";
import { choisirPartieTexte, decoderCorps } from "./corps.ts";
import type { Dossier } from "./dossiers.ts";
import type { OptionsImap } from "./verification.ts";

export type MessageImap = { expediteur?: string; objet?: string; corps?: string; date?: string; etiquettes: string[] };

// Une connexion IMAP, à fermer avec fermer() à la fin de l'exécution (imapflow la garde ouverte sinon).
export interface SessionImap {
  dossiers(): Promise<Dossier[]>;
  selectionner(chemin: string): Promise<{ uidValidity: string }>;
  uidsApres(uid: number, limite: number): Promise<number[]>;
  lire(uid: number): Promise<MessageImap | null>;
  ajouterMotsCles(uid: number, mots: string[]): Promise<void>;
  chercherMessageId(messageId: string): Promise<number[]>;
  ajouter(chemin: string, source: Buffer, drapeaux: string[]): Promise<void>;
  fermer(): Promise<void>;
}

const tout = async (flux: AsyncIterable<Buffer | string>) => {
  const morceaux: Buffer[] = [];
  for await (const m of flux) morceaux.push(Buffer.from(m));
  return morceaux;
};

export async function ouvrirSessionImap(options: OptionsImap): Promise<SessionImap> {
  const client = new ImapFlow(options);
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch (e) {
    client.close();
    throw e;
  }
  const uids = async (requete: Parameters<ImapFlow["search"]>[0]) => (await client.search(requete, { uid: true })) || [];
  return {
    dossiers: async () => (await client.list()).map((d) => ({ chemin: d.path, ...(d.specialUse ? { usageSpecial: d.specialUse } : {}) })),
    selectionner: async (chemin) => ({ uidValidity: String((await client.mailboxOpen(chemin)).uidValidity) }),
    // « N:* » renvoie toujours le dernier message, même plus ancien que N : on filtre.
    uidsApres: async (uid, limite) => (await uids({ uid: `${uid + 1}:*` })).filter((u) => u > uid).sort((a, b) => a - b).slice(0, limite),
    lire: async (uid) => {
      const m = await client.fetchOne(String(uid), { envelope: true, flags: true, internalDate: true, bodyStructure: true }, { uid: true });
      if (!m) return null;
      const partie = m.bodyStructure ? choisirPartieTexte(m.bodyStructure) : undefined;
      const brut = partie ? (await client.download(String(uid), partie.numero, { uid: true })).content : undefined;
      const corps = partie && brut ? decoderCorps(Buffer.concat(await tout(brut)), partie.encodage, partie.charset) : undefined;
      const date = m.internalDate instanceof Date ? m.internalDate.toISOString() : m.internalDate;
      return {
        ...(m.envelope?.from?.[0]?.address ? { expediteur: m.envelope.from[0].address } : {}),
        ...(m.envelope?.subject !== undefined ? { objet: m.envelope.subject } : {}),
        ...(corps ? { corps } : {}),
        ...(date ? { date } : {}),
        etiquettes: [...(m.flags ?? [])],
      };
    },
    ajouterMotsCles: async (uid, mots) => void (await client.messageFlagsAdd(String(uid), mots, { uid: true })),
    chercherMessageId: (messageId) => uids({ header: { "message-id": messageId } }),
    ajouter: async (chemin, source, drapeaux) => void (await client.append(chemin, source, drapeaux)),
    fermer: async () => {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
}
