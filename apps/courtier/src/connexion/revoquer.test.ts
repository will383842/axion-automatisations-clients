import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { creerJournal } from "../journal.js";
import { revoquerConnexion, type PortsRevocation } from "./revoquer.js";

// Attaques prévues (audit) : 1 révocation sans auteur ; 2 deuxième révocation ; 3 effacement avalé en silence ; 4 appel qui déconnecte la personne chez Microsoft ;
// 5 table de données de travail touchée ; 6 valeur d'un jeton dans une trace.
const T = "11111111-1111-4111-8111-111111111111";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const JETON = "marqueur-jeton-de-renouvellement-5be2";
const DEMANDE = { tenantId: T, connexionId: C, acteur: "will383842", motif: "decision_dirigeant" };
const JETONS = `clients/${T}/connexions/${C}/jetons`;
const APPLICATION = `clients/${T}/connexions/${C}/application`;
const PORTS_PERMIS = ["existe", "fournisseurDe", "marquerRevoquee", "mettreEnPause", "lireJeton", "effacerValeur", "alerter"];

function monde(fournisseur: "microsoft" | "google" | "imap", sur: Partial<PortsRevocation> = {}) {
  const etat = { appels: [] as string[], args: {} as Record<string, unknown[]>, requetes: [] as { url: string; corps: string }[], lignes: [] as string[], alertes: [] as string[] };
  const note = (nom: string, a: unknown[]) => { etat.appels.push(nom); etat.args[nom] = a; };
  const ports: PortsRevocation = {
    existe: async (...a) => (note("existe", a), true),
    fournisseurDe: async (...a) => (note("fournisseurDe", a), fournisseur),
    marquerRevoquee: async (...a) => (note("marquerRevoquee", a), true),
    mettreEnPause: async (...a) => (note("mettreEnPause", a), 2),
    lireJeton: async (...a) => (note("lireJeton", a), JETON),
    effacerValeur: async (...a) => note("effacerValeur", a),
    alerter: (...a) => { note("alerter", a); etat.alertes.push(String(a[0])); },
    fetch: (async (url: string, init?: { body?: string }) => { etat.requetes.push({ url: String(url), corps: String(init?.body ?? "") }); return new Response("", { status: 200 }); }) as typeof fetch,
    journal: creerJournal((l) => etat.lignes.push(l)),
    ...sur,
  };
  return { etat, ports };
}

describe("révocation d'une connexion", () => {
  it("[A-393] révoquer efface la valeur, garde la référence, trace l'auteur et met les instances en pause", async () => {
    const { etat, ports } = monde("imap");
    expect(await revoquerConnexion(ports, DEMANDE)).toEqual({ etat: "revoquee", effacement: "fait" });
    expect(etat.appels).toEqual(["existe", "marquerRevoquee", "fournisseurDe", "mettreEnPause", "effacerValeur"]);
    expect(etat.args["marquerRevoquee"]).toEqual([T, C, "will383842", "decision_dirigeant"]);
    expect(etat.args["mettreEnPause"]).toEqual([T, C, "will383842"]);
    // Seules les VALEURS sont effacées : ni la référence ni la pièce « compte » ne sont visées.
    expect(etat.args["effacerValeur"]).toEqual([[JETONS, APPLICATION]]);
    expect(etat.lignes.map((l) => JSON.parse(l))).toEqual([{ evenement: "connexion_revoquee", tenantId: T, connexionId: C, code: "ok" }]);
  });

  it("[A-393] révoquer ne touche aucune table de cli_<id>", () => {
    const source = readFileSync(new URL("./revoquer.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/cli_|DELETE|DROP|TRUNCATE/i);
  });

  it("[A-393] les ports appelés forment une liste fermée (aucun accès à la base du client, au stockage ou à la boîte)", async () => {
    const { etat, ports } = monde("google");
    await revoquerConnexion(ports, DEMANDE);
    expect(etat.appels.every((a) => PORTS_PERMIS.includes(a))).toBe(true);
    expect(Object.keys(ports).sort()).toEqual([...PORTS_PERMIS, "fetch", "journal"].sort());
  });

  it("[A-393] Microsoft : aucun appel de révocation de sessions ; Google : appel à /revoke ; un échec du fournisseur n'empêche ni l'effacement ni la trace", async () => {
    const ms = monde("microsoft");
    await revoquerConnexion(ms.ports, DEMANDE);
    expect(ms.etat.requetes).toEqual([]);
    expect(ms.etat.appels).not.toContain("lireJeton");
    expect(ms.etat.appels).toContain("effacerValeur");
    const g = monde("google");
    await revoquerConnexion(g.ports, DEMANDE);
    expect(g.etat.requetes).toHaveLength(1);
    expect(g.etat.requetes[0]?.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(g.etat.requetes[0]?.corps).toBe(`token=${encodeURIComponent(JETON)}`);
    // Le fournisseur tombe : la révocation, l'effacement et la trace ont lieu quand même.
    const panne = monde("google", { fetch: (async () => { throw new Error(`panne ${JETON}`); }) as typeof fetch });
    expect(await revoquerConnexion(panne.ports, DEMANDE)).toEqual({ etat: "revoquee", effacement: "fait" });
    expect(panne.etat.appels).toContain("effacerValeur");
    expect(panne.etat.lignes).toHaveLength(1);
    // Aucune valeur de jeton dans les traces.
    expect([g, panne, ms].map((m) => m.etat.lignes.join("")).join("")).not.toContain(JETON);
  });

  it("[A-393] effacement en échec : connexion révoquée quand même, alerte et code effacement_a_refaire", async () => {
    const { etat, ports } = monde("google", { effacerValeur: async () => { throw new Error(`coffre ${JETON}`); } });
    expect(await revoquerConnexion(ports, DEMANDE)).toEqual({ etat: "revoquee", effacement: "a_refaire" });
    expect(etat.alertes).toEqual(["effacement_a_refaire"]);
    expect(etat.args["alerter"]).toEqual(["effacement_a_refaire", { tenantId: T, connexionId: C }]);
    expect(JSON.parse(etat.lignes[0]!)).toMatchObject({ evenement: "connexion_revoquee", code: "effacement_a_refaire" });
    expect(etat.lignes.join("")).not.toContain(JETON);
  });

  it("[A-393] mettreEnPause qui lève : effacerValeur est quand même appelé, l'alerte et la trace sont émises", async () => {
    const { etat, ports } = monde("google", { mettreEnPause: async () => { throw new Error(`pause ${JETON}`); } });
    await expect(revoquerConnexion(ports, DEMANDE)).rejects.toThrow();
    expect(etat.appels).toContain("effacerValeur");
    expect(etat.args["effacerValeur"]).toEqual([[JETONS, APPLICATION]]);
    expect(etat.alertes).toEqual(["revocation_incomplete"]);
    expect(etat.lignes.map((l) => JSON.parse(l))).toEqual([{ evenement: "revocation_etape_echouee", tenantId: T, connexionId: C, code: "pause_echouee" }, { evenement: "connexion_revoquee", tenantId: T, connexionId: C, code: "pause_echouee" }]);
    expect(etat.lignes.join("")).not.toContain(JETON);
  });

  it("[A-393] fournisseurDe qui lève : l'effacement a lieu, l'échec est journalisé et l'alerte émise", async () => {
    const { etat, ports } = monde("google", { fournisseurDe: async () => { throw new Error(`base ${JETON}`); } });
    await expect(revoquerConnexion(ports, DEMANDE)).rejects.toThrow();
    expect(etat.appels).toContain("effacerValeur");
    expect(etat.appels).toContain("mettreEnPause");
    expect(etat.alertes).toEqual(["revocation_incomplete"]);
    expect(etat.lignes.map((l) => JSON.parse(l))).toEqual([{ evenement: "revocation_etape_echouee", tenantId: T, connexionId: C, code: "fournisseur_inconnu" }, { evenement: "connexion_revoquee", tenantId: T, connexionId: C, code: "fournisseur_inconnu" }]);
    expect(etat.lignes.join("")).not.toContain(JETON);
  });

  it("[A-393] Google qui ne répond jamais : le délai d'abandon laisse l'effacement avoir lieu ; le jeton est encodé dans le corps", async () => {
    let signal: AbortSignal | undefined;
    const sansReponse = ((_u: string, init?: { signal?: AbortSignal }) => { signal = init?.signal; return new Promise(() => {}); }) as unknown as typeof fetch;
    const m = monde("google", { fetch: sansReponse, delaiGoogleMs: 5 });
    expect(await revoquerConnexion(m.ports, DEMANDE)).toEqual({ etat: "revoquee", effacement: "fait" });
    expect(signal).toBeDefined();
    expect(m.etat.appels).toContain("effacerValeur");
    const g = monde("google", { lireJeton: async () => "a+b&c=d" });
    await revoquerConnexion(g.ports, DEMANDE);
    expect(g.etat.requetes[0]?.corps).toBe("token=a%2Bb%26c%3Dd");
  });

  it("[A-393] connexion déjà révoquée : aucune seconde révocation, aucun appel au fournisseur ni au coffre", async () => {
    const { etat, ports } = monde("google", { marquerRevoquee: async (...a) => (etat.appels.push("marquerRevoquee"), a, false) });
    expect(await revoquerConnexion(ports, DEMANDE)).toEqual({ etat: "deja_revoquee" });
    expect(etat.appels).toEqual(["existe", "marquerRevoquee"]);
    expect(etat.requetes).toEqual([]);
  });

  it("[A-393] connexion inconnue de ce client : inconnue, rien n'est écrit ; motif ou auteur invalide : refusée", async () => {
    const inconnue = monde("imap", { existe: async () => false });
    expect(await revoquerConnexion(inconnue.ports, DEMANDE)).toEqual({ etat: "inconnue" });
    expect(inconnue.etat.appels).toEqual([]);
    for (const mauvais of [{ motif: "autre" }, { acteur: "" }, { acteur: "systeme" }]) {
      const m = monde("imap");
      expect(await revoquerConnexion(m.ports, { ...DEMANDE, ...mauvais })).toEqual({ etat: "refusee" });
      expect(m.etat.appels).toEqual([]);
    }
  });
});
