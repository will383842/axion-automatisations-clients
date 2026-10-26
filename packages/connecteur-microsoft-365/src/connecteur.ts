import {
  ACTIONS_MESSAGERIE, ErreurConnecteur, activer, classer, declarer, journaliser, verifierMessageId,
  type Champ, type ConnecteurMessagerie, type JetonCourt, type MessageLu, type MessageSortant, type Page,
} from "@axion-auto/connecteurs-commun";
import { versBrouillon, versMessageLu, selection } from "./correspondances.ts";
import { creerClientGraph, type OptionsGraph } from "./graph.ts";
import { verifierApresCoup, type Verification } from "./verification.ts";

export type { Verification } from "./verification.ts";
export type OptionsMicrosoft365 = OptionsGraph & { journal?: (ligne: string) => void };
export type ConnecteurMicrosoft365 = ConnecteurMessagerie & {
  verifierApresCoup(jeton: JetonCourt, messageId: string): Promise<Verification>;
  // Dernier @odata.deltaLink rendu par Graph : le curseur de la prochaine relève (jamais reconstruit).
  curseurDelta(): string | null;
};

const DELTA = "/me/mailFolders/inbox/messages/delta?$select=id";
const MAX_MEMOIRE = 1000;

const declaration = declarer({
  famille: "messagerie", outil: "microsoft-365", version: "1.0.0", portees: ["Mail.Read", "Mail.ReadWrite", "Mail.Send"],
  capacites: ACTIONS_MESSAGERIE.map((action) => ({ action, garantie: action === "envoyer" ? "verifiable_apres_coup" : "au_plus_une_fois" })),
});

const objet = (v: unknown): Record<string, unknown> => {
  if (typeof v !== "object" || v === null) throw new ErreurConnecteur("definitive", "reponse_inattendue");
  return v as Record<string, unknown>;
};

export function creerConnecteurMicrosoft365(options: OptionsMicrosoft365): ConnecteurMicrosoft365 {
  const graph = creerClientGraph(options);
  let delta: string | null = null;
  // Identifiant de message réellement posé par Graph, par Message-ID choisi (sert à la recherche après coup).
  const poses = new Map<string, string>();

  // Le journal ne reçoit que l'action, la classe et le code : jamais un corps, un objet ou une adresse.
  const tracer = (ligne: Record<string, string>) => {
    try { options.journal?.(journaliser(ligne)); } catch { /* le journal ne casse jamais une action */ }
  };
  const executer = async <T>(action: string, f: () => Promise<T>): Promise<T> => {
    try {
      const r = await f();
      tracer({ action });
      return r;
    } catch (e) {
      const erreur = classer(e);
      tracer({ action, classe: erreur.classe, code: erreur.code });
      throw erreur;
    }
  };
  const chemin = (id: string) => `/me/messages/${encodeURIComponent(id)}`;

  async function creer(jeton: JetonCourt, m: MessageSortant): Promise<{ id: string }> {
    try { verifierMessageId(m.messageId); } catch { throw new ErreurConnecteur("definitive", "message_id_invalide"); }
    const brouillon = objet(await graph.requete(jeton, "POST", "/me/messages", versBrouillon(m)));
    if (typeof brouillon["id"] !== "string") throw new ErreurConnecteur("definitive", "reponse_inattendue");
    if (poses.size >= MAX_MEMOIRE) poses.delete(poses.keys().next().value as string);
    poses.set(m.messageId, typeof brouillon["internetMessageId"] === "string" ? brouillon["internetMessageId"] : m.messageId);
    return { id: brouillon["id"] };
  }

  return {
    declaration,
    curseurDelta: () => delta,
    listerNouveaux: (jeton, curseur): Promise<Page> => executer("lister_nouveaux", async () => {
      const page = objet(await graph.requete(jeton, "GET", curseur ?? DELTA));
      if (!Array.isArray(page["value"])) throw new ErreurConnecteur("definitive", "reponse_inattendue");
      if (typeof page["@odata.deltaLink"] === "string") delta = page["@odata.deltaLink"];
      const suivant = page["@odata.nextLink"];
      // Les entrées « @removed » sont des suppressions, pas de nouveaux messages.
      const presents = page["value"].filter((v) => objet(v)["@removed"] === undefined);
      return { ids: presents.map((v) => String(objet(v)["id"])), suivant: typeof suivant === "string" ? suivant : null };
    }),
    lire: (jeton, id, champs: Champ[]): Promise<MessageLu> => executer("lire", async () =>
      versMessageLu(await graph.requete(jeton, "GET", `${chemin(id)}?$select=${selection(champs)}`), id, champs)),
    etiqueter: (jeton, id, etiquettes) => executer("etiqueter", async () => {
      const actuelles = objet(await graph.requete(jeton, "GET", `${chemin(id)}?$select=categories`))["categories"];
      const categories = [...new Set([...(Array.isArray(actuelles) ? (actuelles as string[]) : []), ...etiquettes])];
      await graph.requete(jeton, "PATCH", chemin(id), { categories });
    }),
    creerBrouillon: (jeton, m) => executer("creer_brouillon", () => creer(jeton, m)),
    envoyer: (jeton, m) => executer("envoyer", async () => {
      const brouillon = await creer(jeton, m);
      try {
        await graph.requete(jeton, "POST", `${chemin(brouillon.id)}/send`);
      } catch (e) {
        // Connexion coupée après l'envoi : le message est peut-être parti. Le noyau vérifie avant tout renvoi.
        if (e instanceof TypeError || (e instanceof ErreurConnecteur && e.code === "delai_depasse")) throw new ErreurConnecteur("passagere", "reponse_perdue");
        throw e;
      }
      return brouillon;
    }),
    verifierApresCoup: (jeton, messageId) => verifierApresCoup(graph, jeton, poses.get(messageId) ?? messageId),
  };
}

// Point d'entrée de production : fermé tant que l'interrupteur n'est pas « 1 » ; l'adresse vient de GRAPH_URL, sans valeur
// par défaut (aucun repli vers le vrai Graph : la garde des destinations ne voit qu'une adresse présente).
export function ouvrirMicrosoft365(env: Record<string, string | undefined>, options: Partial<OptionsMicrosoft365> = {}): ConnecteurMicrosoft365 {
  activer(declaration, env);
  const url = env["GRAPH_URL"]?.trim();
  if (!url) throw new ErreurConnecteur("definitive", "GRAPH_URL absente : adresse de Graph obligatoire");
  return creerConnecteurMicrosoft365({ ...options, url });
}
