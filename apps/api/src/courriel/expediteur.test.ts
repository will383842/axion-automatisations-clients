import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TABLE_ENVOIS, type Envoi } from "../../../../packages/contrats/src/notifications/table.js";
import { creerExpediteur, type Message, type Trace, type Transport } from "./expediteur.js";
import { creerTransportZeptoMail } from "./zeptomail.js";
import { LecteurSecretsMemoire } from "../secrets.js";
import { ErreurCoffre } from "../coffre/coffre.js";

// L'alerte orange n'est pas encore dans la table des envois (contrat C-557) : le test l'ajoute à une copie.
const ORANGE: Envoi = { evenement: "alerteOrange", destinataire: "will", canal: "email", mode: "automatique", interrupteur: "envoi.alerteOrange", cleTexte: null, version: "V1", exigence: "B-394" };
const TABLE: readonly Envoi[] = [...TABLE_ENVOIS, ORANGE];
const EQUIPE = { role: "will", adresse: "equipe@exemple.fr" } as const;
const VARIABLES = { client: "Lemoine Rénovation", automatisation: "Relance des devis", codeErreur: "E-CONNEXION-401" };

function monter(ouverts: string[] = ["envoi.alerteOrange"]) {
  const envoyes: Message[] = [];
  const traces: Trace[] = [];
  const transport: Transport = { async envoyer(m) { envoyes.push(m); } };
  const expediteur = creerExpediteur({ table: TABLE, transport, interrupteurs: { ouvert: (nom) => ouverts.includes(nom) }, trace: { ecrire: (t) => void traces.push(t) } });
  return { expediteur, envoyes, traces };
}

describe("expéditeur d'e-mails de service", () => {
  it("[C-026] l'e-mail orange ne contient que client, automatisation et code d'erreur", async () => {
    const { expediteur, envoyes } = monter();
    await expediteur.envoyer("alerteOrange", EQUIPE, VARIABLES);
    expect(envoyes).toHaveLength(1);
    const texte = `${envoyes[0]!.sujet}\n${envoyes[0]!.texte}`;
    for (const v of Object.values(VARIABLES)) expect(texte).toContain(v);
    await expect(expediteur.envoyer("alerteOrange", EQUIPE, { ...VARIABLES, contenu: "Bonjour Mme Dupont, devis de 3000" })).rejects.toThrow(/variable/);
    expect(envoyes).toHaveLength(1);
  });

  it("[B-394] orange → un e-mail part vers l'équipe (le transport reçoit une seule fois le message)", async () => {
    const { expediteur, envoyes } = monter();
    await expediteur.envoyer("alerteOrange", EQUIPE, VARIABLES);
    expect(envoyes).toHaveLength(1);
    expect(envoyes[0]!.a).toBe(EQUIPE.adresse);
  });

  it("[C-026] une variable manquante ou à plusieurs lignes est refusée", async () => {
    const { expediteur, envoyes } = monter();
    await expect(expediteur.envoyer("alerteOrange", EQUIPE, { client: VARIABLES.client, automatisation: VARIABLES.automatisation })).rejects.toThrow(/variable/);
    await expect(expediteur.envoyer("alerteOrange", EQUIPE, { ...VARIABLES, codeErreur: "E-1\r\nBcc: autre@exemple.fr" })).rejects.toThrow(/variable/);
    expect(envoyes).toHaveLength(0);
  });

  it("[A-116] une clé d'envoi absente de la table → refus", async () => {
    const { expediteur, envoyes, traces } = monter(["envoi.inconnue"]);
    await expect(expediteur.envoyer("inconnue", EQUIPE, {})).rejects.toThrow(/table des envois/);
    expect(envoyes).toHaveLength(0);
    expect(traces.at(-1)?.resultat).toBe("refuse");
  });

  it("[A-116] interrupteur fermé → aucun envoi, ligne de trace « coupé »", async () => {
    const { expediteur, envoyes, traces } = monter([]);
    await expediteur.envoyer("alerteOrange", EQUIPE, VARIABLES);
    expect(envoyes).toHaveLength(0);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ cle: "alerteOrange", resultat: "coupe" });
    expect(traces[0]!.destinataireHache).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(traces)).not.toContain(EQUIPE.adresse);
  });

  it("[A-116] un destinataire forgé (autre rôle, adresse à en-têtes) est refusé", async () => {
    const { expediteur, envoyes } = monter();
    await expect(expediteur.envoyer("alerteOrange", { role: "administrateur_client", adresse: "client@exemple.fr" }, VARIABLES)).rejects.toThrow(/destinataire/);
    await expect(expediteur.envoyer("alerteOrange", { role: "will", adresse: "a@exemple.fr\r\nBcc: b@exemple.fr" }, VARIABLES)).rejects.toThrow(/destinataire/);
    await expect(expediteur.envoyer("alerteOrange", { role: "will", adresse: "a@exemple.fr, b@exemple.fr" }, VARIABLES)).rejects.toThrow(/destinataire/);
    expect(envoyes).toHaveLength(0);
  });

  it("[A-116] un envoi accepté laisse une trace : clé, destinataire haché, date", async () => {
    const { expediteur, traces } = monter();
    await expediteur.envoyer("alerteOrange", EQUIPE, VARIABLES);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ cle: "alerteOrange", resultat: "envoye" });
    expect(Number.isNaN(Date.parse(traces[0]!.date))).toBe(false);
  });

  it("[A-116] une clé de la table sans gabarit d'équipe est refusée (le lot 6 ajoute les textes des clients)", async () => {
    const { expediteur, envoyes } = monter(["envoi.rapportMensuel"]);
    await expect(expediteur.envoyer("rapportMensuel", { role: "administrateur_client", adresse: "x@exemple.fr" }, {})).rejects.toThrow(/gabarit/);
    expect(envoyes).toHaveLength(0);
  });
});

describe("clé d'envoi ZeptoMail", () => {
  const marqueur = `TEST-NE-PAS-UTILISER-zepto-${randomBytes(8).toString("hex")}`;

  it("[LOT5-secret] la clé ZeptoMail n'apparaît dans aucune trace ni aucune erreur (marqueur unique)", async () => {
    const lignes: string[] = [];
    const appels: { url: string; auth: string | null }[] = [];
    const fetchFaux: typeof fetch = async (u, init) => {
      appels.push({ url: String(u), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ error: { message: `refus pour ${marqueur}` } }), { status: 500 });
    };
    const lecteur = new LecteurSecretsMemoire({ "plateforme/zeptomail": marqueur });
    const transport = await creerTransportZeptoMail({ lecteur, fetch: fetchFaux, de: "service@exemple.fr" });
    const expediteur = creerExpediteur({ table: TABLE, transport, interrupteurs: { ouvert: () => true }, trace: { ecrire: (t) => void lignes.push(JSON.stringify(t)) } });
    const erreur = await expediteur.envoyer("alerteOrange", EQUIPE, VARIABLES).catch((e: unknown) => e as Error);
    expect(erreur, "témoin : le fournisseur a répondu en erreur").toBeInstanceOf(Error);
    expect(appels[0]?.auth, "témoin : la clé part bien dans l'en-tête").toContain(marqueur);
    expect(`${(erreur as Error).message}${(erreur as Error).stack ?? ""}${lignes.join("")}`).not.toContain(marqueur);
  });

  it("[LOT5-secret] coffre scellé → l'expéditeur refuse d'envoyer, aucune valeur de repli", async () => {
    const lecteur = { async lire(): Promise<string> { throw new ErreurCoffre("coffre_scelle"); } };
    let appele = false;
    const fetchFaux: typeof fetch = async () => { appele = true; return new Response("{}", { status: 200 }); };
    await expect(creerTransportZeptoMail({ lecteur, fetch: fetchFaux, de: "service@exemple.fr" })).rejects.toThrow();
    expect(appele).toBe(false);
  });

  it("[LOT5-secret] la clé est lue au chemin plateforme/zeptomail", async () => {
    const lus: string[] = [];
    const lecteur = { async lire(nom: string) { lus.push(nom); return marqueur; } };
    await creerTransportZeptoMail({ lecteur, fetch, de: "service@exemple.fr" });
    expect(lus).toEqual(["plateforme/zeptomail"]);
  });
});
