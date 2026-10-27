import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { creerPortS3Aws } from "../../apps/api/src/stockage/stockage.ts";

// Tests contre le socle lancé par ops/socle/lancer.sh (job socle-integration), avec ops/socle/compose.sauvegardes.yml.
// Tout se passe sur des conteneurs jetables : la cible SFTP d'essai imite la Storage Box (l'« ajout seul » ne s'y prouve pas, lot 1-B).
const PROJET = "socle";
const MARQUEUR = `MARQUEUR-${Date.now()}-${Math.random().toString(16).slice(2)}`;

interface Options {
  input?: string;
  env?: NodeJS.ProcessEnv;
}
// Une commande en échec lève une erreur qui porte sa sortie : sans elle, le journal de la CI ne dit pas pourquoi.
const sortie = (cmd: string, args: string[], options: Options = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
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
const script = (nom: string) => join(process.cwd(), "ops/sauvegardes", nom);
const infoPgBackRest = () => dans("postgres", "pgbackrest", "--stanza=commun", "info", "--output=json");
const completes = () => {
  const info = JSON.parse(infoPgBackRest()) as { backup?: { label: string; type: string }[] }[];
  return info.flatMap((g) => g.backup ?? []).filter((b) => b.type === "full").map((b) => b.label).sort();
};
const JETON_DANS_POSTGRES = "/dev/shm/jeton-bao";

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
  spawnSync("docker", ["exec", conteneur("postgres"), "rm", "-f", JETON_DANS_POSTGRES, `${JETON_DANS_POSTGRES}-faux`]);
});

// OpenBao du socle : démarre scellé et non initialisé. L'essai l'initialise (une part), monte technique/ (KV v2), y range la phrase d'essai
// (la MÊME que celle du dépôt chiffré, pour que la sauvegarde suivante reste lisible) et crée un jeton limité à la lecture de ce chemin.
// Le jeton racine et la part ne quittent jamais ce processus ; le jeton de lecture va dans un fichier 0600 du conteneur postgres (entrée standard, pas d'argument).
let baoPret: Promise<{ phrase: string }> | undefined;
const preparerOpenBao = () => {
  baoPret ??= (async () => {
    const bao = conteneur("openbao");
    const exec = (jeton: string | undefined, entree: string, ...args: string[]) =>
      sortie("docker", ["exec", "-i", "-e", "BAO_ADDR=http://127.0.0.1:8200", ...(jeton ? ["-e", "BAO_TOKEN"] : []), bao, "bao", ...args], {
        input: entree,
        env: jeton ? { ...process.env, BAO_TOKEN: jeton } : process.env,
      });
    const init = JSON.parse(exec(undefined, "", "operator", "init", "-key-shares=1", "-key-threshold=1", "-format=json")) as { unseal_keys_b64: string[]; root_token: string };
    const racine = init.root_token;
    expect(init.unseal_keys_b64[0], "part de déverrouillage").toBeTruthy();
    // La part passe en argument : OpenBao d'essai jetable, sur le seul runner de la CI, rien n'est versionné ni écrit.
    exec(undefined, "", "operator", "unseal", init.unseal_keys_b64[0] ?? "");
    // Les écritures sont refusées un instant après le déverrouillage et la mise en place d'un montage KV v2 : on réessaie.
    const reessayer = (f: () => void, message: string) =>
      attendre(() => {
        try {
          f();
          return true;
        } catch (e) {
          return /already in use/.test(String(e));
        }
      }, 60).then((ok) => expect(ok, message).toBe(true));
    await reessayer(() => exec(racine, "", "secrets", "enable", "-path=technique", "-version=2", "kv"), "montage technique/");
    const phrase = dans("postgres", "cat", "/cles/phrase").trim();
    await reessayer(() => exec(racine, JSON.stringify({ phrase }), "kv", "put", "-mount=technique", "sauvegardes", "-"), "écriture de technique/sauvegardes");
    exec(racine, 'path "technique/data/sauvegardes" { capabilities = ["read"] }', "policy", "write", "sauvegardes", "-");
    const jeton = exec(racine, "", "token", "create", "-policy=sauvegardes", "-no-default-policy", "-orphan", "-field=token").trim();
    expect(jeton.length).toBeGreaterThan(10);
    sortie("docker", ["exec", "-i", conteneur("postgres"), "sh", "-c", `umask 077 && cat > ${JETON_DANS_POSTGRES} && printf '%s' s.faux > ${JETON_DANS_POSTGRES}-faux`], { input: jeton });
    return { phrase };
  })();
  return baoPret;
};
const ENV_BAO = ["-e", "SAUVEGARDE_ESSAI=0", "-e", "BAO_ADDR=http://openbao:8200", "-e", `BAO_JETON_FICHIER=${JETON_DANS_POSTGRES}`];

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
    // Mode essai explicite : sans lui, restaurer.sh exige OpenBao (BAO_ADDR et le fichier du jeton).
    restaure = sortie(script("restaurer.sh"), [], { env: { ...process.env, SAUVEGARDE_ESSAI: "1" } }).trim().split("\n").pop() ?? "";
    expect(restaure).not.toBe("");
    expect(restaure).not.toBe(conteneur("postgres"));
    const apres = sortie("docker", ["exec", restaure, "psql", "-U", "postgres", "-d", "console", "-tAXc", SOMME]).trim();
    expect(apres).toBe(sommeSource);
  }, 600_000);

  it("[C-045] restaurer.sh sans mode essai exige OpenBao et ne laisse aucun conteneur de restauration", () => {
    const avant = sortie("docker", ["ps", "-aq", "--filter", "name=restauration-"]).trim().split("\n").filter(Boolean);
    const env = { ...process.env };
    delete env.SAUVEGARDE_ESSAI;
    delete env.BAO_ADDR;
    delete env.BAO_JETON_FICHIER;
    const r = spawnSync(script("restaurer.sh"), [], { encoding: "utf8", env });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/adresse d'OpenBao absente/);
    const apres = sortie("docker", ["ps", "-aq", "--filter", "name=restauration-"]).trim().split("\n").filter(Boolean);
    expect(apres.filter((c) => !avant.includes(c))).toEqual([]);
  });

  it("[C-046] sur la cible, aucun fichier ne contient en clair le marqueur écrit dans une table d'essai", () => {
    expect(fichiersCible().length).toBeGreaterThan(0);
    const trouve = spawnSync("docker", ["exec", conteneur("sftp-essai"), "grep", "-rl", MARQUEUR, "/home/sauv/depot"], { encoding: "utf8" });
    expect(trouve.status).toBe(1); // 1 = aucune correspondance
    expect(trouve.stdout).toBe("");
  }, 120_000);

  it("[C-046] pgbackrest info indique aes-256-cbc, la cible ne détient ni clé privée ni phrase, et une restauration avec une mauvaise phrase échoue", () => {
    const info = infoPgBackRest();
    expect(info).toMatch(/"cipher"\s*:\s*"aes-256-cbc"/);
    expect(info).not.toMatch(/"cipher"\s*:\s*"none"/);
    // Chiffré avant départ : la cible d'essai ne reçoit que la clé publique.
    const monte = dans("sftp-essai", "ls", "-A", "/home/sauv/.ssh/keys").split("\n").filter(Boolean);
    expect(monte).toHaveLength(1);
    expect(monte[0]).toMatch(/^id\.p/);
    const faux = spawnSync(
      "docker",
      [
        "exec", "-e", "PGBACKREST_REPO1_CIPHER_PASS=phrase-fausse-phrase-fausse-phrase-fausse", conteneur("postgres"),
        "sh", "-c", "rm -rf /tmp/restauration-fausse && mkdir -m 700 /tmp/restauration-fausse && pgbackrest --stanza=commun --pg1-path=/tmp/restauration-fausse restore",
      ],
      { encoding: "utf8" },
    );
    const messageFaux = `${faux.stdout}${faux.stderr}`;
    expect(faux.status, messageFaux).not.toBe(0);
    expect(messageFaux).toMatch(/ERROR/);
    expect(dans("postgres", "ls", "-A", "/tmp/restauration-fausse").trim()).toBe("");
    // Contre-épreuve : avec la bonne phrase (celle de la configuration), la même restauration réussit et restitue des fichiers.
    dans("postgres", "sh", "-c", "rm -rf /tmp/restauration-bonne && mkdir -m 700 /tmp/restauration-bonne && pgbackrest --stanza=commun --pg1-path=/tmp/restauration-bonne --type=immediate restore");
    expect(dans("postgres", "ls", "-A", "/tmp/restauration-bonne").trim()).toContain("PG_VERSION");
    dans("postgres", "rm", "-rf", "/tmp/restauration-fausse", "/tmp/restauration-bonne");
  }, 180_000);

  it("[C-593] la phrase de chiffrement ne figure dans aucun fichier du dépôt ni dans le compose assemblé", () => {
    const phrase = dans("postgres", "/opt/sauvegardes/lire-phrase-chiffrement.sh").trim();
    expect(phrase.length).toBeGreaterThanOrEqual(32);
    const fichiers = sortie("git", ["ls-files"]).split("\n").filter(Boolean);
    const contenant = fichiers.filter((f) => existsSync(f) && readFileSync(f, "latin1").includes(phrase));
    expect(contenant).toEqual([]);
    const assemble = sortie("ops/socle/lancer.sh", ["--assembler"]);
    expect(assemble.includes(phrase)).toBe(false);
    // Ni dans la définition du conteneur PostgreSQL (variables, commande) : elle n'est que dans un fichier en mémoire, droits 0400.
    expect(sortie("docker", ["inspect", conteneur("postgres")]).includes(phrase)).toBe(false);
    expect(dans("postgres", "stat", "-c", "%a", "/dev/shm/pgbackrest.conf").trim()).toBe("400");
  });

  it("[C-593] la phrase est lue dans l'OpenBao du socle (chemin technique/sauvegardes) et la sauvegarde de nuit tourne avec ce seul chemin", async () => {
    const { phrase } = await preparerOpenBao();
    const lue = sortie("docker", ["exec", ...ENV_BAO, conteneur("postgres"), "/opt/sauvegardes/lire-phrase-chiffrement.sh"]).trim();
    expect(lue).toBe(phrase);
    // Un jeton refusé par OpenBao ne donne aucune phrase.
    const refus = spawnSync("docker", ["exec", "-e", "SAUVEGARDE_ESSAI=0", "-e", "BAO_ADDR=http://openbao:8200", "-e", `BAO_JETON_FICHIER=${JETON_DANS_POSTGRES}-faux`, conteneur("postgres"), "/opt/sauvegardes/lire-phrase-chiffrement.sh"], { encoding: "utf8" });
    expect(refus.status).not.toBe(0);
    expect(refus.stdout).toBe("");
    // Une adresse HTTPS n'est pas prise en charge : refus net, jamais de repli sur le fichier d'essai.
    const https = spawnSync("docker", ["exec", "-e", "SAUVEGARDE_ESSAI=0", "-e", "BAO_ADDR=https://openbao:8200", "-e", `BAO_JETON_FICHIER=${JETON_DANS_POSTGRES}`, conteneur("postgres"), "/opt/sauvegardes/lire-phrase-chiffrement.sh"], { encoding: "utf8" });
    expect(https.status).not.toBe(0);
    expect(https.stdout).toBe("");
    // Chaîne complète : la sauvegarde de nuit, en mode HORS essai, lit la phrase dans OpenBao puis sauvegarde (une complète de plus).
    const avant = completes().length;
    sortie("docker", ["exec", ...ENV_BAO, conteneur("postgres"), "/opt/sauvegardes/sauvegarder-nuit.sh"]);
    expect(completes().length).toBe(avant + 1);
  }, 300_000);

  it("[A-196] sans phrase lisible, la sauvegarde de nuit s'arrête avant toute commande pgBackRest : aucune sauvegarde en clair ou sans clé", () => {
    const avant = completes();
    const r = spawnSync("docker", ["exec", "-e", "SAUVEGARDE_ESSAI=0", "-e", "BAO_ADDR=", conteneur("postgres"), "/opt/sauvegardes/sauvegarder-nuit.sh"], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/adresse d'OpenBao absente/);
    expect(completes()).toEqual(avant);
    // Le dépôt existant est bien chiffré (même preuve que [C-046], côté sauvegardes de nuit).
    expect(infoPgBackRest()).toMatch(/"cipher"\s*:\s*"aes-256-cbc"/);
  });

  it("[C-049] expirer.sh branche retention.ts sur la liste réelle de pgBackRest : une quotidienne par jour, rien d'expiré pour des sauvegardes futures, expiration réelle des complètes en trop", () => {
    // Il faut au moins deux complètes pour que « tout sauf la plus récente » ait un sens : on en ajoute une au besoin.
    if (completes().length < 2) dans("postgres", "/opt/sauvegardes/sauvegarder-nuit.sh");
    const labels = completes();
    expect(labels.length).toBeGreaterThanOrEqual(2);
    const hier = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const simuler = (jour: string) => sortie(script("expirer.sh"), ["--simuler"], { env: { ...process.env, EXPIRER_AUJOURDHUI: jour } }).split("\n").filter(Boolean);
    // Le jour même, une seule quotidienne est gardée : les autres complètes du jour partent (retention.ts).
    expect(simuler(new Date().toISOString().slice(0, 10))).toEqual(labels.slice(0, -1));
    // « Hier » : toutes les sauvegardes d'essai sont datées après aujourd'hui, donc intouchables.
    expect(simuler(hier)).toEqual([]);
    // Dans cinq ans : tout part, sauf la plus récente, toujours gardée.
    expect(simuler("2030-01-01")).toEqual(labels.slice(0, -1));
    // Exécution réelle avec la date d'hier : rien à expirer, sortie 0, aucune sauvegarde perdue.
    sortie(script("expirer.sh"), [], { env: { ...process.env, EXPIRER_AUJOURDHUI: hier } });
    expect(completes()).toEqual(labels);
    // Exécution réelle le jour même : pgbackrest expire --set retire pour de bon les complètes en trop, la plus récente reste.
    sortie(script("expirer.sh"), [], { env: { ...process.env, EXPIRER_AUJOURDHUI: new Date().toISOString().slice(0, 10) } });
    expect(completes()).toEqual(labels.slice(-1));
  }, 120_000);

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

  it("[A-192] un artefact déposé est copié sur la cible ; sa suppression du stockage n'efface pas la copie ; la relance avec le fichier déjà présent réussit", () => {
    const racine = mkdtempSync(join(tmpdir(), "artefacts-"));
    try {
      const source = join(racine, "source");
      const cible = join(racine, "cible");
      mkdirSync(source);
      mkdirSync(cible);
      writeFileSync(join(source, "module-essai.tgz"), "contenu d'essai");
      sortie(script("copier-artefacts.sh"), [source, cible]);
      expect(readFileSync(join(cible, "module-essai.tgz"), "utf8")).toBe("contenu d'essai");
      // Relance avec le fichier déjà présent des deux côtés (la deuxième nuit) : code 0, et la copie n'est pas remplacée.
      writeFileSync(join(source, "module-essai.tgz"), "contenu modifié à la source");
      sortie(script("copier-artefacts.sh"), [source, cible]);
      expect(readFileSync(join(cible, "module-essai.tgz"), "utf8")).toBe("contenu d'essai");
      rmSync(join(source, "module-essai.tgz"));
      sortie(script("copier-artefacts.sh"), [source, cible]);
      expect(readFileSync(join(cible, "module-essai.tgz"), "utf8")).toBe("contenu d'essai");
    } finally {
      rmSync(racine, { recursive: true, force: true });
    }
  });

  it("[A-192] le VRAI compartiment artefacts du socle est copié sans remplacement ni suppression, et la relance avec le fichier déjà présent réussit", async () => {
    const stockage = conteneur("stockage");
    expect(stockage).not.toBe("");
    const env = JSON.parse(sortie("docker", ["inspect", "-f", "{{json .Config.Env}}", stockage])) as string[];
    const valeur = (nom: string) => env.find((e) => e.startsWith(`${nom}=`))?.slice(nom.length + 1) ?? "";
    const admin = { cleAcces: valeur("AWS_ACCESS_KEY_ID"), secret: valeur("AWS_SECRET_ACCESS_KEY"), compartiment: "artefacts" };
    expect(admin.cleAcces).not.toBe("");
    const ip = sortie("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", stockage]).split(" ")[0] ?? "";
    const s3 = creerPortS3Aws({ endpoint: `http://${ip}:8333`, admin: { cleAcces: admin.cleAcces, secret: admin.secret } });
    let pret = false;
    for (let i = 0; i < 90 && !pret; i++) {
      try {
        await s3.creerCompartiment("artefacts");
        pret = true;
      } catch {
        await new Promise((ok) => setTimeout(ok, 1000));
      }
    }
    expect(pret, "compartiment artefacts du socle").toBe(true);
    const octets = (t: string) => new TextEncoder().encode(t);
    const nom = `module-essai-${Date.now()}.tgz`;
    const racine = mkdtempSync(join(tmpdir(), "artefacts-bucket-"));
    try {
      await s3.deposer(admin, "artefacts", nom, octets("version un"));
      const copie = spawnSync(script("copier-artefacts.sh"), ["--compartiment", stockage, racine], { encoding: "utf8" });
      if (copie.status !== 0 || !existsSync(join(racine, nom))) {
        // Diagnostic : ce que le filer répond pour le compartiment, tel que le script le lit.
        const listing = spawnSync("docker", ["exec", stockage, "wget", "-q", "-O", "-", "--header", "Accept: application/json", "http://localhost:8888/buckets/artefacts/?limit=1000"], { encoding: "utf8" });
        throw new Error(`copie du compartiment : code ${String(copie.status)}\n${copie.stderr}\n--- listing du filer (code ${String(listing.status)})\n${listing.stdout}\n${listing.stderr}`);
      }
      expect(readFileSync(join(racine, nom), "utf8")).toBe("version un");
      // Deuxième nuit : le fichier est toujours dans le compartiment (avec un autre contenu) et déjà sur la cible : code 0, copie intacte.
      await s3.deposer(admin, "artefacts", nom, octets("version deux"));
      sortie(script("copier-artefacts.sh"), ["--compartiment", stockage, racine]);
      expect(readFileSync(join(racine, nom), "utf8")).toBe("version un");
      // Un nouvel objet est ajouté, l'ancien reste.
      await s3.deposer(admin, "artefacts", `suite-${nom}`, octets("autre"));
      sortie(script("copier-artefacts.sh"), ["--compartiment", stockage, racine]);
      expect(readFileSync(join(racine, `suite-${nom}`), "utf8")).toBe("autre");
      expect(readFileSync(join(racine, nom), "utf8")).toBe("version un");
    } finally {
      rmSync(racine, { recursive: true, force: true });
    }
  }, 180_000);
});
