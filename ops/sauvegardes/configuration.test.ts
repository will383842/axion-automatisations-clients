import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Lectures statiques de la configuration des sauvegardes : elles complètent les essais en conteneurs (tests/socle/sauvegardes.int.test.ts),
// qui ne tournent que dans le job socle-integration.
const lire = (chemin: string) => readFileSync(new URL(chemin, import.meta.url), "utf8");
const compose = lire("../socle/compose.sauvegardes.yml");
const modele = lire("./pgbackrest.conf.modele");
const nuit = lire("./sauvegarder-nuit.sh");
const preparer = lire("./preparer-configuration.sh");
const phrase = lire("./lire-phrase-chiffrement.sh");
const expirer = lire("./expirer.sh");
const restaurer = lire("./restaurer.sh");
const bases = lire("../socle/postgres/init/01-bases.sql");
const lignesActives = (texte: string) => texte.split("\n").filter((l) => !/^\s*(#|--)/.test(l));
// Bloc d'un service du compose (de « nom: » au service ou à la section suivante, au même niveau).
const service = (nom: string) => new RegExp(`^  ${nom}:\\n(?:(?:    .*|)\\n)+`, "m").exec(compose)?.[0] ?? "";

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

  it("[C-046] la cible d'essai ne reçoit que la clé publique : ni la clé privée ni la phrase ne sont montées chez elle", () => {
    const cible = service("sftp-essai");
    expect(cible).not.toBe("");
    expect(cible).toMatch(/cle-publique:\/home\/sauv\/\.ssh\/keys:ro/);
    expect(cible).not.toMatch(/cles-sauvegarde/);
    // Droits : clé privée et phrase en 0600 chez postgres seul, dossier en 0700.
    const cle = service("cle-essai");
    expect(cle).toMatch(/chmod 600 \/cles\/id \/cles\/phrase/);
    expect(cle).toMatch(/chmod 700 \/cles \/pub/);
    expect(cle).toMatch(/chown postgres:postgres \/cles \/cles\/id \/cles\/phrase/);
    expect(cle).not.toMatch(/chmod 644/);
  });

  it("[A-196] la phrase est lue avant toute sauvegarde chiffrée, jamais d'un dépôt en clair", () => {
    expect(lignesActives(modele).some((l) => /^repo1-cipher-type=none/.test(l))).toBe(false);
    expect(nuit.indexOf("lire-phrase-chiffrement.sh")).toBeGreaterThan(-1);
    expect(nuit.indexOf("lire-phrase-chiffrement.sh")).toBeLessThan(nuit.indexOf("pgbackrest --stanza"));
    // Le comportement (arrêt sans phrase, dépôt aes-256-cbc) est prouvé en conteneur : test « [A-196] » de tests/socle/sauvegardes.int.test.ts.
  });

  it("[C-593] la phrase de chiffrement n'est écrite ni dans le modèle ni dans le compose (lue une fois au démarrage, gardée en mémoire)", () => {
    expect(lignesActives(modele).some((l) => /cipher-pass/.test(l))).toBe(false);
    expect(compose).not.toMatch(/CIPHER_PASS/i);
    // La configuration qui porte la phrase est sur un tmpfs, en 0400, et ne se crée que si elle est sous /dev/shm.
    expect(compose).toMatch(/PGBACKREST_CONFIG: \/dev\/shm\//);
    expect(preparer).toMatch(/umask 277/);
    expect(preparer).toMatch(/\/dev\/shm\/\*\)/);
  });

  it("[C-593] archive_command n'appelle jamais OpenBao : la file d'archivage ne dépend pas du coffre", () => {
    const archive = /^\s*C: (archive_command=.*)$/m.exec(compose)?.[1] ?? "";
    expect(archive).toBe("archive_command=pgbackrest archive-push %p");
    expect(archive).not.toMatch(/lire-phrase|OPENBAO|BAO_/);
    // La phrase est lue au démarrage ; si elle est illisible, le conteneur ne démarre pas (pas de serveur qui archive sans clé).
    expect(compose).toMatch(/R: set -- \$\$L; \[ \$\$# -eq 1 \] && "\$\$1" && eval "\$\$G"/);
    expect(compose).toMatch(/entrypoint: \['sh', '-c', 'eval "\$\$R" && eval "\$\$E"'\]/);
    expect(preparer).toMatch(/lire-phrase-chiffrement\.sh/);
  });

  it("[C-593] la configuration est préparée à partir d'UN seul modèle, et l'absence de vérification de l'hôte SFTP est refusée hors essai", () => {
    expect(preparer).toMatch(/\$\{#modeles\[@\]\}" -eq 1/);
    expect(preparer).toMatch(/host-key-check-type/);
    expect(preparer).toMatch(/SAUVEGARDE_ESSAI:-\}" != "1"/);
    expect(compose).toMatch(/\[ \$\$# -eq 1 \]/);
  });

  it("[C-593] lire-phrase-chiffrement.sh : adresse d'OpenBao au format http://hote:port (comme la passerelle), HTTPS refusé, 32 caractères au moins", () => {
    expect(phrase).toMatch(/BAO_ADDR/);
    expect(phrase).toMatch(/https:\/\/\*\)/);
    expect(phrase).toMatch(/-ge 32/);
  });

  it("[C-049] la rétention est pilotée par retention.ts : expirer.sh l'appelle, pgBackRest n'expire rien seul, la sauvegarde de nuit n'expire pas", () => {
    expect(expirer).toMatch(/retention\.ts/);
    expect(expirer).toMatch(/expire/);
    expect(expirer).toMatch(/--simuler/);
    const actives = lignesActives(modele);
    expect(actives).toContain("repo1-retention-full-type=count");
    expect(actives).toContain("repo1-retention-full=9999");
    expect(actives).toContain("repo1-retention-archive-type=full");
    expect(actives).toContain("repo1-retention-archive=30");
    expect(lignesActives(nuit).some((l) => /\bexpire\b/.test(l))).toBe(false);
  });

  it("[C-045] restaurer.sh : mode essai explicite (défaut 0), accès au coffre transmis au conteneur, nettoyage en cas d'échec", () => {
    expect(restaurer).toMatch(/SAUVEGARDE_ESSAI:-0/);
    expect(restaurer).toMatch(/-e BAO_ADDR -e BAO_JETON_FICHIER/);
    expect(restaurer).toMatch(/:ro"\)/);
    expect(restaurer).toMatch(/trap nettoyer EXIT/);
    expect(restaurer).toMatch(/docker rm -f -v "\$nom"/);
  });

  it("[C-052] la grappe commune ne crée aucune base cli_", () => {
    const creees = lignesActives(bases).join("\n").match(/create database\s+"?(\w+)"?/gi) ?? [];
    expect(creees.length).toBeGreaterThanOrEqual(4);
    expect(creees.some((c) => /cli_/i.test(c))).toBe(false);
  });
});
