import { describe, expect, it } from "vitest";
import { CATALOGUE_EMAILS, type TexteEmail } from "../../../../packages/contrats/src/messages/catalogue.js";
import { TABLE_ENVOIS } from "../../../../packages/contrats/src/notifications/table.js";
import { creerExpediteur, type Message, type Trace } from "../courriel/expediteur.js";
import { DESACTIVABLES, NON_DESACTIVABLES, cleStockee, doitLirePreferences, ecrirePreference, ecrireResume, lirePreferences, type Requeteur } from "./notifications.js";

const ORIGINE = "https://portail.exemple.test";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function valide(cle: string): TexteEmail {
  return { ...CATALOGUE_EMAILS[`email.${cle}` as keyof typeof CATALOGUE_EMAILS], validation: { will: "2000-01-01" } };
}
function variablesDe(t: TexteEmail): Record<string, string> {
  return Object.fromEntries(t.variables.map((v) => [v, v.startsWith("lien") ? `${ORIGINE}/x` : "valeur"]));
}

function monter(coupees: string[], lecture: "ok" | "echec" = "ok") {
  const envoyes: Message[] = [];
  const traces: Trace[] = [];
  const lues: string[] = [];
  const textes = Object.fromEntries(Object.keys(CATALOGUE_EMAILS).map((k) => [k, valide(k.slice(6))]));
  const expediteur = creerExpediteur({
    table: TABLE_ENVOIS,
    transport: { async envoyer(m) { envoyes.push(m); } },
    interrupteurs: { ouvert: () => true },
    trace: { ecrire: (t) => void traces.push(t) },
    adresses: {},
    cleTrace: "TEST-NE-PAS-UTILISER-cle-trace",
    textes,
    originePortail: ORIGINE,
    annuaire: { async destinataires() { return [{ utilisateur: U1, adresse: "un@exemple.fr" }, { utilisateur: U2, adresse: "deux@exemple.fr" }]; } },
    preferences: {
      async coupee(_t, utilisateur, evenement) {
        lues.push(evenement);
        if (lecture === "echec") throw new Error("base indisponible");
        return coupees.includes(`${utilisateur}:${evenement}`);
      },
    },
  });
  return { expediteur, envoyes, traces, lues };
}

describe("préférences de notification (partie pure et branchement)", () => {
  it("[B-186] chaque ligne client de la table est dans exactement une liste (désactivable ou non)", () => {
    const clients = TABLE_ENVOIS.filter((e) => e.destinataire !== "will").map((e) => e.evenement);
    for (const ev of clients) {
      const n = Number(NON_DESACTIVABLES.includes(ev)) + Number(DESACTIVABLES.includes(ev));
      expect(n, ev).toBe(1);
    }
    for (const ev of [...NON_DESACTIVABLES, ...DESACTIVABLES]) expect(clients, ev).toContain(ev);
    expect(doitLirePreferences("rapportMensuel")).toBe(true);
    expect(doitLirePreferences("palier100Client")).toBe(false);
    expect(doitLirePreferences("palier80Will")).toBe(false);
  });

  it("[B-186] cleStockee respecte la contrainte de 0025, est injective et n'atteint jamais resume_hebdomadaire", () => {
    const cles = TABLE_ENVOIS.map((e) => cleStockee(e.evenement));
    for (const c of cles) expect(c).toMatch(/^[a-z0-9_.-]+$/);
    expect(new Set(cles).size).toBe(cles.length);
    expect(cles).not.toContain("resume_hebdomadaire");
    expect(cleStockee("palier80Client")).toBe("palier80_client");
    expect(() => cleStockee("resumeHebdomadaire")).toThrow();
  });

  it("[B-186] couper une préférence ne coupe pas un message de service (palier100Client part, préférences jamais lues)", async () => {
    const { expediteur, envoyes, lues } = monter([`${U1}:palier100Client`, `${U2}:palier100Client`]);
    const t = valide("palier100Client");
    await expediteur.envoyerAuClient("palier100Client", { tenantId: CLIENT, role: "administrateur_client" }, variablesDe(t));
    expect(envoyes).toHaveLength(2);
    expect(lues).toEqual([]);
  });

  it("[B-186] une préférence coupée arrête brouillonEnAttente pour cet utilisateur seulement", async () => {
    const { expediteur, envoyes, traces } = monter([`${U1}:brouillonEnAttente`]);
    const t = valide("brouillonEnAttente");
    await expediteur.envoyerAuClient("brouillonEnAttente", { tenantId: CLIENT, role: "administrateur_client" }, variablesDe(t));
    expect(envoyes.map((m) => m.a)).toEqual(["deux@exemple.fr"]);
    expect(traces.map((x) => x.resultat).sort()).toEqual(["coupe", "envoye"]);
  });

  it("[B-186] lecture des préférences en échec : aucun envoi facultatif", async () => {
    const { expediteur, envoyes, traces } = monter([], "echec");
    const t = valide("rapportMensuel");
    await expediteur.envoyerAuClient("rapportMensuel", { tenantId: CLIENT, role: "administrateur_client" }, variablesDe(t));
    expect(envoyes).toHaveLength(0);
    expect(traces.map((x) => x.resultat)).toEqual(["echec", "echec"]);
  });
});

function faux() {
  const appels: { texte: string; valeurs: unknown[] }[] = [];
  const c: Requeteur = { async query(texte, valeurs = []) { appels.push({ texte, valeurs }); return { rows: [{ cle_envoi: "brouillon_en_attente", activee: false, resume_hebdomadaire: false }, { cle_envoi: "resume_hebdomadaire", activee: true, resume_hebdomadaire: true }, { cle_envoi: "cle_inconnue", activee: false, resume_hebdomadaire: false }], rowCount: 1 }; } };
  return { c, appels };
}

describe("lecture et écriture SQL des préférences", () => {
  it("[B-141] la lecture filtre par client ET par utilisateur et traduit les clés stockées", async () => {
    const { c, appels } = faux();
    const lu = await lirePreferences(c, CLIENT, U1);
    expect(appels[0]!.texte).toMatch(/WHERE tenant_id = \$1 AND utilisateur = \$2/);
    expect(appels[0]!.valeurs).toEqual([CLIENT, U1]);
    expect(lu).toEqual({ desactivees: ["brouillonEnAttente"], resumeHebdomadaire: true });
  });

  it("[B-186] l'écriture d'une préférence met à jour la même ligne (ON CONFLICT), avec une clé minuscule et un id aléatoire", async () => {
    const { c, appels } = faux();
    await ecrirePreference(c, CLIENT, U1, "brouillonEnAttente", false);
    await ecrirePreference(c, CLIENT, U1, "brouillonEnAttente", true);
    expect(appels[0]!.texte).toMatch(/ON CONFLICT \(tenant_id, utilisateur, cle_envoi\) DO UPDATE SET activee = EXCLUDED.activee, maj_le = now\(\)/);
    expect(appels[0]!.valeurs.slice(0, 1).concat(appels[0]!.valeurs.slice(2))).toEqual([CLIENT, U1, "brouillon_en_attente", false]);
    expect(appels[0]!.valeurs[1]).toMatch(/^[0-9a-f-]{36}$/);
    await expect(ecrirePreference(c, CLIENT, U1, "palier100Client", false)).rejects.toThrow();
    expect(appels).toHaveLength(2);
  });

  it("[B-186] le résumé hebdomadaire s'écrit sur la ligne réservée, colonne resume_hebdomadaire", async () => {
    const { c, appels } = faux();
    await ecrireResume(c, CLIENT, U1, true);
    expect(appels[0]!.texte).toMatch(/DO UPDATE SET resume_hebdomadaire = EXCLUDED.resume_hebdomadaire/);
    expect(appels[0]!.valeurs).toContain("resume_hebdomadaire");
  });
});
