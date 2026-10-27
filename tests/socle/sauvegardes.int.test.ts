import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Tests contre le socle lancé par ops/socle/lancer.sh (job socle-integration), avec ops/socle/compose.sauvegardes.yml.
// Tout se passe sur des conteneurs jetables : la cible SFTP d'essai imite la Storage Box (l'« ajout seul » ne s'y prouve pas, lot 1-B).
const PROJET = "socle";
const MARQUEUR = `MARQUEUR-${Date.now()}-${Math.random().toString(16).slice(2)}`;

// Une commande en échec lève une erreur qui porte sa sortie : sans elle, le journal de la CI ne dit pas pourquoi.
const sortie = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} : code ${String(r.status)}\n--- sortie\n${r.stdout}\n--- erreur\n${r.stderr}`);
  return r.stdout;
};
const conteneur = (service: string) =>
  sortie("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${PROJET}`, "--filter", `label=com.docker.compose.service=${service}`]).trim();
const dans = (service: string, ...cmd: string[]) => sortie("docker", ["exec", "-i", conteneur(service), ...cmd]);
const sql = (base: string, requete: string, service = "postgres") => dans(service, "psql", "-U", "postgres", "-d", base, "-tAXc", requete).trim();
const attendre = async (condition: () => boolean, secondes: number) => {
  for (let i = 0; i < secondes; i++) {
    if (condition()) return true;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return condition();
};
const fichiersCible = () => dans("sftp-essai", "find", "/home/sauv/depot", "-type", "f").split("\n").filter(Boolean);
const SOMME = "select md5(coalesce(string_agg(t::text, ',' order by id), '')) from essai_sauvegarde t";

let restaure = "";
let sommeSource = "";

beforeAll(() => {
  sql("console", `create table if not exists essai_sauvegarde (id int primary key, note text)`);
  sql("console", `insert into essai_sauvegarde select g, '${MARQUEUR}-' || g from generate_series(1, 200) g on conflict do nothing`);
  sommeSource = sql("console", SOMME);
  // « pgbackrest check » avant la première sauvegarde (sinon l'archivage échoue sans bruit), puis la complète de nuit.
  try {
    dans("postgres", "/opt/sauvegardes/sauvegarder-nuit.sh");
  } catch (e) {
    const journal = spawnSync("docker", ["exec", conteneur("postgres"), "sh", "-c", "tail -n 60 /var/log/pgbackrest/*.log 2>&1"], { encoding: "utf8" }).stdout;
    const detail = `${String(e)}\n--- journal pgBackRest\n${journal}`;
    writeSync(2, `ECHEC beforeAll\n${detail}\n`);
    throw new Error(detail);
  }
}, 240_000);

// Le job lance Vitest avec le seul rapport JSON : un échec n'y est pas lisible. On l'écrit donc sur la sortie d'erreur du processus (descripteur 2).
afterEach((ctx) => {
  const erreurs = ctx.task.result?.errors ?? [];
  if (ctx.task.result?.state === "fail") writeSync(2, `ECHEC ${ctx.task.name}\n${erreurs.map((e) => e.message).join("\n")}\n`);
});

afterAll(() => {
  if (restaure) spawnSync("docker", ["rm", "-f", "-v", restaure]);
});

describe("sauvegardes (archivage continu, complète de nuit, restauration)", () => {
  it("[C-045] l'archivage continu est actif et un segment de journal arrive sur la cible", async () => {
    expect(sql("console", "show archive_mode")).toBe("on");
    const avant = fichiersCible().filter((f) => f.includes("/archive/")).length;
    // pg_switch_wal() ne fait rien si aucun journal n'a été écrit depuis le dernier changement de segment : on écrit d'abord.
    sql("console", "update essai_sauvegarde set note = note where id = 1");
    sql("console", "select pg_switch_wal()");
    const arrive = await attendre(() => fichiersCible().filter((f) => f.includes("/archive/")).length > avant, 60);
    expect(arrive).toBe(true);
  }, 90_000);

  it("[C-044] archive_timeout vaut 300 s au plus", () => {
    const secondes = Number(sql("console", "select setting from pg_settings where name = 'archive_timeout'"));
    expect(secondes).toBeGreaterThan(0);
    expect(secondes).toBeLessThanOrEqual(300);
  });

  it("[C-045] sauvegarde complète puis restauration dans un conteneur neuf : les sommes de contrôle des tables d'essai sont identiques", () => {
    restaure = sortie(join(process.cwd(), "ops/sauvegardes/restaurer.sh"), []).trim().split("\n").pop() ?? "";
    expect(restaure).not.toBe("");
    expect(restaure).not.toBe(conteneur("postgres"));
    const apres = sortie("docker", ["exec", restaure, "psql", "-U", "postgres", "-d", "console", "-tAXc", SOMME]).trim();
    expect(apres).toBe(sommeSource);
  }, 600_000);

  it("[C-046] sur la cible, aucun fichier ne contient en clair le marqueur écrit dans une table d'essai", () => {
    expect(fichiersCible().length).toBeGreaterThan(0);
    const trouve = spawnSync("docker", ["exec", conteneur("sftp-essai"), "grep", "-rl", MARQUEUR, "/home/sauv/depot"], { encoding: "utf8" });
    expect(trouve.status).toBe(1); // 1 = aucune correspondance
    expect(trouve.stdout).toBe("");
  });

  it("[C-593] la phrase de chiffrement ne figure dans aucun fichier du dépôt ni dans le compose assemblé", () => {
    const phrase = dans("postgres", "/opt/sauvegardes/lire-phrase-chiffrement.sh").trim();
    expect(phrase.length).toBeGreaterThanOrEqual(16);
    const fichiers = sortie("git", ["ls-files"]).split("\n").filter(Boolean);
    const contenant = fichiers.filter((f) => existsSync(f) && readFileSync(f, "latin1").includes(phrase));
    expect(contenant).toEqual([]);
    const assemble = sortie("ops/socle/lancer.sh", ["--assembler"]);
    expect(assemble.includes(phrase)).toBe(false);
  });

  it("[C-052] la grappe sauvegardée ne contient aucune base cli_", () => {
    expect(sql("postgres", "select count(*) from pg_database where datname like 'cli\\_%'")).toBe("0");
  });

  it("[A-190] la sauvegarde contient console, moteur, keycloak et passerelle_ia", () => {
    expect(restaure).not.toBe("");
    const bases = dans("postgres", "psql", "-U", "postgres", "-d", "postgres", "-tAXc", "select datname from pg_database order by 1").split("\n");
    for (const b of ["console", "moteur", "keycloak", "passerelle_ia"]) expect(bases).toContain(b);
    const basesRestaurees = sortie("docker", ["exec", restaure, "psql", "-U", "postgres", "-d", "postgres", "-tAXc", "select datname from pg_database"]).split("\n");
    for (const b of ["console", "moteur", "keycloak", "passerelle_ia"]) expect(basesRestaurees).toContain(b);
  });

  it("[A-192] un artefact déposé est copié sur la cible ; sa suppression du stockage n'efface pas la copie", () => {
    const racine = mkdtempSync(join(tmpdir(), "artefacts-"));
    try {
      const source = join(racine, "source");
      const cible = join(racine, "cible");
      mkdirSync(source);
      mkdirSync(cible);
      writeFileSync(join(source, "module-essai.tgz"), "contenu d'essai");
      sortie(join(process.cwd(), "ops/sauvegardes/copier-artefacts.sh"), [source, cible]);
      expect(readFileSync(join(cible, "module-essai.tgz"), "utf8")).toBe("contenu d'essai");
      rmSync(join(source, "module-essai.tgz"));
      sortie(join(process.cwd(), "ops/sauvegardes/copier-artefacts.sh"), [source, cible]);
      expect(readFileSync(join(cible, "module-essai.tgz"), "utf8")).toBe("contenu d'essai");
    } finally {
      rmSync(racine, { recursive: true, force: true });
    }
  });
});
