import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TABLE_ENVOIS } from "../notifications/table.ts";
import { CATALOGUE_EMAILS, PIED_EMAIL } from "./catalogue.ts";

const lexique = JSON.parse(
  readFileSync(new URL("../../../../scripts/lexique-interdit.json", import.meta.url), "utf8"),
) as { mots: string[] };

const entrees = Object.entries(CATALOGUE_EMAILS) as [string, (typeof CATALOGUE_EMAILS)[keyof typeof CATALOGUE_EMAILS]][];
const textesDe = (t: { sujet: string; corps: string; bouton?: string }) =>
  [t.sujet, t.corps, t.bouton ?? ""].join("\n");
const variablesUtilisees = (t: { sujet: string; corps: string; bouton?: string }) =>
  new Set([...textesDe(t).matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1] as string));

function sources(dossier: string): string[] {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    return statSync(chemin).isDirectory() ? sources(chemin) : [chemin];
  });
}

describe("[C-557] catalogue des e-mails", () => {
  it("[C-557] chaque ligne de la table a sa clé de texte email.<evenement> présente au catalogue", () => {
    for (const e of TABLE_ENVOIS) {
      expect(e.cleTexte, e.evenement).toBe(`email.${e.evenement}`);
      expect(Object.keys(CATALOGUE_EMAILS), e.evenement).toContain(e.cleTexte);
    }
  });

  it("[C-557] le catalogue n'a aucune clé sans ligne dans la table", () => {
    const cles = new Set(TABLE_ENVOIS.map((e) => e.cleTexte));
    for (const cle of Object.keys(CATALOGUE_EMAILS)) expect(cles.has(cle), cle).toBe(true);
    expect(Object.keys(CATALOGUE_EMAILS)).toHaveLength(TABLE_ENVOIS.length);
  });

  it("[C-557] chaque clé envoi.* de la table a sa ligne et son texte", () => {
    for (const e of TABLE_ENVOIS) {
      expect(e.interrupteur, e.evenement).toBe(`envoi.${e.evenement}`);
      const texte = (CATALOGUE_EMAILS as Record<string, { sujet: string; corps: string }>)[`email.${e.evenement}`];
      expect(texte?.sujet.length, e.evenement).toBeGreaterThan(0);
      expect(texte?.corps.length, e.evenement).toBeGreaterThan(0);
    }
  });

  it("[C-557] toute variable utilisée est déclarée, toute variable déclarée est utilisée", () => {
    for (const [cle, t] of entrees) {
      expect([...variablesUtilisees(t)].sort(), cle).toEqual([...t.variables].sort());
    }
  });

  it("[C-557] aucun texte ne contient de chiffre, « € », « HT », « TTC », « prix » ni « tarif »", () => {
    for (const [cle, t] of entrees) {
      const texte = `${textesDe(t)}\n${PIED_EMAIL}`;
      expect(texte, cle).not.toMatch(/\d/);
      expect(texte, cle).not.toMatch(/€|\b(HT|TTC)\b|prix|tarif/i);
    }
  });

  it("[C-557] aucun texte ne contient « tu », un émoji, « Grenoble », « Aucun gain garanti » ni un mot de lexique-interdit.json", () => {
    expect(lexique.mots.length).toBeGreaterThan(0);
    for (const [cle, t] of entrees) {
      const texte = `${textesDe(t)}\n${PIED_EMAIL}`;
      expect(texte, cle).not.toMatch(/(?<!\p{L})(tu|ton|ta|tes|toi)(?!\p{L})/iu);
      expect(texte, cle).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(texte, cle).not.toMatch(/grenoble|aucun gain garanti/i);
      for (const mot of lexique.mots) expect(texte, `${cle} ${mot}`).not.toMatch(new RegExp(`(?<!\\p{L})${mot}(?!\\p{L})`, "iu"));
    }
  });

  it("[C-557] chaque texte commence par AXION IA et finit par le pied commun", () => {
    expect(PIED_EMAIL).toContain("{adresseSupport}");
    for (const [cle, t] of entrees) {
      expect(t.corps.startsWith("AXION IA"), cle).toBe(true);
      expect(t.corps.endsWith(PIED_EMAIL), cle).toBe(true);
      expect(t.variables, cle).toContain("adresseSupport");
    }
  });

  it("[C-557] toutes les entrées livrées par T6-24a sont « a_valider »", () => {
    for (const [cle, t] of entrees) expect(t.validation, cle).toBe("a_valider");
  });

  it("[C-557] aucune pièce jointe : un lien est une variable dont le nom commence par « lien »", () => {
    for (const [cle, t] of entrees) {
      expect(textesDe(t), cle).not.toMatch(/https?:\/\//i);
      for (const v of t.variables) {
        if (/^lien/i.test(v)) expect(v, cle).toMatch(/^lien[A-Z]/);
      }
    }
  });

  it("[C-557] packages/contrats n'importe rien de packages/design", () => {
    const racine = new URL("../", import.meta.url).pathname;
    for (const fichier of sources(racine).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))) {
      expect(readFileSync(fichier, "utf8"), fichier).not.toMatch(/packages\/design|@axion-auto\/design/);
    }
  });
});
