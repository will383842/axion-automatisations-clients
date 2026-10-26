import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Lectures statiques de la configuration des sauvegardes : elles complètent les essais en conteneurs (tests/socle/sauvegardes.int.test.ts),
// qui ne tournent que dans le job socle-integration.
const lire = (chemin: string) => readFileSync(new URL(chemin, import.meta.url), "utf8");
const compose = lire("../socle/compose.sauvegardes.yml");
const modele = lire("./pgbackrest.conf.modele");
const nuit = lire("./sauvegarder-nuit.sh");
const bases = lire("../socle/postgres/init/01-bases.sql");
const lignesActives = (texte: string) => texte.split("\n").filter((l) => !/^\s*(#|--)/.test(l));

describe("configuration des sauvegardes (lecture statique)", () => {
  it("[C-045] l'archivage continu passe par pgBackRest vers la cible SFTP", () => {
    expect(compose).toMatch(/archive_mode=on/);
    expect(compose).toMatch(/archive_command=/);
    expect(compose).toMatch(/pgbackrest archive-push %p/);
    expect(lignesActives(modele)).toContain("repo1-type=sftp");
  });

  it("[C-044] archive_timeout vaut 300 s au plus (un journal part au moins toutes les 5 minutes)", () => {
    const m = /archive_timeout=(\d+)/.exec(compose);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(0);
    expect(Number(m?.[1])).toBeLessThanOrEqual(300);
  });

  it("[C-046] le dépôt est chiffré en AES-256 avant de quitter le serveur", () => {
    expect(lignesActives(modele)).toContain("repo1-cipher-type=aes-256-cbc");
  });

  it("[A-196] la phrase est lue avant toute sauvegarde chiffrée, jamais d'un dépôt en clair", () => {
    expect(lignesActives(modele).some((l) => /^repo1-cipher-type=none/.test(l))).toBe(false);
    expect(nuit.indexOf("lire-phrase-chiffrement.sh")).toBeGreaterThan(-1);
    expect(nuit.indexOf("lire-phrase-chiffrement.sh")).toBeLessThan(nuit.indexOf("backup"));
  });

  it("[C-593] la phrase de chiffrement n'est écrite ni dans le modèle ni dans le compose (lue à l'usage)", () => {
    expect(lignesActives(modele).some((l) => /cipher-pass/.test(l))).toBe(false);
    // Dans le compose, la variable n'est jamais affectée à une valeur littérale : seulement à une substitution de commande.
    const affectations = compose.match(/CIPHER_PASS=\S+/g) ?? [];
    expect(affectations.length).toBeGreaterThan(0);
    for (const a of affectations) expect(a).toMatch(/^CIPHER_PASS=\$\$\(/);
  });

  it("[C-052] la grappe commune ne crée aucune base cli_", () => {
    const creees = lignesActives(bases).join("\n").match(/create database\s+"?(\w+)"?/gi) ?? [];
    expect(creees.length).toBeGreaterThanOrEqual(4);
    expect(creees.some((c) => /cli_/i.test(c))).toBe(false);
  });
});
