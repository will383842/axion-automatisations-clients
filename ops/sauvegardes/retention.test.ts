import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { calculerRetention, completesDepuisInfo, ensemblesAExpirer, verifierNode, type Sauvegarde } from "./retention.ts";

// Une sauvegarde complète par nuit, à 02:00 UTC, sur 400 jours simulés qui finissent le 2026-10-26.
const AUJOURDHUI = "2026-10-26";
const jour = (decalage: number) => new Date(Date.UTC(2026, 9, 26 - decalage));
const nuits = (n: number): Sauvegarde[] =>
  Array.from({ length: n }, (_, i) => {
    const d = jour(n - 1 - i);
    return { id: `${d.toISOString().slice(0, 10)}-F`, date: `${d.toISOString().slice(0, 10)}T02:00:00Z` };
  });

describe("rétention des sauvegardes complètes", () => {
  it("[C-049] la rétention garde 30 quotidiennes et 12 mensuelles sur 400 jours simulés", () => {
    const r = calculerRetention(nuits(400), AUJOURDHUI);
    expect(r.quotidiennes).toHaveLength(30);
    expect(r.mensuelles).toHaveLength(12);
    // Les 30 quotidiennes sont les 30 dernières nuits.
    expect(r.quotidiennes[0]?.id).toBe("2026-09-27-F");
    expect(r.quotidiennes[29]?.id).toBe("2026-10-26-F");
    // Chaque mensuelle est la dernière sauvegarde de son mois ; le mois en cours compte, avec la plus récente.
    expect(r.mensuelles.map((s) => s.id.slice(0, 7))).toEqual([
      "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10",
    ]);
    expect(r.mensuelles[0]?.id).toBe("2025-11-30-F");
    expect(r.mensuelles[11]?.id).toBe("2026-10-26-F");
  });

  it("[C-049] tout le reste est à expirer, rien n'est gardé deux fois", () => {
    const toutes = nuits(400);
    const r = calculerRetention(toutes, AUJOURDHUI);
    const gardees = new Set(r.garder.map((s) => s.id));
    expect(gardees.size).toBe(r.garder.length);
    expect(r.garder.length).toBe(30 + 10); // les mensuelles de septembre et d'octobre sont déjà des quotidiennes
    expect(r.expirer.length + r.garder.length).toBe(toutes.length);
    expect(r.expirer.every((s) => !gardees.has(s.id))).toBe(true);
  });

  it("[C-049] avec peu de sauvegardes, on garde tout sans en inventer", () => {
    const r = calculerRetention(nuits(5), AUJOURDHUI);
    expect(r.quotidiennes).toHaveLength(5);
    expect(r.expirer).toHaveLength(0);
  });

  it("[C-049] une date de sauvegarde illisible fait échouer le calcul plutôt que d'effacer", () => {
    expect(() => calculerRetention([{ id: "x", date: "pas une date" }], AUJOURDHUI)).toThrow();
  });

  it("[C-049] une sauvegarde datée après aujourd'hui n'expire jamais (lendemain, mois suivant)", () => {
    const futures = [
      { id: "2026-10-27-F", date: "2026-10-27T00:00:00Z" },
      { id: "2026-11-15-F", date: "2026-11-15T02:00:00Z" },
    ];
    const r = calculerRetention([...nuits(400), ...futures], AUJOURDHUI);
    expect(r.futures.map((s) => s.id)).toEqual(["2026-10-27-F", "2026-11-15-F"]);
    for (const f of futures) {
      expect(r.garder.map((s) => s.id)).toContain(f.id);
      expect(r.expirer.map((s) => s.id)).not.toContain(f.id);
    }
    // La fin du jour courant reste « aujourd'hui » : 23:59 UTC du 26 est une quotidienne, pas une future.
    const tard = calculerRetention([{ id: "tard", date: "2026-10-26T23:59:59Z" }], AUJOURDHUI);
    expect(tard.futures).toHaveLength(0);
    expect(tard.quotidiennes).toHaveLength(1);
  });

  it("[C-049] la plus récente est toujours gardée, même si l'horloge avance de plusieurs années", () => {
    const r = calculerRetention(nuits(400), "2030-01-01");
    expect(r.garder.map((s) => s.id)).toEqual(["2026-10-26-F"]);
    expect(r.expirer).toHaveLength(399);
  });

  it("[C-049] les ensembles à expirer se lisent dans la sortie de pgbackrest info, complètes seulement", () => {
    const epoque = (iso: string) => Date.parse(iso) / 1000;
    const info = JSON.stringify([
      {
        name: "commun",
        backup: [
          { label: "20200101-020000F", type: "full", timestamp: { start: epoque("2020-01-01T02:00:00Z"), stop: epoque("2020-01-01T02:05:00Z") } },
          { label: "20200101-020000F_20200102-020000I", type: "incr", timestamp: { start: 1, stop: 2 } },
          { label: "20261026-020000F", type: "full", timestamp: { start: epoque("2026-10-26T02:00:00Z"), stop: epoque("2026-10-26T02:05:00Z") } },
        ],
      },
    ]);
    expect(completesDepuisInfo(info).map((s) => s.id)).toEqual(["20200101-020000F", "20261026-020000F"]);
    expect(ensemblesAExpirer(info, AUJOURDHUI)).toEqual(["20200101-020000F"]);
    expect(ensemblesAExpirer(info, "2020-01-02")).toEqual([]);
    expect(ensemblesAExpirer("[]", AUJOURDHUI)).toEqual([]);
  });

  it("[C-049] une sortie de pgbackrest info inattendue fait échouer plutôt qu'expirer", () => {
    expect(() => ensemblesAExpirer("pas du JSON", AUJOURDHUI)).toThrow();
    expect(() => ensemblesAExpirer('{"backup":[]}', AUJOURDHUI)).toThrow();
    expect(() => ensemblesAExpirer('[{"name":"commun"}]', AUJOURDHUI)).toThrow();
    expect(() => ensemblesAExpirer('[{"backup":[{"label":"x","type":"full"}]}]', AUJOURDHUI)).toThrow();
  });
});

// Sortie de « pgbackrest info » pour une liste d'entrées : label, type, arrêt (ISO), références éventuelles, erreur éventuelle.
interface Entree {
  label: string;
  type: "full" | "diff" | "incr";
  arret: string;
  reference?: string[];
  error?: boolean;
}
const infoDe = (entrees: Entree[]) =>
  JSON.stringify([
    {
      name: "commun",
      backup: entrees.map((e) => ({
        label: e.label,
        type: e.type,
        timestamp: { start: Date.parse(e.arret) / 1000 - 300, stop: Date.parse(e.arret) / 1000 },
        ...(e.reference ? { reference: e.reference } : {}),
        ...(e.error === undefined ? {} : { error: e.error }),
      })),
    },
  ]);
const complete = (jour: string): Entree => ({ label: `${jour.replaceAll("-", "")}-020000F`, type: "full", arret: `${jour}T02:05:00Z` });

describe("garde-fous de la rétention (réserve 1 de la PR #59)", () => {
  it("[C-049] la rétention refuse d'expirer quand la plus récente sauvegarde a plus de 2 jours", () => {
    const info = infoDe([complete("2026-01-01"), complete("2026-10-23")]);
    // 3 jours d'écart (nuits manquées ou horloge qui avance) : échec net, aucun identifiant imprimé.
    expect(() => ensemblesAExpirer(info, "2026-10-26")).toThrow(/plus récente.*2 jours/);
    // 2 jours d'écart : encore admis.
    expect(ensemblesAExpirer(infoDe([complete("2026-01-01"), complete("2026-10-24")]), "2026-10-26")).toEqual([]);
    // Horloge qui avance de plusieurs années : refus, plutôt que d'expirer toute la rétention.
    expect(() => ensemblesAExpirer(infoDe(nuits(400).map((s) => complete(s.date.slice(0, 10)))), "2030-01-01")).toThrow(/2 jours/);
  });

  it("[C-049] la toute première sauvegarde n'est pas bloquée par la garde des 2 jours : sans sauvegarde, rien à expirer et pas d'erreur", () => {
    expect(ensemblesAExpirer("[]", "2026-10-26")).toEqual([]);
    expect(ensemblesAExpirer('[{"name":"commun","backup":[]}]', "2026-10-26")).toEqual([]);
  });

  it("[C-049] une sauvegarde error:true n'entre pas dans le compte des 30 quotidiennes", () => {
    // 30 nuits saines + une nuit en erreur, plus récente que toutes : elle ne compte pas, la 31e plus ancienne saine part.
    const saines = nuits(31).map((s) => complete(s.date.slice(0, 10)));
    const enErreur: Entree = { label: "20261026-030000F", type: "full", arret: "2026-10-26T03:05:00Z", error: true };
    const avecErreur = ensemblesAExpirer(infoDe([...saines.slice(0, -1), enErreur]), "2026-10-26");
    expect(avecErreur).not.toContain(enErreur.label);
    // Seule la saine du 26-09, hors de la fenêtre des 30 jours, part : l'erreur ne prend la place d'aucune saine.
    expect(avecErreur).toEqual(["20260926-020000F"]);
    // Une sauvegarde saine du jour qui suit une sauvegarde en erreur reste la quotidienne du jour.
    const saine = { ...complete("2026-10-26") };
    expect(ensemblesAExpirer(infoDe([complete("2025-01-01"), enErreur, saine]), "2026-10-26")).toEqual([complete("2025-01-01").label]);
  });

  it("[C-049] retention.ts refuse un Node inférieur à 22.18", () => {
    expect(() => verifierNode("22.17.9")).toThrow(/Node 22\.18/);
    expect(() => verifierNode("20.19.0")).toThrow(/Node 22\.18/);
    expect(() => verifierNode("18.0.0")).toThrow(/Node 22\.18/);
    expect(() => verifierNode("n'importe quoi")).toThrow(/Node 22\.18/);
    expect(() => verifierNode("22.18.0")).not.toThrow();
    expect(() => verifierNode("22.22.0")).not.toThrow();
    expect(() => verifierNode("24.1.0")).not.toThrow();
  });

  it("[C-049] retention.ts refuse un Node inférieur à 22.18 : expirer.sh s'arrête avant tout appel à docker", () => {
    const faux = mkdtempSync(join(tmpdir(), "faux-node-"));
    writeFileSync(join(faux, "node"), '#!/bin/sh\necho v22.17.0\n');
    chmodSync(join(faux, "node"), 0o755);
    const r = spawnSync(join(import.meta.dirname, "expirer.sh"), ["--simuler"], { encoding: "utf8", env: { ...process.env, PATH: `${faux}:${process.env.PATH}` } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Node 22\.18/);
    expect(r.stderr).not.toMatch(/docker/);
  });

  it("[C-049] avec une complète par semaine et des différences chaque nuit, la rétention garde 30 quotidiennes et 12 mensuelles et ne retire jamais une complète dont dépend une différence gardée", () => {
    // 400 nuits finissant le 2026-10-26 ; une complète chaque lundi, une différence les autres nuits (qui dépend de la complète de sa semaine).
    const entrees: Entree[] = [];
    let derniereComplete = "";
    for (const s of nuits(400)) {
      const j = s.date.slice(0, 10);
      if (new Date(`${j}T00:00:00Z`).getUTCDay() === 1 || derniereComplete === "") {
        const c = complete(j);
        derniereComplete = c.label;
        entrees.push(c);
      } else {
        entrees.push({ label: `${derniereComplete}_${j.replaceAll("-", "")}-020000D`, type: "diff", arret: `${j}T02:05:00Z`, reference: [derniereComplete] });
      }
    }
    const info = infoDe(entrees);
    const aExpirer = ensemblesAExpirer(info, AUJOURDHUI);
    const parLabel = new Map(entrees.map((e) => [e.label, e]));
    // Seules des complètes sont désignées : une différence ne part jamais seule.
    for (const id of aExpirer) expect(parLabel.get(id)?.type).toBe("full");
    // Les 30 dernières nuits (quotidiennes) restent toutes lisibles : leur complète n'est pas désignée.
    const gardees = entrees.filter((e) => !aExpirer.includes(e.label) && !(e.reference ?? []).some((r) => aExpirer.includes(r)));
    const jours = new Set(gardees.map((e) => e.arret.slice(0, 10)));
    for (const s of nuits(30)) expect(jours).toContain(s.date.slice(0, 10));
    // 12 mensuelles : la dernière sauvegarde de chacun des 12 derniers mois reste lisible.
    for (const m of ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]) {
      const derniere = [...entrees].reverse().find((e) => e.arret.startsWith(m));
      expect(gardees.map((e) => e.label)).toContain(derniere?.label);
    }
    // Jamais une complète dont dépend une différence gardée.
    for (const e of gardees) for (const r of e.reference ?? []) expect(aExpirer).not.toContain(r);
    // Et on expire bel et bien de l'ancien (les vieilles semaines hors des deux fenêtres).
    expect(aExpirer.length).toBeGreaterThan(20);
    expect(aExpirer).toContain(entrees[0]?.label);
  });
});

// Réserves 2, 3, 5 et 6 : les scripts tournent ici sans conteneur (faux « docker » dans le PATH, copie du dossier avec un modèle modifié).
const SCRIPTS = import.meta.dirname;
const copieDesScripts = (modele?: string) => {
  const d = mkdtempSync(join(tmpdir(), "scripts-sauv-"));
  for (const f of readdirSync(SCRIPTS)) if (f.endsWith(".sh") || f.startsWith("pgbackrest.conf.")) copyFileSync(join(SCRIPTS, f), join(d, f));
  for (const f of readdirSync(d)) if (f.endsWith(".sh")) chmodSync(join(d, f), 0o755);
  if (modele !== undefined) writeFileSync(join(d, "pgbackrest.conf.modele"), modele);
  return d;
};

describe("scripts de sauvegarde (réserves 2, 3, 5 et 6 de la PR #59)", () => {
  it("[C-056] restaurer.sh refuse host-key-check-type=none hors mode essai", () => {
    const d = copieDesScripts("[global]\nrepo1-sftp-host-key-check-type=none\n");
    const jeton = join(d, "jeton");
    writeFileSync(jeton, "TEST-NE-PAS-UTILISER-jeton");
    const hors = { ...process.env, BAO_ADDR: "http://openbao.test:8200", BAO_JETON_FICHIER: jeton };
    delete hors.SAUVEGARDE_ESSAI;
    const r = spawnSync(join(d, "restaurer.sh"), [], { encoding: "utf8", env: hors });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/host-key-check-type=none n'est admis qu'en essai/);
    // Un modèle épinglé n'est pas refusé pour cette raison (l'échec vient alors de l'absence de docker/socle).
    const epingle = copieDesScripts("[global]\nrepo1-sftp-host-key-check-type=fingerprint\n");
    const r2 = spawnSync(join(epingle, "restaurer.sh"), [], { encoding: "utf8", env: { ...hors, PATH: "/usr/bin:/bin" } });
    expect(r2.stderr).not.toMatch(/host-key-check-type=none/);
  });

  it("[C-593] après le lancement de la restauration, la phrase n'est plus dans l'environnement du processus postgres", () => {
    const sh = readFileSync(join(SCRIPTS, "restaurer.sh"), "utf8");
    const interne = sh.slice(sh.indexOf("--entrypoint bash"));
    // Configuration sur un tmpfs, en 0400 ; la phrase est retirée de l'environnement (et le fichier supprimé) AVANT l'exec de postgres.
    expect(interne).toMatch(/PGBACKREST_CONFIG=\/dev\/shm\//);
    expect(interne).toMatch(/umask 277/);
    expect(interne).not.toMatch(/PGBACKREST_CONFIG=\/tmp/);
    const unset = interne.indexOf("unset ");
    const exec = interne.indexOf("exec postgres");
    expect(unset).toBeGreaterThan(-1);
    expect(exec).toBeGreaterThan(unset);
    expect(interne.slice(unset, exec)).toMatch(/PGBACKREST_REPO1_CIPHER_PASS/);
    expect(interne.slice(unset, exec)).toMatch(/rm -f "\$PGBACKREST_CONFIG"/);
    // Le comportement réel (/proc/1/environ du conteneur restauré) est prouvé dans tests/socle/sauvegardes.int.test.ts.
  });

  it("[C-593] lire-phrase-chiffrement.sh échoue en moins de N secondes quand OpenBao ne répond pas", async () => {
    // Faux OpenBao : accepte la connexion et ne répond jamais.
    const muet = createServer(() => undefined);
    await new Promise<void>((ok) => muet.listen(0, "127.0.0.1", ok));
    const port = (muet.address() as AddressInfo).port;
    const d = copieDesScripts();
    writeFileSync(join(d, "jeton"), "TEST-NE-PAS-UTILISER-jeton");
    const debut = Date.now();
    const r = await new Promise<{ status: number | null; stderr: string }>((fin) => {
      const env = { ...process.env, BAO_ADDR: `http://127.0.0.1:${port}`, BAO_JETON_FICHIER: join(d, "jeton"), BAO_DELAI: "2" };
      delete env.SAUVEGARDE_ESSAI;
      const p = spawnSync(join(d, "lire-phrase-chiffrement.sh"), [], { encoding: "utf8", env, timeout: 20_000 });
      fin({ status: p.status, stderr: p.stderr });
    });
    muet.close();
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull();
    expect(r.stderr).toMatch(/n'a pas répondu en 2 s/);
    expect(Date.now() - debut).toBeLessThan(8000);
  }, 30_000);

  describe("copier-artefacts.sh refuse les chemins qui sortent de la cible", () => {
    // Faux « docker exec <conteneur> wget … » : la liste du compartiment contient les chemins fournis, tout fichier se lit « contenu ».
    const lancer = (chemins: string[]) => {
      const racine = mkdtempSync(join(tmpdir(), "artefacts-"));
      const cible = join(racine, "cible");
      mkdirSync(cible);
      const bin = join(racine, "bin");
      mkdirSync(bin);
      const entrees = chemins.map((c) => `{"FullPath":"/buckets/artefacts/${c}","Mode":432}`).join(",");
      writeFileSync(join(bin, "docker"), `#!/bin/sh\ncase "$*" in *"?limit="*) printf '%s' '{"Entries":[${entrees}]}' ;; *) printf 'contenu' ;; esac\n`);
      chmodSync(join(bin, "docker"), 0o755);
      const r = spawnSync(join(SCRIPTS, "copier-artefacts.sh"), ["--compartiment", "faux-stockage", cible], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      return { r, racine, cible };
    };

    it("[A-192] copier-artefacts.sh refuse un chemin contenant .. ou commençant par /", () => {
      for (const mauvais of ["../hors-cible.txt", "module/../../hors-cible.txt", "/etc/hors-cible.txt"]) {
        const { r, racine, cible } = lancer([mauvais]);
        expect(r.status, mauvais).not.toBe(0);
        expect(r.stderr, mauvais).toMatch(/chemin refusé/);
        expect(existsSync(join(racine, "hors-cible.txt")), mauvais).toBe(false);
        expect(readdirSync(cible), mauvais).toEqual([]);
      }
    });

    it("[A-192] copier-artefacts.sh copie encore un chemin relatif ordinaire", () => {
      const { r, cible } = lancer(["module-a/v1/artefact.tgz"]);
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(join(cible, "module-a/v1/artefact.tgz"), "utf8")).toBe("contenu");
    });
  });
});
