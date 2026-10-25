import { classer, ErreurConnecteur } from "../erreurs.ts";
import { declarer, vueAutomatisation } from "../famille.ts";
import { ACTIONS_MESSAGERIE } from "../capacites.ts";
import { verifierMessageId, type Champ, type ConnecteurMessagerie, type MessageSortant } from "../familles/messagerie.ts";
import { avecJeton, creerJeton, type JetonCourt } from "../jeton.ts";

type Methode = "listerNouveaux" | "lire" | "etiqueter" | "creerBrouillon" | "envoyer";
export type Scenario = {
  nom: string;
  messages?: number;
  sansCorps?: boolean;
  panne?: { sur: Methode; type: "quota" | "jeton" | "http_503" | "inattendue" | "perdue" };
};
export type Banc = { connecteur: ConnecteurMessagerie; jeton: JetonCourt; valeurJeton: string; envoyes(): number };
export type Fabrique = (s: Scenario) => Promise<Banc> | Banc;

const PAGE = 2;
const sortant = (messageId = "<m-1.essai@exemple.fr>"): MessageSortant => ({ messageId, destinataire: "client@exemple.fr", objet: "Essai", corps: "Bonjour" });

// Connecteur de référence : tout en mémoire, aucun réseau, aucun envoi réel.
export function fabriqueMemoire(s: Scenario): Banc {
  const valeurJeton = `jeton-fictif-${s.nom}`;
  const jeton = creerJeton(valeurJeton, Date.now() + 60_000);
  const messages = Array.from({ length: s.messages ?? 0 }, (_, i) => ({
    id: `m-${i + 1}`, expediteur: "alice@exemple.fr", objet: `Sujet ${i + 1}`, corps: s.sansCorps ? undefined : "Texte", date: "2026-10-25T08:00:00Z", etiquettes: [] as string[],
  }));
  const envoyes = new Set<string>();
  const panne = (m: Methode) => {
    if (s.panne?.sur !== m) return;
    const t = s.panne.type;
    if (t === "quota") throw new ErreurConnecteur("quota", "quota_depasse", { reprise: "2026-11-01T08:00:00Z" });
    if (t === "jeton") throw new ErreurConnecteur("identification", "jeton_refuse");
    if (t === "http_503") throw new ErreurConnecteur("passagere", "http_503");
    if (t === "inattendue") throw new TypeError("fetch failed");
  };
  const proteger = async <T>(m: Methode, j: JetonCourt, f: () => T): Promise<T> => {
    try {
      avecJeton(j, Date.now(), () => 0);
      panne(m);
      return f();
    } catch (e) {
      throw classer(e);
    }
  };
  const cap = (action: string, garantie: "idempotent_par_cle" | "au_plus_une_fois") => ({ action, garantie });
  return {
    jeton, valeurJeton, envoyes: () => envoyes.size,
    connecteur: {
      declaration: declarer({
        famille: "messagerie", outil: "reference-memoire", version: "1.0.0", portees: ["messagerie.lecture", "messagerie.envoi"],
        capacites: ACTIONS_MESSAGERIE.map((a) => cap(a, a === "envoyer" ? "idempotent_par_cle" : "au_plus_une_fois")),
      }),
      listerNouveaux: (j, curseur) => proteger("listerNouveaux", j, () => {
        const debut = curseur ? Number(curseur.slice(2)) : 0;
        const ids = messages.slice(debut, debut + PAGE).map((m) => m.id);
        return { ids, suivant: debut + PAGE < messages.length ? `c-${debut + PAGE}` : null };
      }),
      lire: (j, id, champs) => proteger("lire", j, () => {
        const m = messages.find((x) => x.id === id);
        if (!m) throw new ErreurConnecteur("definitive", "message_inconnu");
        const sortie: Record<string, unknown> = { id };
        for (const c of champs) {
          if (m[c] === undefined) throw new ErreurConnecteur("definitive", "champ_absent");
          sortie[c] = m[c];
        }
        return sortie as { id: string };
      }),
      etiqueter: (j, id, etiquettes) => proteger("etiqueter", j, () => void messages.find((x) => x.id === id)?.etiquettes.push(...etiquettes)),
      creerBrouillon: (j, m) => proteger("creerBrouillon", j, () => ({ id: `brouillon-${verifierId(m.messageId)}` })),
      envoyer: (j, m) => proteger("envoyer", j, () => {
        envoyes.add(verifierId(m.messageId));
        if (s.panne?.sur === "envoyer" && s.panne.type === "perdue") throw new ErreurConnecteur("passagere", "reponse_perdue");
        return { id: `envoye-${m.messageId}` };
      }),
    },
  };
}
function verifierId(v: string): string {
  try { return verifierMessageId(v); } catch { throw new ErreurConnecteur("definitive", "message_id_invalide"); }
}

const verifier = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg); };
const attraper = async (f: () => Promise<unknown>): Promise<unknown> => { try { await f(); } catch (e) { return e; } return undefined; };
const erreurClasse = async (b: Banc, f: (c: ConnecteurMessagerie, j: JetonCourt) => Promise<unknown>, classe: string) => {
  const e = await attraper(() => f(b.connecteur, b.jeton));
  verifier(e instanceof ErreurConnecteur && e.classe === classe, `erreur attendue de classe ${classe}`);
  return e as ErreurConnecteur;
};
async function parcourir(b: Banc): Promise<string[]> {
  const ids: string[] = []; const vus = new Set<string>(); let c: string | null = null;
  for (let i = 0; i < 20; i++) {
    const p = await b.connecteur.listerNouveaux(b.jeton, c);
    ids.push(...p.ids);
    if (p.suivant === null) return ids;
    verifier(!vus.has(p.suivant) && p.suivant !== c, "le curseur ne progresse pas");
    vus.add(p.suivant); c = p.suivant;
  }
  throw new Error("pagination sans fin");
}

type Cas = { nom: string; scenario: Scenario; jouer(b: Banc): Promise<void> };
const C = (nom: string, scenario: Scenario, jouer: Cas["jouer"]): Cas => ({ nom, scenario, jouer });
export const CAS_MESSAGERIE: Cas[] = [
  C("liste vide", { nom: "vide" }, async (b) => verifier(JSON.stringify(await b.connecteur.listerNouveaux(b.jeton, null)) === '{"ids":[],"suivant":null}', "liste vide attendue")),
  C("pagination par curseur", { nom: "pagination", messages: 5 }, async (b) => verifier((await parcourir(b)).length === 5, "5 messages attendus")),
  C("aucun message en double entre pages", { nom: "pagination", messages: 5 }, async (b) => { const ids = await parcourir(b); verifier(new Set(ids).size === ids.length, "doublon entre pages"); }),
  C("message lu avec les seuls champs demandés", { nom: "lecture", messages: 1 }, async (b) => {
    const m = await b.connecteur.lire(b.jeton, "m-1", ["objet"]);
    verifier(Object.keys(m).sort().join() === "id,objet", "champs non demandés renvoyés");
  }),
  C("champ demandé absent", { nom: "sans_corps", messages: 1, sansCorps: true }, async (b) => { verifier((await erreurClasse(b, (c, j) => c.lire(j, "m-1", ["corps" as Champ]), "definitive")).code === "champ_absent", "code champ_absent attendu"); }),
  C("étiquette", { nom: "etiquette", messages: 1 }, async (b) => {
    await b.connecteur.etiqueter(b.jeton, "m-1", ["a-traiter"]);
    verifier(((await b.connecteur.lire(b.jeton, "m-1", ["etiquettes"])).etiquettes as string[]).includes("a-traiter"), "étiquette absente");
  }),
  C("brouillon", { nom: "brouillon" }, async (b) => { verifier(!!(await b.connecteur.creerBrouillon(b.jeton, sortant())).id && b.envoyes() === 0, "un brouillon ne part pas"); }),
  C("envoi une seule fois", { nom: "envoi" }, async (b) => { await b.connecteur.envoyer(b.jeton, sortant()); verifier(b.envoyes() === 1, "un seul envoi attendu"); }),
  C("envoi sans Message-ID valide refusé", { nom: "envoi_invalide" }, async (b) => { await erreurClasse(b, (c, j) => c.envoyer(j, sortant("")), "definitive"); verifier(b.envoyes() === 0, "rien ne part"); }),
  C("quota avec date", { nom: "quota", panne: { sur: "lire", type: "quota" } }, async (b) => { const e = await erreurClasse(b, (c, j) => c.lire(j, "m-1", ["objet"]), "quota"); verifier(!Number.isNaN(Date.parse(e.details.reprise ?? "")), "date de reprise attendue"); }),
  C("jeton refusé", { nom: "jeton_refuse", panne: { sur: "lire", type: "jeton" } }, async (b) => { await erreurClasse(b, (c, j) => c.lire(j, "m-1", ["objet"]), "identification"); }),
  C("panne 503", { nom: "panne_503", panne: { sur: "lire", type: "http_503" } }, async (b) => { await erreurClasse(b, (c, j) => c.lire(j, "m-1", ["objet"]), "passagere"); }),
  C("erreur inattendue", { nom: "inattendue", panne: { sur: "lire", type: "inattendue" } }, async (b) => { await erreurClasse(b, (c, j) => c.lire(j, "m-1", ["objet"]), "definitive"); }),
  C("réponse perdue après envoi", { nom: "perdue", panne: { sur: "envoyer", type: "perdue" } }, async (b) => {
    await erreurClasse(b, (c, j) => c.envoyer(j, sortant()), "passagere");
    verifier(b.envoyes() === 1, "le connecteur ne renvoie pas lui-même");
    if (b.connecteur.declaration.capacites.find((x) => x.action === "envoyer")?.garantie === "idempotent_par_cle") {
      await attraper(() => b.connecteur.envoyer(b.jeton, sortant()));
      verifier(b.envoyes() === 1, "même clé, même effet");
    }
  }),
  C("le jeton n'est jamais recopié dans une erreur", { nom: "jeton_refuse", panne: { sur: "lire", type: "jeton" } }, async (b) => {
    const e = await attraper(() => b.connecteur.lire(b.jeton, "m-1", ["objet"]));
    verifier(!String((e as Error)?.message).includes(b.valeurJeton), "jeton recopié");
  }),
  C("déclaration conforme, actions génériques seulement", { nom: "vide" }, async (b) => {
    const d = declarer(b.connecteur.declaration);
    verifier(!JSON.stringify(vueAutomatisation(d)).includes(d.outil), "l'outil est visible");
    verifier(ACTIONS_MESSAGERIE.every((a) => d.capacites.some((c) => c.action === a)), "capacité manquante");
    verifier(["listerNouveaux", "lire", "etiqueter", "creerBrouillon", "envoyer"].every((m) => typeof b.connecteur[m as Methode] === "function"), "méthode manquante");
  }),
];

export async function jouerSuite(fabrique: Fabrique): Promise<{ nom: string; ok: boolean; detail?: string }[]> {
  const rapport = [];
  for (const cas of CAS_MESSAGERIE) {
    try {
      await cas.jouer(await fabrique(cas.scenario));
      rapport.push({ nom: cas.nom, ok: true });
    } catch (e) {
      rapport.push({ nom: cas.nom, ok: false, detail: (e as Error).message });
    }
  }
  return rapport;
}
