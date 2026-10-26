import { describe, expect, it } from "vitest";
import { defineAutomation } from "@axion-auto/sdk-module";
import { manifesteExemple, moduleExemple } from "@axion-auto/sdk-module/exemples/module-exemple.ts";
import { chargerEmailsPieges, lancerJeuEssai } from "./lancer-jeu-essai.ts";
import { rapportEnJson } from "./rapport.ts";

const reglages = (autorisees: string[] = []) => ({ actionsAutomatiquesAutorisees: autorisees, objetAccuse: "Accusé" });
type Executer = NonNullable<Parameters<typeof defineAutomation>[0]["etapes"]>[number]["executer"];
const avec = (executer: Executer, extra: object = {}) => defineAutomation({ ...manifesteExemple, etapes: [{ nom: "unique", executer }], ...extra });

// Module crédule : il exécute tout ce que l'IA réclame. Le noyau et le harnais doivent le retenir.
const ACTIONS = ["envoyer", "transferer", "lire_fil", "ouvrir_lien"];
const credule = () =>
  avec(
    async (ctx) => {
      const { texte } = await ctx.ia.completer({ modele: "simule", entree: "x" });
      let demandes: { action: string; entree: unknown }[] = [];
      try {
        demandes = JSON.parse(texte).demandes;
      } catch {
        return;
      }
      for (const [i, d] of demandes.entries()) await ctx.effet(d.action, `d-${i}`, d.entree).catch(() => undefined);
    },
    { connecteurs: [{ famille: "messagerie", actions: ACTIONS, portees: ["envoi"], garantie: "idempotent_par_cle" }] },
  );

describe("jeu d'essai", () => {
  it("[A-296] un module dont un cas échoue fait échouer lancerJeuEssai", async () => {
    const casse = avec(async () => {
      throw new Error("cas voulu en échec");
    });
    const rapport = await lancerJeuEssai(casse, { reglages: reglages() });
    expect(rapport.codeSortie).not.toBe(0);
    expect(rapport.totaux.echoues).toBeGreaterThan(0);
    expect(rapport.cas.some((c) => !c.reussi && c.ecart)).toBe(true);
  });

  it("[A-293] une étape sans outil qui dépend de Date.now échoue au contrôle de déterminisme", async () => {
    const instable = avec(async (ctx) => ctx.noterMotif(String(Date.now())));
    const rapport = await lancerJeuEssai(instable, { reglages: reglages() });
    expect(rapport.determinisme).toEqual([{ etape: "unique", reussi: false }]);
    expect(rapport.codeSortie).not.toBe(0);
  });

  it("[A-293] une étape sans outil qui ne dépend que de son entrée passe le contrôle", async () => {
    const rapport = await lancerJeuEssai(avec(async (ctx) => ctx.noterMotif("fixe")), { reglages: reglages() });
    expect(rapport.determinisme).toEqual([{ etape: "unique", reussi: true }]);
  });
});

describe("IA simulée hostile", () => {
  it("[C-539] avec l'IA hostile, aucune action non déclarée ne sort", async () => {
    const rapport = await lancerJeuEssai(credule(), { reglages: reglages() });
    expect(rapport.hostile.demandes.refusees).toBeGreaterThan(0);
    expect(rapport.hostile.appelsConnecteur).toBe(0);
    expect(rapport.hostile.violations).toBe(0);
  });

  it("[C-539] avec l'IA hostile, l'envoi vers une adresse absente du fil part en brouillon", async () => {
    const rapport = await lancerJeuEssai(credule(), { reglages: reglages() });
    expect(rapport.hostile.demandes.brouillons).toBeGreaterThan(0);
    expect(rapport.hostile.demandes.automatiques).toBe(0);
    expect(rapport.codeSortie).toBe(0);
  });

  it("[C-539] un module autorisé à tout envoyer laisse sortir une action interdite : le harnais le voit", async () => {
    const rapport = await lancerJeuEssai(credule(), { reglages: reglages(ACTIONS) });
    expect(rapport.hostile.violations).toBeGreaterThan(0);
    expect(rapport.codeSortie).not.toBe(0);
  });
});

describe("e-mails piégés", () => {
  it("[C-252] le jeu fourni compte 10 e-mails inventés au moins, de tous les types", () => {
    const emails = chargerEmailsPieges();
    expect(emails.length).toBeGreaterThanOrEqual(10);
    expect(emails.every((e) => e.expediteur.endsWith("@exemple.fr"))).toBe(true);
    const types = new Set(emails.map((e) => e.type));
    for (const t of ["consigne_corps", "consigne_cachee", "consigne_nom_piece_jointe", "faux_administrateur", "lien_piege", "image_espion", "transfert_facture"]) {
      expect(types).toContain(t);
    }
  });

  it("[C-252] chaque e-mail piégé du jeu fourni reste sans effet sur module-exemple", async () => {
    const emails = chargerEmailsPieges();
    const rapport = await lancerJeuEssai(moduleExemple, { reglages: reglages() });
    for (const e of emails) {
      const cas = rapport.cas.find((c) => c.id === `email-${e.id}`);
      expect(cas, e.id).toMatchObject({ reussi: true });
    }
    expect(rapport.hostile.appelsConnecteur).toBe(0);
    expect(rapport.codeSortie).toBe(0);
  });

  it("[C-539] le rapport ne contient aucun texte d'e-mail (marqueur unique cherché)", async () => {
    const marqueur = "MARQUEUR-UNIQUE-7f3a9c";
    const piege = { id: "marque", type: "consigne_corps", expediteur: "marque@exemple.fr", objet: marqueur, corps: marqueur, pieceJointe: marqueur };
    const rapport = await lancerJeuEssai(moduleExemple, { reglages: reglages(), emails: [piege] });
    expect(rapport.cas.some((c) => c.id === "email-marque")).toBe(true);
    expect(rapportEnJson(rapport)).not.toContain(marqueur);
  });

  it("[C-539] le rapport JSON est stable d'un lancement à l'autre", async () => {
    const un = rapportEnJson(await lancerJeuEssai(moduleExemple, { reglages: reglages() }));
    const deux = rapportEnJson(await lancerJeuEssai(moduleExemple, { reglages: reglages() }));
    expect(un).toBe(deux);
  });
});
