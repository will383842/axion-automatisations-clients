import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { creerJeton, ErreurConnecteur, type Banc, type Fabrique, type Scenario } from "@axion-auto/connecteurs-commun";
import { describe, expect, it } from "vitest";
import { lancer } from "@axion-auto/connecteurs-commun/src/suite/lanceur.ts";
import { ouvrirConnecteur, type Dependances } from "./connecteur.ts";
import type { SessionImap } from "./imap.ts";
import { verifierConfiguration } from "./verification.ts";

const config = verifierConfiguration({ hoteImap: "imap.exemple.test", hoteSmtp: "smtp.exemple.test", utilisateur: "instance-essai", expediteur: "atelier@exemple.fr" });
const enregistre = (nom: string): Record<string, unknown> => {
  const l = (JSON.parse(readFileSync(fileURLToPath(new URL("../enregistrements/erreurs-serveur.json", import.meta.url)), "utf8")) as { nom: string; erreur: Record<string, unknown> }[]).find((x) => x.nom === nom);
  return Object.assign(new Error(String(l?.erreur.message ?? "x")), l?.erreur);
};
const PANNES = { quota: "imap_quota_depasse", jeton: "imap_identification_refusee", http_503: "imap_coupure", inattendue: "inattendue" } as const;

type Option = { sansEnvoyes?: boolean; sansBrouillons?: boolean; copieSeule?: boolean; copieEchoue?: boolean; uidValidity?: string };
type Etat = { ouvertes: number; fermees: number; envoyes: string[]; copies: string[]; brouillons: string[]; motsCles: Map<number, string[]>; alertes: string[]; selections: string[] };

// Faux serveur en mémoire : une boîte, un SMTP, des dossiers avec ou sans attribut spécial.
function faux(s: Scenario, o: Option = {}): { deps: Dependances; etat: Etat; valeurJeton: string } {
  const valeurJeton = `jeton-fictif-${s.nom}`;
  const etat: Etat = { ouvertes: 0, fermees: 0, envoyes: [], copies: [], brouillons: [], motsCles: new Map(), alertes: [], selections: [] };
  const n = s.messages ?? 0;
  const panne = (m: string, type: keyof typeof PANNES) => { if (s.panne?.sur === m && s.panne.type === type) throw enregistre(PANNES[type]); };
  const garde = (m: string) => (["quota", "jeton", "http_503", "inattendue"] as const).forEach((t) => panne(m, t));
  const session = (): SessionImap => ({
    dossiers: async () => [
      { chemin: "INBOX" },
      ...(o.sansEnvoyes ? [{ chemin: "Sent" }] : [{ chemin: "Envoyés", usageSpecial: "\\Sent" }]),
      ...(o.sansBrouillons ? [] : [{ chemin: "Brouillons", usageSpecial: "\\Drafts" }]),
    ],
    selectionner: async (chemin) => (etat.selections.push(chemin), { uidValidity: o.uidValidity ?? "7" }),
    uidsApres: async (uid, limite) => { garde("listerNouveaux"); return Array.from({ length: n }, (_, i) => i + 1).filter((u) => u > uid).slice(0, limite); },
    lire: async (uid) => {
      garde("lire");
      if (uid < 1 || uid > n) return null;
      return { expediteur: "alice@exemple.fr", objet: `Sujet ${uid}`, ...(s.sansCorps ? {} : { corps: "Texte" }), date: "2026-10-25T08:00:00Z", etiquettes: etat.motsCles.get(uid) ?? [] };
    },
    ajouterMotsCles: async (uid, mots) => { garde("etiqueter"); etat.motsCles.set(uid, [...(etat.motsCles.get(uid) ?? []), ...mots]); },
    chercherMessageId: async (id) => (etat.copies.includes(id) ? [1] : []),
    ajouter: async (chemin, source) => {
      garde("creerBrouillon");
      const id = /^Message-ID: (.+)$/mi.exec(source.toString())?.[1]?.trim() ?? "";
      if (chemin === "Brouillons") etat.brouillons.push(id);
      else if (o.copieEchoue) throw enregistre("imap_coupure");
      else etat.copies.push(id);
    },
    fermer: async () => void etat.fermees++,
  });
  const deps: Dependances = {
    ouvrirImap: async (opt) => {
      if (opt.auth.pass !== valeurJeton) throw enregistre("imap_identification_refusee");
      etat.ouvertes++;
      return session();
    },
    envoyerSmtp: async (opt, m, expediteur) => {
      if (opt.auth.pass !== valeurJeton) throw enregistre("smtp_identification_refusee");
      etat.envoyes.push(m.messageId);
      if (o.copieSeule) etat.copies.push(m.messageId);
      if (s.panne?.sur === "envoyer" && s.panne.type === "perdue") throw enregistre("smtp_coupure");
      return Buffer.from(`From: ${expediteur}\r\nMessage-ID: ${m.messageId}\r\n\r\n${m.corps}`);
    },
    alerter: (code) => void etat.alertes.push(code),
    maintenant: () => Date.now(),
    attenteQuotaMs: 3_600_000,
    taillePage: 2,
  };
  return { deps, etat, valeurJeton };
}

const banc = async (s: Scenario, o: Option = {}): Promise<Banc & { etat: Etat }> => {
  const { deps, etat, valeurJeton } = faux(s, o);
  const jeton = creerJeton(valeurJeton, Date.now() + 60_000);
  return { connecteur: await ouvrirConnecteur(config, jeton, deps), jeton, valeurJeton, envoyes: () => etat.envoyes.length, etat };
};
const fabrique: Fabrique = (s) => banc(s);
const message = (messageId = "<m-1.essai@exemple.fr>") => ({ messageId, destinataire: "client@exemple.fr", objet: "Essai", corps: "Bonjour" });
const garantie = (b: Banc, action: string) => b.connecteur.declaration.capacites.find((c) => c.action === action)?.garantie;

describe("connecteur IMAP/SMTP", () => {
  it("[A-405] le connecteur IMAP passe la suite messagerie sur enregistrements", async () => {
    await lancer(fabrique);
  });

  it("[A-319] @anti-doublon sans dossier \\Sent la garantie déclarée est au_plus_une_fois", async () => {
    const b = await banc({ nom: "envoi" }, { sansEnvoyes: true });
    expect(garantie(b, "envoyer")).toBe("au_plus_une_fois");
    expect(b.etat.alertes).toContain("dossier_envoyes_introuvable");
    await b.connecteur.envoyer(b.jeton, message());
    expect(b.etat.envoyes).toHaveLength(1);
    expect(b.etat.copies).toEqual([]);
  });

  it("[A-319] @anti-doublon avec \\Sent, verifierApresCoup retrouve le Message-ID", async () => {
    const b = await banc({ nom: "envoi" });
    expect(garantie(b, "envoyer")).toBe("verifiable_apres_coup");
    expect(b.etat.alertes).toEqual([]);
    await b.connecteur.envoyer(b.jeton, message());
    expect(await b.connecteur.verifierApresCoup(b.jeton, "<m-1.essai@exemple.fr>")).toBe(true);
    expect(await b.connecteur.verifierApresCoup(b.jeton, "<autre.essai@exemple.fr>")).toBe(false);
  });

  it("[A-319] @anti-doublon si le serveur copie déjà l'envoi, le connecteur ne le copie pas une deuxième fois", async () => {
    const b = await banc({ nom: "envoi" }, { copieSeule: true });
    await b.connecteur.envoyer(b.jeton, message());
    expect(b.etat.copies).toEqual(["<m-1.essai@exemple.fr>"]);
  });

  it("[A-319] @anti-doublon si le serveur ne copie pas, une seule copie est ajoutée dans \\Sent", async () => {
    const b = await banc({ nom: "envoi" });
    await b.connecteur.envoyer(b.jeton, message());
    expect(b.etat.copies).toEqual(["<m-1.essai@exemple.fr>"]);
  });

  it("[A-319] @anti-doublon une copie en échec après l'envoi ne fait pas échouer l'envoi (pas de renvoi)", async () => {
    const b = await banc({ nom: "envoi" }, { copieEchoue: true });
    await expect(b.connecteur.envoyer(b.jeton, message())).resolves.toBeTruthy();
    expect(b.etat.alertes).toContain("copie_envoyes_echouee");
    expect(b.etat.envoyes).toHaveLength(1);
  });

  it("[A-319] verifierApresCoup sans \\Sent est une erreur définitive, pas un « non »", async () => {
    const b = await banc({ nom: "envoi" }, { sansEnvoyes: true });
    await expect(b.connecteur.verifierApresCoup(b.jeton, "<m-1.essai@exemple.fr>")).rejects.toMatchObject({ classe: "definitive", code: "dossier_envoyes_introuvable" });
  });

  it("[A-335] le mot de passe du serveur est le jeton court : un autre jeton est refusé comme identification", async () => {
    const b = await banc({ nom: "vide" });
    const autre = creerJeton("autre-jeton-fictif", Date.now() + 60_000);
    await expect(b.connecteur.listerNouveaux(autre, null)).rejects.toMatchObject({ classe: "identification" });
  });

  it("[A-389] un jeton expiré est refusé sans ouvrir de connexion", async () => {
    const b = await banc({ nom: "vide" });
    const ouvertes = b.etat.ouvertes;
    const vieux = creerJeton(b.valeurJeton, Date.now() - 1);
    await expect(b.connecteur.listerNouveaux(vieux, null)).rejects.toMatchObject({ classe: "identification", code: "jeton_expire" });
    expect(b.etat.ouvertes).toBe(ouvertes);
  });

  it("[A-389] chaque connexion est fermée à la fin de l'appel, y compris en erreur", async () => {
    const b = await banc({ nom: "quota", messages: 1, panne: { sur: "lire", type: "quota" } });
    await b.connecteur.listerNouveaux(b.jeton, null);
    await expect(b.connecteur.lire(b.jeton, "m-1", ["objet"])).rejects.toBeInstanceOf(ErreurConnecteur);
    await b.connecteur.creerBrouillon(b.jeton, message());
    expect(b.etat.fermees).toBe(b.etat.ouvertes);
    expect(b.etat.ouvertes).toBeGreaterThanOrEqual(3);
  });

  it("[A-389] le curseur est UIDVALIDITY:UID du dernier message vu", async () => {
    const b = await banc({ nom: "pagination", messages: 5 });
    expect(await b.connecteur.listerNouveaux(b.jeton, null)).toEqual({ ids: ["m-1", "m-2"], suivant: "7:2" });
    expect(await b.connecteur.listerNouveaux(b.jeton, "7:2")).toEqual({ ids: ["m-3", "m-4"], suivant: "7:4" });
    expect(await b.connecteur.listerNouveaux(b.jeton, "7:4")).toEqual({ ids: ["m-5"], suivant: null });
  });

  it("[A-389] un UIDVALIDITY changé ou un curseur illisible est une erreur définitive", async () => {
    const b = await banc({ nom: "pagination", messages: 5 });
    await expect(b.connecteur.listerNouveaux(b.jeton, "6:2")).rejects.toMatchObject({ classe: "definitive", code: "uidvalidity_change" });
    await expect(b.connecteur.listerNouveaux(b.jeton, "n'importe quoi")).rejects.toMatchObject({ classe: "definitive", code: "curseur_invalide" });
  });

  it("[A-389] étiqueter pose des mots-clés IMAP ; un mot-clé invalide est refusé", async () => {
    const b = await banc({ nom: "etiquette", messages: 1 });
    await b.connecteur.etiqueter(b.jeton, "m-1", ["$AxionTraite"]);
    expect(b.etat.motsCles.get(1)).toEqual(["$AxionTraite"]);
    await expect(b.connecteur.etiqueter(b.jeton, "m-1", ["avec espace"])).rejects.toMatchObject({ classe: "definitive", code: "etiquette_invalide" });
    await expect(b.connecteur.lire(b.jeton, "x-1", ["objet"])).rejects.toMatchObject({ classe: "definitive", code: "message_inconnu" });
  });

  it("[A-389] le brouillon est ajouté dans le dossier \\Drafts, sans envoi", async () => {
    const b = await banc({ nom: "brouillon" });
    await b.connecteur.creerBrouillon(b.jeton, message());
    expect(b.etat.brouillons).toEqual(["<m-1.essai@exemple.fr>"]);
    expect(b.etat.envoyes).toEqual([]);
    const sans = await banc({ nom: "brouillon" }, { sansBrouillons: true });
    await expect(sans.connecteur.creerBrouillon(sans.jeton, message())).rejects.toMatchObject({ classe: "definitive", code: "dossier_brouillons_introuvable" });
  });

  it("[A-389] la déclaration ne porte que les 5 actions de la famille, avec une garantie chacune", async () => {
    const b = await banc({ nom: "vide" });
    expect(b.connecteur.declaration.capacites.map((c) => c.action)).toEqual(["lister_nouveaux", "lire", "etiqueter", "creer_brouillon", "envoyer"]);
  });
});
