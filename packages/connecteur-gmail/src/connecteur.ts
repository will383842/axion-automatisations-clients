import {
  ACTIONS_MESSAGERIE, ErreurConnecteur, activer, classer, declarer, journaliser, verifierMessageId,
  type Champ, type ConnecteurMessagerie, type JetonCourt, type MessageLu, type MessageSortant, type Page,
} from "@axion-auto/connecteurs-commun";
import { creerClientGmail, type OptionsGmail } from "./gmail.ts";
import { messageBrut, versMessageLu } from "./mime.ts";
import { verifierApresCoup, type Verification } from "./verification.ts";

export type { Verification } from "./verification.ts";
// `actions` : les actions demandées par les modules installés ; elles décident des portées (les plus étroites qui les couvrent).
export type OptionsGmailConnecteur = OptionsGmail & { journal?: (ligne: string) => void; actions?: readonly string[] };
export type ConnecteurGmail = ConnecteurMessagerie & {
  verifierApresCoup(jeton: JetonCourt, messageId: string): Promise<Verification>;
  // Curseur « h:<historyId> » de la prochaine relève, rendu par Gmail (jamais reconstruit) ; null avant la première relève.
  curseurHistorique(): string | null;
};

const PAGE = 100;
const MAX_MEMOIRE = 1000;
// Curseurs rendus par le connecteur : « l:<pageToken> » (liste), « h:<historyId>[:<pageToken>] » (history.list).
const CURSEUR = /^(?:l:([\w-]+)|h:(\d+)(?::([\w-]+))?)$/;
const ETIQUETTE = /^[\w .-]{1,100}$/;

export const porteesGmail = (actions: readonly string[] = []): string[] => (actions.includes("etiqueter") ? ["gmail.modify"] : ["gmail.readonly", "gmail.compose"]);

const declaration = (actions?: readonly string[]) => declarer({
  famille: "messagerie", outil: "gmail", version: "1.0.0", portees: porteesGmail(actions),
  capacites: ACTIONS_MESSAGERIE.map((action) => ({ action, garantie: action === "envoyer" ? "verifiable_apres_coup" : "au_plus_une_fois" })),
});

const objet = (v: unknown): Record<string, unknown> => {
  if (typeof v !== "object" || v === null) throw new ErreurConnecteur("definitive", "reponse_inattendue");
  return v as Record<string, unknown>;
};
const ids = (v: unknown, lire: (e: Record<string, unknown>) => unknown): string[] =>
  (Array.isArray(v) ? v : []).map((e) => lire(objet(e))).filter((id): id is string => typeof id === "string");

export function creerConnecteurGmail(options: OptionsGmailConnecteur): ConnecteurGmail {
  const gmail = creerClientGmail(options);
  let historique: string | null = null;
  // Historique lu avant la liste complète en cours : un message arrivé pendant la liste sera relu, jamais perdu.
  let avantListe: string | null = null;
  const traites = new Set<string>();

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
  const chemin = (id: string) => `/messages/${encodeURIComponent(id)}`;
  const retenir = (liste: string[]) => {
    for (const id of liste) {
      if (traites.size >= MAX_MEMOIRE) traites.delete(traites.values().next().value as string);
      traites.add(id);
    }
    return liste;
  };

  async function liste(jeton: JetonCourt, jetonPage: string | null): Promise<Page> {
    if (jetonPage === null) {
      const depart = objet(await gmail.requete(jeton, "GET", "/profile"))["historyId"];
      avantListe = typeof depart === "string" ? depart : null;
    }
    const q = `labelIds=INBOX&maxResults=${PAGE}${jetonPage ? `&pageToken=${jetonPage}` : ""}`;
    const page = objet(await gmail.requete(jeton, "GET", `/messages?${q}`));
    const suivant = typeof page["nextPageToken"] === "string" ? page["nextPageToken"] : null;
    if (suivant === null && avantListe) historique = `h:${avantListe}`;
    return { ids: ids(page["messages"], (m) => m["id"]), suivant: suivant === null ? null : `l:${suivant}` };
  }

  async function depuis(jeton: JetonCourt, depart: string, jetonPage: string | undefined): Promise<Page> {
    let page: Record<string, unknown>;
    try {
      page = objet(await gmail.requete(jeton, "GET", `/history?startHistoryId=${depart}&historyTypes=messageAdded&labelId=INBOX${jetonPage ? `&pageToken=${jetonPage}` : ""}`));
    } catch (e) {
      // historyId trop vieux : on repart d'une liste complète, sans redonner ce qui a déjà été traité.
      if (!(e instanceof ErreurConnecteur) || e.code !== "http_404") throw e;
      const complete = await liste(jeton, null);
      return { ...complete, ids: complete.ids.filter((id) => !traites.has(id)) };
    }
    const suivant = typeof page["nextPageToken"] === "string" ? page["nextPageToken"] : null;
    if (suivant === null && typeof page["historyId"] === "string") historique = `h:${page["historyId"]}`;
    const ajoutes = (Array.isArray(page["history"]) ? page["history"] : []).flatMap((h) => ids(objet(h)["messagesAdded"], (a) => objet(a["message"])["id"]));
    return { ids: [...new Set(ajoutes)], suivant: suivant === null ? null : `h:${depart}:${suivant}` };
  }

  async function nomsEtiquettes(jeton: JetonCourt): Promise<Map<string, string>> {
    const etiquettes = objet(await gmail.requete(jeton, "GET", "/labels"))["labels"];
    return new Map((Array.isArray(etiquettes) ? etiquettes : []).map((e) => [String(objet(e)["id"]), String(objet(e)["name"])]));
  }

  async function brouillonOuEnvoi(jeton: JetonCourt, m: MessageSortant, route: string, corps: (raw: string) => unknown): Promise<{ id: string }> {
    try { verifierMessageId(m.messageId); } catch { throw new ErreurConnecteur("definitive", "message_id_invalide"); }
    const reponse = objet(await gmail.requete(jeton, "POST", route, corps(messageBrut(m))));
    if (typeof reponse["id"] !== "string") throw new ErreurConnecteur("definitive", "reponse_inattendue");
    return { id: reponse["id"] };
  }

  return {
    declaration: declaration(options.actions),
    curseurHistorique: () => historique,
    listerNouveaux: (jeton, curseur): Promise<Page> => executer("lister_nouveaux", async () => {
      const lu = curseur === null ? null : CURSEUR.exec(curseur);
      if (curseur !== null && !lu) throw new ErreurConnecteur("definitive", "curseur_invalide");
      const page = lu?.[2] ? await depuis(jeton, lu[2], lu[3]) : await liste(jeton, lu?.[1] ?? null);
      retenir(page.ids);
      return page;
    }),
    lire: (jeton, id, champs: Champ[]): Promise<MessageLu> => executer("lire", async () => {
      // « full » seulement quand le corps est demandé : sinon les seuls en-têtes utiles.
      const format = champs.includes("corps") ? "format=full" : "format=metadata&metadataHeaders=From&metadataHeaders=Subject";
      const brut = await gmail.requete(jeton, "GET", `${chemin(id)}?${format}`);
      return versMessageLu(brut, id, champs, champs.includes("etiquettes") ? await nomsEtiquettes(jeton) : undefined);
    }),
    etiqueter: (jeton, id, etiquettes) => executer("etiqueter", async () => {
      if (!etiquettes.every((e) => ETIQUETTE.test(e))) throw new ErreurConnecteur("definitive", "etiquette_invalide");
      const connues = await nomsEtiquettes(jeton);
      const ajouts: string[] = [];
      for (const nom of etiquettes) {
        const existante = [...connues].find(([, n]) => n === nom)?.[0];
        const cree = existante ?? objet(await gmail.requete(jeton, "POST", "/labels", { name: nom }))["id"];
        if (typeof cree !== "string") throw new ErreurConnecteur("definitive", "reponse_inattendue");
        ajouts.push(cree);
      }
      await gmail.requete(jeton, "POST", `${chemin(id)}/modify`, { addLabelIds: ajouts });
    }),
    creerBrouillon: (jeton, m) => executer("creer_brouillon", () => brouillonOuEnvoi(jeton, m, "/drafts", (raw) => ({ message: { raw } }))),
    envoyer: (jeton, m) => executer("envoyer", async () => {
      try {
        return await brouillonOuEnvoi(jeton, m, "/messages/send", (raw) => ({ raw }));
      } catch (e) {
        // Connexion coupée pendant l'envoi : le message est peut-être parti. Le noyau vérifie avant tout renvoi.
        if (e instanceof TypeError || (e instanceof ErreurConnecteur && e.code === "delai_depasse")) throw new ErreurConnecteur("passagere", "reponse_perdue");
        throw e;
      }
    }),
    verifierApresCoup: (jeton, messageId) => verifierApresCoup(gmail, jeton, messageId),
  };
}

// Point d'entrée de production : fermé tant que les DEUX interrupteurs ne sont pas « 1 » (celui de la famille et celui de
// Gmail, qui reste fermé tant que la fiche de conformité n'est pas signée) ; l'adresse vient de GMAIL_URL, sans valeur par
// défaut (aucun repli vers le vrai Gmail : la garde des destinations ne voit qu'une adresse présente).
export function ouvrirGmail(env: Record<string, string | undefined>, options: Partial<OptionsGmailConnecteur> = {}): ConnecteurGmail {
  activer(declaration(options.actions), env);
  if (env["CONNECTEUR_GMAIL_OUVERT"] !== "1") throw new Error("interrupteur CONNECTEUR_GMAIL_OUVERT fermé");
  const url = env["GMAIL_URL"]?.trim();
  if (!url) throw new ErreurConnecteur("definitive", "GMAIL_URL absente : adresse de Gmail obligatoire");
  return creerConnecteurGmail({ ...options, url });
}
