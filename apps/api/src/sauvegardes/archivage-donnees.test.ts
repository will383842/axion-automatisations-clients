import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Lectures statiques de l'archivage continu de la grappe « données » (T2-39). Les essais en conteneurs relèvent du job socle-integration.
const lire = (chemin: string) => readFileSync(new URL(`../../../../${chemin}`, import.meta.url), "utf8");
const composeDonnees = lire("ops/socle/compose.sauvegardes-donnees.yml");
const composeCommun = lire("ops/socle/compose.sauvegardes.yml");
const confDonnees = lire("ops/sauvegardes/pgbackrest-donnees.conf.modele");
const confCommune = lire("ops/sauvegardes/pgbackrest.conf.modele");
const valeur = (texte: string, cle: string) => new RegExp(`^${cle}=(.*)$`, "m").exec(texte)?.[1];

describe("archivage continu de la grappe données", () => {
  it("[A-237] l'archivage continu de la grappe données est actif dans un dépôt distinct de la grappe commune", () => {
    expect(composeDonnees).toMatch(/archive_mode=on/);
    expect(composeDonnees).toMatch(/archive_timeout=300/);
    expect(composeDonnees).toMatch(/archive_command=pgbackrest archive-push/);
    expect(composeDonnees).toMatch(/PGBACKREST_STANZA: donnees\b/);
    expect(confDonnees).toMatch(/^\[donnees\]$/m);
    // dépôt distinct : autre hôte de cible, autres volumes, autre stanza
    expect(valeur(confDonnees, "repo1-sftp-host")).not.toBe(valeur(confCommune, "repo1-sftp-host"));
    expect(valeur(confDonnees, "repo1-sftp-host")).toBeTruthy();
    expect(composeDonnees).toMatch(/\n {2}sftp-essai-donnees:/);
  });

  it("[A-237] le dépôt de la grappe données a sa propre phrase : il ne se restaure pas avec celle de la grappe commune", () => {
    expect(confDonnees).not.toMatch(/repo1-cipher-pass/); // jamais de phrase dans le modèle
    expect(confDonnees).toMatch(/^repo1-cipher-type=aes-256-cbc$/m);
    for (const volume of ["cles-sauvegarde", "depot-sauvegardes", "cle-publique"]) {
      expect(composeDonnees.match(new RegExp(`(^|[^-\\w])${volume}(:|\\b\\s*:)`, "g")) ?? []).toEqual([]); // aucun volume du dépôt commun
      expect(composeCommun).toMatch(new RegExp(volume));
    }
    expect(composeDonnees).toMatch(/cles-sauvegarde-donnees/);
    expect(composeDonnees).toMatch(/openssl rand -hex 32/);
  });

  it("[A-237] la rétention de ce dépôt est courte (7 jours, configurable) : les dumps par client portent la conservation longue", () => {
    expect(valeur(confDonnees, "repo1-retention-full-type")).toBe("time");
    expect(valeur(confDonnees, "repo1-retention-full")).toBe("7");
    expect(lire("ops/sauvegardes/README.md")).toMatch(/## Bases des clients/);
  });

  it("[A-237] la grappe données garde ses réglages de connexion : l'archivage s'ajoute, il ne les remplace pas", () => {
    const base = /P: (-c max_connections=263 -c superuser_reserved_connections=3 -c reserved_connections=10)/.exec(lire("ops/socle/compose.donnees.yml"))?.[1];
    expect(base).toBeTruthy();
    expect(composeDonnees).toContain(base!);
  });
});
