import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// T1B-05 : sauvegarde de nuit, effacement, contrôle de fraîcheur, journal. Aucun conteneur : pgbackrest, psql, docker et la commande d'alerte
// sont des bouchons posés devant le PATH ; les scripts réels tournent sur une copie du dossier. Les essais en conteneurs sont dans
// tests/socle/sauvegardes.int.test.ts (job socle-integration).
const dossierScripts = fileURLToPath(new URL(".", import.meta.url));
const racine = fileURLToPath(new URL("../../", import.meta.url));
const lire = (chemin: string) => readFileSync(join(dossierScripts, chemin), "utf8");
const lignesActives = (texte: string) => texte.split("\n").filter((l) => !/^\s*(#|--)/.test(l));

const temporaires: string[] = [];
afterAll(() => {
  for (const d of temporaires) rmSync(d, { recursive: true, force: true });
});

const SCRIPTS = ["sauvegarder-nuit.sh", "expirer.sh", "controle-fraicheur.sh", "journaliser.sh", "restaurer.sh", "retention.ts"];

interface Banc {
  dir: string;
  scripts: string;
  journal: string;
  args: string;
  alertes: string;
  info: string;
  env: NodeJS.ProcessEnv;
}

// Dossier de travail : copie des scripts réels, plus des bouchons. Le bouchon « lire-phrase-chiffrement.sh » remplace celui du dépôt (il lirait /cles).
const banc = (): Banc => {
  const dir = mkdtempSync(join(tmpdir(), "nuit-"));
  temporaires.push(dir);
  const scripts = join(dir, "scripts");
  const bin = join(dir, "bin");
  mkdirSync(scripts);
  mkdirSync(bin);
  for (const f of SCRIPTS) if (existsSync(join(dossierScripts, f))) copyFileSync(join(dossierScripts, f), join(scripts, f));
  const ecrire = (chemin: string, texte: string) => {
    writeFileSync(chemin, texte);
    chmodSync(chemin, 0o755);
  };
  ecrire(join(scripts, "lire-phrase-chiffrement.sh"), "#!/usr/bin/env bash\nprintf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
  for (const f of SCRIPTS) if (existsSync(join(scripts, f))) chmodSync(join(scripts, f), 0o755);
  const args = join(dir, "appels.txt");
  const info = join(dir, "info.json");
  const alertes = join(dir, "alertes.txt");
  writeFileSync(args, "");
  writeFileSync(alertes, "");
  writeFileSync(info, "[]");
  ecrire(
    join(bin, "pgbackrest"),
    `#!/usr/bin/env bash
echo "pgbackrest $*" >>"$STUB_APPELS"
case " $* " in
  *" info "*) cat "$STUB_INFO" ;;
  *" backup "*) [ "\${STUB_BACKUP_CODE:-0}" = "0" ] || { echo "ERROR: backup en échec simulé" >&2; exit "$STUB_BACKUP_CODE"; } ;;
  *" expire "*) [ "\${STUB_EXPIRE_CODE:-0}" = "0" ] || exit "$STUB_EXPIRE_CODE" ;;
esac
exit 0
`,
  );
  // psql : le bouchon rend la ligne « label, taille, type » de la dernière sauvegarde saine (la vraie requête tourne dans le conteneur).
  ecrire(join(bin, "psql"), `#!/usr/bin/env bash\ncat >/dev/null\nprintf '%s\\t%s\\t%s\\n' "\${STUB_LABEL:-20261102-030000F}" "\${STUB_TAILLE:-123456}" "\${STUB_TYPE:-full}"\n`);
  // docker : « ps -q » rend un identifiant ; « exec <id> sh -c … sh pgbackrest … » est rejoué sur le bouchon pgbackrest.
  ecrire(
    join(bin, "docker"),
    `#!/usr/bin/env bash
if [ "$1" = "ps" ]; then echo cid-essai; exit 0; fi
if [ "$1" = "exec" ]; then
  while [ "$1" != "pgbackrest" ] && [ $# -gt 0 ]; do shift; done
  shift
  exec pgbackrest "$@"
fi
exit 1
`,
  );
  ecrire(join(dir, "alerte.sh"), `#!/usr/bin/env bash\nprintf '%s|%s|%s\\n' "$1" "$2" "$3" >>"$STUB_ALERTES"\n`);
  const journal = join(dir, "journal");
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: dir,
    STUB_APPELS: args,
    STUB_INFO: info,
    STUB_ALERTES: alertes,
    SAUVEGARDE_JOURNAL: journal,
    ALERTE_COMMANDE: join(dir, "alerte.sh"),
  };
  return { dir, scripts, journal, args, alertes, info, env };
};

const lancer = (b: Banc, script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(join(b.scripts, script), args, { encoding: "utf8", env: { ...b.env, ...env }, cwd: b.dir });

const appels = (b: Banc) => readFileSync(b.args, "utf8").split("\n").filter(Boolean);
const alertesEnvoyees = (b: Banc) => readFileSync(b.alertes, "utf8").split("\n").filter(Boolean);
const fichiersJournal = (b: Banc, quoi: string): string[] => {
  const base = join(b.journal, "console", quoi);
  if (!existsSync(base)) return [];
  return readdirSync(base, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".journal")).map((f) => join(base, f)).sort();
};

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const NOW = "2026-11-02T12:00:00Z";
const infoAvecArret = (iso: string, extras: Record<string, unknown> = {}) =>
  JSON.stringify([
    { name: "commun", backup: [{ label: "20261101-030000F", type: "full", error: false, reference: null, timestamp: { start: unix(iso) - 60, stop: unix(iso) }, ...extras }] },
  ]);
const controle = (b: Banc, env: NodeJS.ProcessEnv = {}) =>
  lancer(b, "controle-fraicheur.sh", [], {
    CONTROLE_INFO_FICHIER: b.info,
    CONTROLE_MAINTENANT: String(unix(NOW)),
    STOCKAGE_UTILISE_OCTETS: "10",
    STOCKAGE_TOTAL_OCTETS: "1000",
    ...env,
  });

describe("sauvegarde de nuit : expiration automatique coupée, rythme, journal (T1B-05)", () => {
  it("[C-049] la sauvegarde de nuit coupe l'expiration automatique de pgBackRest et n'appelle jamais expire", () => {
    const b = banc();
    const r = lancer(b, "sauvegarder-nuit.sh", [], { SAUVEGARDE_TYPE: "full" });
    expect(r.status, r.stderr).toBe(0);
    const sauvegarde = appels(b).filter((a) => / backup(\s|$)/.test(a));
    expect(sauvegarde).toHaveLength(1);
    expect(sauvegarde[0]).toMatch(/--no-expire-auto/);
    expect(appels(b).filter((a) => /(^|\s)expire(\s|$)/.test(a))).toEqual([]);
  });

  it("[C-049] le modèle de configuration règle expire-auto=n pour la commande backup, et la rétention reste à 9999 complètes", () => {
    const modele = lire("pgbackrest.conf.modele");
    const lignes = lignesActives(modele);
    const debut = lignes.indexOf("[global:backup]");
    expect(debut).toBeGreaterThan(-1);
    expect(lignes.slice(debut + 1).find((l) => l.startsWith("["))).not.toBe("[global]");
    expect(lignes[debut + 1]).toBe("expire-auto=n");
    expect(lignes).toContain("repo1-retention-full=9999");
  });

  it("[C-049] une seule tâche efface : aucun autre script n'appelle expire, aucune règle d'effacement du fournisseur n'est versionnée", () => {
    const scripts = readdirSync(dossierScripts).filter((f) => f.endsWith(".sh") && f !== "expirer.sh");
    expect(scripts).toContain("sauvegarder-nuit.sh");
    for (const f of scripts) {
      const texte = lignesActives(lire(f)).join("\n");
      expect(texte, `${f} appelle expire`).not.toMatch(/pgbackrest[^\n]*\s(expire|archive-expire)\b|"?\$@"?\s+expire\b/);
    }
    expect(lignesActives(lire("expirer.sh")).join("\n")).toMatch(/--stanza=commun "--set=\$id" expire/);
    // Aucune règle d'effacement automatique du stockage (cycle de vie, expiration) dans le versionné d'exploitation : elle effacerait sans alerte ni journal.
    const fichiers = spawnSync("git", ["ls-files", "--full-name", "ops"], { encoding: "utf8", cwd: racine }).stdout.split("\n").filter(Boolean);
    expect(fichiers.length).toBeGreaterThan(20);
    const fautifs = fichiers.filter((f) => /\.(json|ya?ml|tf|xml|modele)$/.test(f) && !f.endsWith(".test.ts") && /lifecycle|cycle[- ]de[- ]vie|ExpirationDays|DeleteAfter|expiration_days/i.test(readFileSync(join(racine, f), "utf8")));
    expect(fautifs).toEqual([]);
  });

  it("[C-049] chaque passage écrit une ligne de journal complète : date, type, taille, empreinte, résultat, durée, identifiant", () => {
    const b = banc();
    const ok = lancer(b, "sauvegarder-nuit.sh", [], { SAUVEGARDE_TYPE: "full" });
    expect(ok.status, ok.stderr).toBe(0);
    const [fichier, ...autres] = fichiersJournal(b, "sauvegarde");
    expect(autres).toEqual([]);
    expect(fichier).toBeDefined();
    const lignes = readFileSync(fichier ?? "", "utf8").split("\n").filter(Boolean);
    expect(lignes).toHaveLength(1);
    const champs = (lignes[0] ?? "").split("\t");
    expect(champs).toHaveLength(7);
    const [date, type, taille, empreinte, resultat, duree, identifiant] = champs;
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(type).toBe("full");
    expect(taille).toBe("123456");
    expect(empreinte).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resultat).toBe("ok");
    expect(duree).toMatch(/^\d+$/);
    expect(identifiant).toBe("20261102-030000F");
    // Le nom du fichier suit le format de rangement : système/quoi/fréquence/système-quoi-fréquence-AAAAMMJJ-HHMMSS.ext
    expect(fichier).toMatch(/console\/sauvegarde\/hebdomadaire\/console-sauvegarde-hebdomadaire-\d{8}-\d{6}\.journal$/);
  });

  it("[C-049] une sauvegarde en échec écrit aussi sa ligne, avec le résultat « echec », et la sortie reste en erreur", () => {
    const b = banc();
    const r = lancer(b, "sauvegarder-nuit.sh", [], { SAUVEGARDE_TYPE: "full", STUB_BACKUP_CODE: "7" });
    expect(r.status).not.toBe(0);
    const [fichier] = fichiersJournal(b, "sauvegarde");
    expect(fichier).toBeDefined();
    const champs = readFileSync(fichier ?? "", "utf8").trim().split("\t");
    expect(champs).toHaveLength(7);
    expect(champs[4]).toBe("echec");
    expect(champs[2]).toBe("0");
  });

  it("[C-049] le rythme : une complète par semaine (jour désigné ou aucune complète), des différences les autres nuits", () => {
    const type = (infoJson: string, jour: string) => {
      const b = banc();
      writeFileSync(b.info, infoJson);
      const r = lancer(b, "sauvegarder-nuit.sh", [], { SAUVEGARDE_JOUR_COMPLETE: jour });
      expect(r.status, r.stderr).toBe(0);
      return appels(b).find((a) => / backup(\s|$)/.test(a)) ?? "";
    };
    const jourDeLaSemaine = new Date().getUTCDay() === 0 ? "7" : String(new Date().getUTCDay());
    const autreJour = jourDeLaSemaine === "7" ? "3" : String(Number(jourDeLaSemaine) + 1);
    const avecComplete = infoAvecArret("2026-11-01T03:00:00Z");
    expect(type(avecComplete, jourDeLaSemaine)).toMatch(/--type=full/);
    expect(type(avecComplete, autreJour)).toMatch(/--type=diff/);
    // Aucune complète : la première sauvegarde est complète, quel que soit le jour.
    expect(type("[]", autreJour)).toMatch(/--type=full/);
    // Chaque passage garde l'expiration automatique coupée, complète ou différence.
    expect(type(avecComplete, autreJour)).toMatch(/--no-expire-auto/);
  });

  it("[C-049] un type de sauvegarde inconnu est refusé avant toute commande pgBackRest", () => {
    const b = banc();
    const r = lancer(b, "sauvegarder-nuit.sh", [], { SAUVEGARDE_TYPE: "incr" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/SAUVEGARDE_TYPE/);
    expect(appels(b)).toEqual([]);
  });

  it("[C-049] un nom de rangement hors format est refusé", () => {
    const valide = (chemin: string) => spawnSync("bash", ["-c", `source "${join(dossierScripts, "journaliser.sh")}"; rangement_nom_valide "$1"`, "x", chemin], { encoding: "utf8" }).status === 0;
    expect(valide("console/sauvegarde/quotidienne/console-sauvegarde-quotidienne-20261102-030000.journal")).toBe(true);
    expect(valide("console/effacement/quotidienne/console-effacement-quotidienne-20261102-031500.journal")).toBe(true);
    for (const mauvais of [
      "console-sauvegarde-quotidienne-20261102-030000.journal", // pas de dossier
      "console/sauvegarde/quotidienne/sauvegarde-quotidienne-20261102-030000.journal", // pas de préfixe système
      "console/sauvegarde/quotidienne/console-effacement-quotidienne-20261102-030000.journal", // usage différent du dossier
      "console/sauvegarde/quotidienne/console-sauvegarde-hebdomadaire-20261102-030000.journal", // fréquence différente du dossier
      "console/sauvegarde/quotidienne/console-sauvegarde-quotidienne-2026-11-02.journal", // horodatage hors format
      "console/sauvegarde/quotidienne/console-sauvegarde-quotidienne-20261102-0300.journal", // heure incomplète
      "console/sauvegarde/quotidienne/Console-sauvegarde-quotidienne-20261102-030000.journal", // majuscule
      "console/sauvegarde/quotidienne/console-sauvegarde-quotidienne-20261102-030000", // pas d'extension
      "console/sauvegarde/quotidienne/extra/console-sauvegarde-quotidienne-20261102-030000.journal", // un niveau de trop
      "../console/sauvegarde/quotidienne/console-sauvegarde-quotidienne-20261102-030000.journal", // sortie du dossier
      "/console/sauvegarde/quotidienne/console-sauvegarde-quotidienne-20261102-030000.journal", // chemin absolu
      "",
    ]) {
      expect(valide(mauvais), mauvais).toBe(false);
    }
    // L'écriture refuse aussi un usage ou une fréquence hors liste : aucun fichier n'est créé.
    const b = banc();
    const r = spawnSync("bash", ["-c", `source "${join(b.scripts, "journaliser.sh")}"; journal_ecrire "n-importe-quoi" quotidienne full 1 sha256:x ok 1 id`], { encoding: "utf8", env: b.env });
    expect(r.status).not.toBe(0);
    expect(existsSync(b.journal) ? readdirSync(b.journal, { recursive: true }) : []).toEqual([]);
  });

  it("[C-049] deux passages dans la même seconde écrivent chacun leur ligne, sans écraser ni échouer", () => {
    const b = banc();
    const appel = `source "${join(b.scripts, "journaliser.sh")}"; journal_ecrire restauration ponctuelle restauration 1 - echec 1 a && journal_ecrire restauration ponctuelle restauration 1 - ok 1 b`;
    const r = spawnSync("bash", ["-c", appel], { encoding: "utf8", env: b.env });
    expect(r.status, r.stderr).toBe(0);
    const fichiers = fichiersJournal(b, "restauration");
    expect(fichiers).toHaveLength(2);
    expect(fichiers.map((f) => readFileSync(f, "utf8").split("\t")[4]).sort()).toEqual(["echec", "ok"]);
  });

  it("[C-049] huit passages lancés dans la même seconde écrivent huit lignes, sans en perdre ni échouer", () => {
    const b = banc();
    const un = (n: number) => `(journal_ecrire restauration ponctuelle restauration 1 - ok ${n} id${n} || echo "perdu ${n}" >&2) & `;
    const appel = `source "${join(b.scripts, "journaliser.sh")}"; ${[1, 2, 3, 4, 5, 6, 7, 8].map(un).join("")} wait`;
    const r = spawnSync("bash", ["-c", appel], { encoding: "utf8", env: b.env });
    expect(r.stderr).not.toMatch(/perdu|cannot overwrite|écriture impossible/);
    expect(fichiersJournal(b, "restauration")).toHaveLength(8);
  });

  it("[C-045] si le journal ne s'écrit pas après une restauration réussie, le conteneur restauré est détruit et la sortie est le code 3", () => {
    const b = banc();
    const appelsDocker = join(b.dir, "docker.txt");
    writeFileSync(appelsDocker, "");
    const ecrire = (chemin: string, texte: string) => {
      writeFileSync(chemin, texte);
      chmodSync(chemin, 0o755);
    };
    ecrire(
      join(b.dir, "bin", "docker"),
      `#!/usr/bin/env bash
echo "$*" >>"${appelsDocker}"
case "$1" in
  ps) echo cid-essai ;;
  inspect) case "$*" in *State.Running*) echo true ;; *) echo reseau ;; esac ;;
  exec) case "$*" in *du*) printf '100\t/tmp/donnees\n' ;; esac ;;
esac
exit 0
`,
    );
    // Un fichier à la place du dossier du journal : mkdir échoue, l'écriture est impossible.
    const bloc = join(b.dir, "pas-un-dossier");
    writeFileSync(bloc, "");
    const r = lancer(b, "restaurer.sh", [], { SAUVEGARDE_ESSAI: "1", SAUVEGARDE_JOURNAL: bloc });
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).toMatch(/restauration-\d+/);
    expect(r.stderr).toMatch(/détruit/);
    expect(readFileSync(appelsDocker, "utf8")).toMatch(/rm -f -v restauration-\d+/);
  });

  it("[C-523] restaurer.sh monte l'autorité du réseau interne et le known_hosts dans le conteneur, et la configuration stricte garde le type de hachage", () => {
    const sh = lignesActives(lire("restaurer.sh")).join("\n");
    expect(sh).toMatch(/-v "\$BAO_CA_FICHIER:\$BAO_CA_FICHIER:ro"/);
    expect(sh).toMatch(/-v "\$SFTP_KNOWN_HOSTS:\$SFTP_KNOWN_HOSTS:ro"/);
    expect(sh).toMatch(/preparer-configuration\.sh/);
    const prep = lignesActives(lire("preparer-configuration.sh")).join("\n");
    expect(prep).not.toMatch(/hash/);
    expect(lire("pgbackrest.conf.modele")).toMatch(/^repo1-sftp-host-key-hash-type=sha256$/m);
  });

  it("[C-049] tout script du dossier qui range un fichier passe par journaliser.sh (un seul endroit par système et par usage)", () => {
    for (const f of ["sauvegarder-nuit.sh", "expirer.sh", "restaurer.sh"]) {
      expect(lignesActives(lire(f)).join("\n"), f).toMatch(/source "\$dossier\/journaliser\.sh"/);
      expect(lignesActives(lire(f)).join("\n"), f).toMatch(/journal_ecrire /);
    }
    // Le journal ne s'écrit nulle part ailleurs que par journaliser.sh (controle-fraicheur.sh ne fait que le lire).
    for (const f of readdirSync(dossierScripts).filter((x) => x.endsWith(".sh") && x !== "journaliser.sh" && x !== "controle-fraicheur.sh")) {
      expect(lignesActives(lire(f)).join("\n"), f).not.toMatch(/\.journal\b/);
    }
  });
});

const infoDeux = (jour: string) =>
  JSON.stringify([
    {
      name: "commun",
      backup: [
        { label: `${jour.replaceAll("-", "")}-010000F`, type: "full", error: false, reference: null, timestamp: { start: unix(`${jour}T01:00:00Z`), stop: unix(`${jour}T01:05:00Z`) } },
        { label: `${jour.replaceAll("-", "")}-020000F`, type: "full", error: false, reference: null, timestamp: { start: unix(`${jour}T02:00:00Z`), stop: unix(`${jour}T02:05:00Z`) } },
      ],
    },
  ]);

describe("expirer.sh : l'unique tâche d'effacement écrit sa ligne (T1B-05)", () => {
  it("[C-049] un effacement réel écrit une ligne « effacement » avec les ensembles expirés, et --simuler n'en écrit aucune", () => {
    const b = banc();
    writeFileSync(b.info, infoDeux("2026-11-02"));
    const env = { EXPIRER_AUJOURDHUI: "2026-11-02" };
    const sim = lancer(b, "expirer.sh", ["--simuler"], env);
    expect(sim.status, sim.stderr).toBe(0);
    expect(fichiersJournal(b, "effacement")).toEqual([]);
    const r = lancer(b, "expirer.sh", [], env);
    expect(r.status, r.stderr).toBe(0);
    expect(appels(b).filter((a) => /(^|\s)expire(\s|$)/.test(a))).toEqual(["pgbackrest --stanza=commun --set=20261102-010000F expire"]);
    const [fichier] = fichiersJournal(b, "effacement");
    expect(fichier).toMatch(/console\/effacement\/quotidienne\/console-effacement-quotidienne-\d{8}-\d{6}\.journal$/);
    const champs = readFileSync(fichier ?? "", "utf8").trim().split("\t");
    expect(champs).toHaveLength(7);
    expect(champs[1]).toBe("effacement");
    expect(champs[4]).toBe("ok");
    expect(champs[6]).toBe("20261102-010000F");
    expect(champs[3]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("[C-049] un effacement en échec écrit une ligne « echec » et sort en erreur", () => {
    const b = banc();
    writeFileSync(b.info, infoDeux("2026-11-02"));
    const r = lancer(b, "expirer.sh", [], { EXPIRER_AUJOURDHUI: "2026-11-02", STUB_EXPIRE_CODE: "5" });
    expect(r.status).not.toBe(0);
    const [fichier] = fichiersJournal(b, "effacement");
    expect(fichier).toBeDefined();
    expect(readFileSync(fichier ?? "", "utf8").trim().split("\t")[4]).toBe("echec");
  });

  it("[C-049] un passage sans rien à effacer écrit quand même sa ligne (c'est elle qui prouve que la tâche a tourné)", () => {
    const b = banc();
    writeFileSync(b.info, infoAvecArret("2026-11-02T01:05:00Z"));
    const r = lancer(b, "expirer.sh", [], { EXPIRER_AUJOURDHUI: "2026-11-02" });
    expect(r.status, r.stderr).toBe(0);
    const [fichier] = fichiersJournal(b, "effacement");
    const champs = readFileSync(fichier ?? "", "utf8").trim().split("\t");
    expect(champs[4]).toBe("ok");
    expect(champs[6]).toBe("aucun");
  });
});

describe("contrôle de fraîcheur et alertes (T1B-05)", () => {
  it("[C-602] le contrôle de fraîcheur lève l'alerte quand la dernière sauvegarde valide a plus de 26 heures", () => {
    const b = banc();
    writeFileSync(b.info, infoAvecArret("2026-11-01T09:59:00Z")); // 26 h 01 avant NOW
    const r = controle(b);
    expect(r.status, r.stderr).toBe(0);
    const alertes = alertesEnvoyees(b);
    expect(alertes).toHaveLength(1);
    expect(alertes[0]).toMatch(/^sauvegarde_en_retard\|reveil\|/);
    expect(alertes[0]).toMatch(/26 heures/);
    // Une sauvegarde en erreur ne compte pas : seule la dernière VALIDE fait foi.
    const c = banc();
    writeFileSync(
      c.info,
      JSON.stringify([
        {
          name: "commun",
          backup: [
            { label: "a", type: "full", error: false, reference: null, timestamp: { start: unix("2026-10-30T02:00:00Z"), stop: unix("2026-10-30T02:05:00Z") } },
            { label: "b", type: "full", error: true, reference: null, timestamp: { start: unix("2026-11-02T10:00:00Z"), stop: unix("2026-11-02T10:05:00Z") } },
          ],
        },
      ]),
    );
    expect(controle(c).status).toBe(0);
    expect(alertesEnvoyees(c).filter((a) => a.startsWith("sauvegarde_en_retard|reveil|"))).toHaveLength(1);
  });

  it("[C-602] le contrôle de fraîcheur ne lève aucune alerte quand la dernière sauvegarde valide a moins de 26 heures", () => {
    const b = banc();
    writeFileSync(b.info, infoAvecArret("2026-11-01T10:01:00Z")); // 25 h 59 avant NOW
    const r = controle(b);
    expect(r.status, r.stderr).toBe(0);
    expect(alertesEnvoyees(b)).toEqual([]);
  });

  it("[C-602] le contrôle de fraîcheur lève l'alerte quand aucune sauvegarde n'existe", () => {
    for (const info of ["[]", JSON.stringify([{ name: "commun", backup: [] }])]) {
      const b = banc();
      writeFileSync(b.info, info);
      const r = controle(b);
      expect(r.status, r.stderr).toBe(0);
      const alertes = alertesEnvoyees(b);
      expect(alertes).toHaveLength(1);
      expect(alertes[0]).toMatch(/^sauvegarde_absente\|reveil\|/);
    }
  });

  it("[C-602] une liste illisible n'est jamais prise pour une sauvegarde fraîche : alerte et sortie en erreur", () => {
    const b = banc();
    writeFileSync(b.info, "pas du json");
    const r = controle(b);
    expect(r.status).not.toBe(0);
    expect(alertesEnvoyees(b).filter((a) => a.startsWith("sauvegarde_illisible|reveil|"))).toHaveLength(1);
  });

  it("[C-602] le contrôle lève l'alerte quand le stockage de sauvegarde atteint 80 %", () => {
    const b = banc();
    writeFileSync(b.info, infoAvecArret("2026-11-02T08:00:00Z"));
    const sous = controle(b, { STOCKAGE_UTILISE_OCTETS: "799", STOCKAGE_TOTAL_OCTETS: "1000" }); // 79,9 %
    expect(sous.status, sous.stderr).toBe(0);
    expect(alertesEnvoyees(b)).toEqual([]);
    const pile = controle(b, { STOCKAGE_UTILISE_OCTETS: "800", STOCKAGE_TOTAL_OCTETS: "1000" }); // 80,0 %
    expect(pile.status, pile.stderr).toBe(0);
    const alertes = alertesEnvoyees(b);
    expect(alertes).toHaveLength(1);
    expect(alertes[0]).toMatch(/^stockage_sauvegarde_plein\|matin\|/);
    expect(alertes[0]).toMatch(/80/);
    // Le seuil est une variable (valeur de production : T8A-10) : abaissé, le même état alerte.
    const b2 = banc();
    writeFileSync(b2.info, infoAvecArret("2026-11-02T08:00:00Z"));
    controle(b2, { STOCKAGE_UTILISE_OCTETS: "500", STOCKAGE_TOTAL_OCTETS: "1000", SEUIL_STOCKAGE_POURCENT: "50" });
    expect(alertesEnvoyees(b2).filter((a) => a.startsWith("stockage_sauvegarde_plein|matin|"))).toHaveLength(1);
  });

  it("[C-602] une mesure du stockage absente ou absurde est une erreur visible, jamais « tout va bien »", () => {
    const b = banc();
    writeFileSync(b.info, infoAvecArret("2026-11-02T08:00:00Z"));
    for (const env of [{ STOCKAGE_TOTAL_OCTETS: "" }, { STOCKAGE_TOTAL_OCTETS: "0" }, { STOCKAGE_UTILISE_OCTETS: "abc" }, { STOCKAGE_UTILISE_OCTETS: "2000", STOCKAGE_TOTAL_OCTETS: "1000" }]) {
      const r = controle(b, env);
      expect(r.status, JSON.stringify(env)).not.toBe(0);
      expect(r.stderr).toMatch(/stockage/i);
    }
  });

  const ligneEffacement = (b: Banc, iso: string, resultat: string) => {
    const stamp = iso.replace(/[-:]/g, "").replace("T", "-").replace("Z", "");
    const dir = join(b.journal, "console", "effacement", "quotidienne");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `console-effacement-quotidienne-${stamp}.journal`), [iso, "effacement", "0", "sha256:" + "0".repeat(64), resultat, "3", "aucun"].join("\t") + "\n");
  };

  it("[C-602] l'alerte part quand l'effacement n'a pas tourné depuis 2 nuits ou a échoué", () => {
    // Dernier effacement réussi il y a 47 h : rien. Il y a 49 h : alerte.
    const recent = banc();
    writeFileSync(recent.info, infoAvecArret("2026-11-02T08:00:00Z"));
    ligneEffacement(recent, "2026-10-31T13:00:00Z", "ok");
    expect(controle(recent).status).toBe(0);
    expect(alertesEnvoyees(recent)).toEqual([]);

    const vieux = banc();
    writeFileSync(vieux.info, infoAvecArret("2026-11-02T08:00:00Z"));
    ligneEffacement(vieux, "2026-10-30T10:59:00Z", "ok");
    expect(controle(vieux).status).toBe(0);
    expect(alertesEnvoyees(vieux).filter((a) => a.startsWith("effacement_en_retard|matin|"))).toHaveLength(1);

    // Des passages récents mais tous en échec : même alerte (un échec ne remet pas l'horloge à zéro).
    const echec = banc();
    writeFileSync(echec.info, infoAvecArret("2026-11-02T08:00:00Z"));
    ligneEffacement(echec, "2026-10-30T10:00:00Z", "ok");
    ligneEffacement(echec, "2026-11-01T10:00:00Z", "echec");
    ligneEffacement(echec, "2026-11-02T10:00:00Z", "echec");
    controle(echec);
    expect(alertesEnvoyees(echec).filter((a) => a.startsWith("effacement_en_retard|matin|"))).toHaveLength(1);
  });

  it("[C-602] l'effacement jamais lancé alerte seulement quand une sauvegarde de plus de 2 nuits existe déjà", () => {
    const neuf = banc();
    writeFileSync(neuf.info, JSON.stringify([{ name: "commun", backup: [{ label: "n", type: "full", error: false, reference: null, timestamp: { start: unix("2026-11-02T07:00:00Z"), stop: unix("2026-11-02T07:05:00Z") } }] }]));
    controle(neuf);
    expect(alertesEnvoyees(neuf)).toEqual([]);
    const ancien = banc();
    writeFileSync(
      ancien.info,
      JSON.stringify([
        {
          name: "commun",
          backup: [
            { label: "a", type: "full", error: false, reference: null, timestamp: { start: unix("2026-10-25T02:00:00Z"), stop: unix("2026-10-25T02:05:00Z") } },
            { label: "b", type: "full", error: false, reference: null, timestamp: { start: unix("2026-11-02T07:00:00Z"), stop: unix("2026-11-02T07:05:00Z") } },
          ],
        },
      ]),
    );
    controle(ancien);
    expect(alertesEnvoyees(ancien).filter((a) => a.startsWith("effacement_en_retard|matin|"))).toHaveLength(1);
  });

  it("[C-602] les messages d'alerte ne portent ni adresse, ni nom d'hôte, ni nom de client", () => {
    const b = banc();
    writeFileSync(b.info, "[]");
    ligneEffacement(b, "2026-10-01T10:00:00Z", "ok");
    controle(b, { STOCKAGE_UTILISE_OCTETS: "900", STOCKAGE_TOTAL_OCTETS: "1000" });
    const tout = alertesEnvoyees(b).join("\n");
    expect(alertesEnvoyees(b).length).toBeGreaterThanOrEqual(3);
    expect(tout).not.toMatch(/\d+\.\d+\.\d+\.\d+|https?:|\.(test|fr|com)\b|cli_|@/);
  });

  it("[C-602] sans commande d'alerte, le contrôle échoue au lieu de se taire", () => {
    const b = banc();
    writeFileSync(b.info, "[]");
    const r = controle(b, { ALERTE_COMMANDE: "" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/ALERTE_COMMANDE/);
  });

  it("[C-602] une commande d'alerte qui échoue fait échouer le contrôle", () => {
    const b = banc();
    writeFileSync(b.info, "[]");
    writeFileSync(join(b.dir, "alerte-ko.sh"), "#!/usr/bin/env bash\nexit 9\n");
    chmodSync(join(b.dir, "alerte-ko.sh"), 0o755);
    const r = controle(b, { ALERTE_COMMANDE: join(b.dir, "alerte-ko.sh") });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/commande d'alerte.*(échou|code 9)/);
  });
});

describe("planification de nuit (T1B-05)", () => {
  const planification = () => lire("planification.modele");

  it("[C-045] la planification versionnée lance la sauvegarde de nuit à une heure en variable, jamais depuis un workflow GitHub", () => {
    const texte = planification();
    expect(texte).toMatch(/sauvegarder-nuit\.sh/);
    expect(texte).toMatch(/OnCalendar=\*-\*-\* @HEURE_SAUVEGARDE@/);
    expect(texte).toMatch(/Persistent=true/);
    // Aucune heure de production écrite : seulement la variable.
    expect(texte).not.toMatch(/OnCalendar=\*-\*-\* \d/);
    expect(texte).toMatch(/\[À DÉFINIR\]/);
    const racineWorkflows = join(racine, ".github", "workflows");
    for (const f of existsSync(racineWorkflows) ? readdirSync(racineWorkflows) : []) {
      expect(readFileSync(join(racineWorkflows, f), "utf8"), f).not.toMatch(/sauvegarder-nuit|expirer\.sh|controle-fraicheur/);
    }
  });

  it("[C-602] le contrôle de fraîcheur a sa propre minuterie, distincte de la sauvegarde, et l'effacement la sienne (compte distinct)", () => {
    const texte = planification();
    const fichiers = [...texte.matchAll(/^# --- fichier : (\S+) ---$/gm)].map((m) => m[1]);
    expect(fichiers).toEqual(expect.arrayContaining(["axion-sauvegarde-nuit.service", "axion-sauvegarde-nuit.timer", "axion-sauvegarde-controle.service", "axion-sauvegarde-controle.timer", "axion-sauvegarde-effacement.service", "axion-sauvegarde-effacement.timer"]));
    expect(texte).toMatch(/ExecStart=.*controle-fraicheur\.sh/);
    expect(texte).toMatch(/OnCalendar=hourly|OnCalendar=\*-\*-\* \*:@MINUTE_CONTROLE@/);
    // La sauvegarde et l'effacement ne se lancent jamais l'un par l'autre ni dans la même unité ; l'effacement tourne sous un compte distinct.
    const effacement = /# --- fichier : axion-sauvegarde-effacement\.service ---\n([\s\S]*?)(?=\n# --- fichier|$)/.exec(texte)?.[1] ?? "";
    expect(effacement).toMatch(/ExecStart=.*expirer\.sh/);
    expect(effacement).not.toMatch(/sauvegarder-nuit/);
    expect(effacement).toMatch(/User=@COMPTE_EFFACEMENT@/);
    const nuit = /# --- fichier : axion-sauvegarde-nuit\.service ---\n([\s\S]*?)(?=\n# --- fichier|$)/.exec(texte)?.[1] ?? "";
    expect(nuit).not.toMatch(/expirer\.sh/);
  });

  it("[C-602] la planification ne contient ni secret, ni adresse, ni nom d'hôte", () => {
    const texte = planification();
    expect(texte).not.toMatch(/\d+\.\d+\.\d+\.\d+|https?:\/\/|BAO_JETON=|PHRASE=|password/i);
  });
});
