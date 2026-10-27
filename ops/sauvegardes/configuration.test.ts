import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

// Lectures statiques de la configuration des sauvegardes : elles complètent les essais en conteneurs (tests/socle/sauvegardes.int.test.ts),
// qui ne tournent que dans le job socle-integration.
const lire = (chemin: string) => readFileSync(new URL(chemin, import.meta.url), "utf8");
const compose = lire("../socle/compose.sauvegardes.yml");
const modele = lire("./pgbackrest.conf.modele");
const nuit = lire("./sauvegarder-nuit.sh");
const archiveur = lire("./pgbackrest-archiver");
const bases = lire("../socle/postgres/init/01-bases.sql");
const lignesActives = (texte: string) => texte.split("\n").filter((l) => !/^\s*(#|--)/.test(l));
const services = (load(compose) as { services: Record<string, { entrypoint?: string[]; volumes?: string[]; environment?: Record<string, string> }> }).services;

describe("configuration des sauvegardes (lecture statique)", () => {
  it("[C-045] l'archivage continu passe par pgBackRest vers la cible SFTP", () => {
    expect(compose).toMatch(/archive_mode=on/);
    expect(services["postgres"]?.environment?.["C"]).toBe("archive_command=/opt/sauvegardes/pgbackrest-archiver %p");
    expect(lignesActives(archiveur).join("\n")).toMatch(/pgbackrest archive-push/);
    expect(lignesActives(modele)).toContain("repo1-type=sftp");
  });

  it("[C-044] archive_timeout vaut 300 s au plus (un journal part au moins toutes les 5 minutes)", () => {
    const m = /archive_timeout=(\d+)/.exec(compose);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(0);
    expect(Number(m?.[1])).toBeLessThanOrEqual(300);
  });

  it("[C-046] les deux dépôts sont chiffrés en AES-256 avant de quitter le serveur", () => {
    expect(lignesActives(modele)).toContain("repo1-cipher-type=aes-256-cbc");
    expect(lignesActives(modele)).toContain("repo2-cipher-type=aes-256-cbc");
  });

  it("[C-049] 30 complètes dans le premier dépôt, 12 mensuelles dans le second, lancées par la sauvegarde de nuit", () => {
    expect(lignesActives(modele)).toContain("repo1-retention-full=30");
    expect(lignesActives(modele)).toContain("repo2-retention-full=12");
    expect(lignesActives(modele)).toContain("repo2-type=sftp");
    expect(nuit).toMatch(/--repo=2/);
    expect(nuit).toMatch(/--type=full backup/);
  });

  it("[A-196] la phrase est lue avant toute sauvegarde chiffrée, jamais d'un dépôt en clair", () => {
    expect(lignesActives(modele).some((l) => /cipher-type=none/.test(l))).toBe(false);
    expect(nuit.indexOf("lire-phrase-chiffrement.sh")).toBeGreaterThan(-1);
    expect(nuit.indexOf("lire-phrase-chiffrement.sh")).toBeLessThan(nuit.indexOf("backup"));
  });

  it("[C-593] la phrase de chiffrement n'est écrite ni dans le modèle ni dans le compose ni en dur dans un script (lue à l'usage)", () => {
    expect(lignesActives(modele).some((l) => /cipher-pass/.test(l))).toBe(false);
    expect(compose).not.toMatch(/CIPHER_PASS/);
    for (const script of [nuit, archiveur]) {
      const affectations = lignesActives(script).join("\n").match(/CIPHER_PASS=\S+/g) ?? [];
      expect(affectations.length).toBeGreaterThan(0);
      for (const a of affectations) expect(a).toMatch(/^CIPHER_PASS="?\$/);
    }
  });

  it("[C-593] la cible SFTP ne reçoit que la clé publique, jamais la clé privée ni la phrase", () => {
    const montes = (services["sftp-essai"]?.volumes ?? []).join(" ");
    expect(montes).toMatch(/cles-pub/);
    expect(montes).not.toMatch(/cles-sauvegarde/);
  });

  it("[C-045] une configuration absente ou double arrête le démarrage de PostgreSQL au lieu de le laisser sans archivage", () => {
    const entree = (services["postgres"]?.entrypoint ?? []).join(" ");
    expect(entree).toMatch(/eval "\$\$Q" &&/);
    expect(services["postgres"]?.environment?.["Q"]).toMatch(/&&/);
  });

  it("[C-052] la grappe commune ne crée aucune base cli_", () => {
    const creees = lignesActives(bases).join("\n").match(/create database\s+"?(\w+)"?/gi) ?? [];
    expect(creees.length).toBeGreaterThanOrEqual(4);
    expect(creees.some((c) => /cli_/i.test(c))).toBe(false);
  });
});
