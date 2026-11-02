import { execFile, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
const dossierScripts = fileURLToPath(new URL(".", import.meta.url));
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

  it("[C-593] lire-phrase-chiffrement.sh : seul HTTPS est accepté hors essai (certificat vérifié), http:// est refusé, 32 caractères au moins", () => {
    expect(phrase).toMatch(/BAO_ADDR/);
    expect(phrase).toMatch(/https:\/\/\*\)/);
    expect(phrase).toMatch(/BAO_CA_FICHIER/);
    expect(phrase).toMatch(/-verify_return_error/);
    expect(phrase).toMatch(/BAO_ESSAI_SANS_TLS/);
    expect(phrase).toMatch(/-ge 32/);
  });

  it("[C-593] lire-phrase-chiffrement.sh refuse une adresse http hors mode essai, avant toute lecture du jeton", () => {
    const jeton = join(mkdtempSync(join(tmpdir(), "sauv-")), "jeton");
    writeFileSync(jeton, "s.jeton-factice");
    const r = spawnSync(join(dossierScripts, "lire-phrase-chiffrement.sh"), [], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, BAO_ADDR: "http://openbao.test:8200", BAO_JETON_FICHIER: jeton, SAUVEGARDE_ESSAI: "0" },
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/http:\/\/ refusé hors essai/);
  });

  it("[C-593] lire-phrase-chiffrement.sh lit la phrase en HTTPS quand le certificat est signé par l'autorité donnée, et la refuse sinon", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sauv-tls-"));
    try {
      const ac = (nom: string) => {
        const o = (...a: string[]) => expect(spawnSync("openssl", a, { cwd: tmp }).status, `openssl ${a[0]}`).toBe(0);
        o("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${nom}-ac.key`, "-out", `${nom}-ac.pem`, "-subj", `/CN=ac-${nom}.test`, "-days", "2");
        o("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${nom}.key`, "-out", `${nom}.csr`, "-subj", "/CN=localhost");
        writeFileSync(join(tmp, `${nom}.ext`), "subjectAltName=DNS:localhost\n");
        o("x509", "-req", "-in", `${nom}.csr`, "-CA", `${nom}-ac.pem`, "-CAkey", `${nom}-ac.key`, "-CAcreateserial", "-out", `${nom}.pem`, "-days", "2", "-extfile", `${nom}.ext`);
      };
      ac("bon");
      ac("autre");
      const phraseOk = "p".repeat(40);
      const serveur = createServer({ key: readFileSync(join(tmp, "bon.key")), cert: readFileSync(join(tmp, "bon.pem")) }, (req, rep) => {
        const ok = req.url === "/v1/technique/data/sauvegardes" && req.headers["x-vault-token"] === "s.jeton-factice";
        rep.statusCode = ok ? 200 : 403;
        rep.end(ok ? JSON.stringify({ data: { data: { phrase: phraseOk } } }) : "{}");
      });
      await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
      const port = (serveur.address() as AddressInfo).port;
      const jeton = join(tmp, "jeton");
      writeFileSync(jeton, "s.jeton-factice");
      const lire = (autorite: string) =>
        new Promise<{ code: number | null; out: string; err: string }>((ok) => {
          const enfant = execFile(
            join(dossierScripts, "lire-phrase-chiffrement.sh"),
            [],
            { env: { PATH: process.env.PATH, BAO_ADDR: `https://localhost:${port}`, BAO_JETON_FICHIER: jeton, BAO_CA_FICHIER: join(tmp, autorite), SAUVEGARDE_ESSAI: "0", BAO_DELAI: "20" } },
            (_e, out, err) => ok({ code: enfant.exitCode, out, err }),
          );
        });
      try {
        const bon = await lire("bon-ac.pem");
        expect(bon.err).toBe("");
        expect(bon.out.trim()).toBe(phraseOk);
        const faux = await lire("autre-ac.pem");
        expect(faux.code).not.toBe(0);
        expect(faux.out).toBe("");
      } finally {
        serveur.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it("[C-593] preparer-configuration.sh hors essai épingle l'hôte SFTP (known_hosts) et refuse de démarrer sans empreinte ou avec le modèle non rempli", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sauv-prep-"));
    const copie = join(tmp, "s");
    try {
      spawnSync("mkdir", [copie]);
      for (const f of readdirSync(dossierScripts)) if (/^(preparer-configuration\.sh|pgbackrest\.conf\..*|known_hosts\.modele)$/.test(f)) copyFileSync(join(dossierScripts, f), join(copie, f));
      // Lecteur de phrase factice : ce test ne porte que sur la vérification de l'hôte.
      writeFileSync(join(copie, "lire-phrase-chiffrement.sh"), `#!/usr/bin/env bash\nprintf '%s\\n' ${"x".repeat(40)}\n`);
      chmodSync(join(copie, "lire-phrase-chiffrement.sh"), 0o755);
      const cible = `/dev/shm/essai-t1b04-${process.pid}.conf`;
      const lancer = (extra: Record<string, string> = {}) =>
        spawnSync(join(copie, "preparer-configuration.sh"), [], { encoding: "utf8", env: { PATH: process.env.PATH, PGBACKREST_CONFIG: cible, ...extra } });
      try {
        // Aucun known_hosts : refus net.
        const sans = lancer();
        expect(sans.status).not.toBe(0);
        expect(sans.stderr).toMatch(/known_hosts/);
        // Le modèle livré n'est pas une empreinte : refus.
        copyFileSync(join(copie, "known_hosts.modele"), join(copie, "known_hosts"));
        const modele = lancer();
        expect(modele.status).not.toBe(0);
        expect(modele.stderr).toMatch(/known_hosts/);
        // Une empreinte (fictive ici) : la configuration exige l'empreinte, jamais « none » ni « accept-new ».
        writeFileSync(join(copie, "known_hosts"), "stockage.exemple.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n");
        const bon = lancer();
        expect(bon.stderr).toBe("");
        expect(bon.status).toBe(0);
        const conf = readFileSync(cible, "utf8");
        expect(conf).toMatch(/^repo1-sftp-host-key-check-type=strict$/m);
        expect(conf).toMatch(/^repo1-sftp-known-host=.*known_hosts$/m);
        expect(conf).not.toMatch(/check-type=(none|accept-new)/);
      } finally {
        rmSync(cible, { force: true });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("[C-593] le modèle known_hosts ne contient aucune empreinte réelle (elle est posée au branchement) et le README nomme la limite du superutilisateur de maintenance", () => {
    const kh = lire("./known_hosts.modele");
    expect(lignesActives(kh).filter((l) => l.trim() !== "")).toEqual([]);
    expect(kh).toMatch(/REMPLACER/);
    const readme = lire("./README.md");
    expect(readme).toMatch(/superutilisateur de maintenance/);
    expect(readme).toMatch(/pg_read_server_files/);
    expect(readme).toMatch(/HTTPS/);
    expect(readme).toMatch(/sauvegardes-lecture/);
  });

  it("[C-593] aucune base ne crée de rôle applicatif ou équipe superutilisateur ni membre de pg_read_server_files", () => {
    const dossierInit = fileURLToPath(new URL("../socle/postgres/init/", import.meta.url));
    const tout = readdirSync(dossierInit).filter((f) => f.endsWith(".sql")).map((f) => lignesActives(readFileSync(join(dossierInit, f), "utf8")).join("\n")).join("\n");
    expect(tout).not.toMatch(/\bSUPERUSER\b/i);
    expect(tout).not.toMatch(/pg_read_server_files|pg_write_server_files|pg_execute_server_program/i);
    expect(tout).toMatch(/CREATE ROLE/i);
  });

  it("[C-523] la politique sauvegardes-lecture ne permet que « read » sur technique/data/sauvegardes", () => {
    const hcl = lignesActives(lire("../socle/openbao/politiques/sauvegardes-lecture.hcl")).join("\n");
    const chemins = [...hcl.matchAll(/path\s+"([^"]+)"\s*\{([^}]*)\}/g)];
    expect(chemins).toHaveLength(1);
    expect(chemins[0]?.[1]).toBe("technique/data/sauvegardes");
    expect(chemins[0]?.[2]?.replace(/\s+/g, "")).toBe('capabilities=["read"]');
    expect(hcl).not.toMatch(/\*|sudo|list|update|create|delete/);
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

  it("[C-602] le modèle règle le plafond de la file d'archivage et l'archivage asynchrone (sans lui, le plafond n'agit pas)", () => {
    const actives = lignesActives(modele);
    expect(actives).toContain("archive-async=y");
    expect(actives.some((l) => /^archive-push-queue-max=\d+(KiB|MiB|GiB|TiB)$/.test(l))).toBe(true);
    // La phrase reste hors du modèle : l'archivage asynchrone ne change pas la lecture unique au démarrage (C-593).
    expect(modele).not.toMatch(/cipher-pass/);
  });
});
