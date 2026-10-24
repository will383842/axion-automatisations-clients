import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { verifierTextePr } from "../verifier-texte-pr.js";
import { chargerListe, chercher, chercherNomDeFichier, dequoter, formaterNomDeFichier, formaterTrouvailles, parserListe } from "./chercher.js";
import { normaliser, normaliserEntree } from "./normaliser.js";

// Nom inventé DES TESTS : il n'est dans aucune vraie liste.
const NOM = "Quincaillerie Zéphyrine Ostrowska";
const liste = parserListe(`${NOM} SARL`);
const racine = fileURLToPath(new URL("../..", import.meta.url));
const chercherTs = join(racine, "scripts/garde-noms/chercher.ts");
const depot = mkdtempSync(join(tmpdir(), "garde-noms-"));
afterAll(() => rmSync(depot, { recursive: true, force: true }));

const env = (extra: Record<string, string>) => ({ PATH: process.env["PATH"] ?? "", HOME: depot, ...extra });
const git = (...a: string[]) => execFileSync("git", a, { cwd: depot, encoding: "utf8", env: env({ GIT_CONFIG_GLOBAL: "/dev/null" }) });

describe("garde des noms : recherche", () => {
  it("[C-611] normalise accents, casse et séparateurs, et retire les formes juridiques des entrées", () => {
    expect(normaliser("Zéphyrine_OSTROWSKA")).toBe("zephyrine ostrowska");
    expect(normaliserEntree("Atelier Truc SARL")).toBe("atelier truc");
  });
  it("[C-611] les ligatures œ et æ valent oe et ae", () => {
    expect(normaliser("Cœur Æsop")).toBe("coeur aesop");
    expect(chercher("Atelier Bertin Cœur", parserListe("bertin coeur"))).toHaveLength(1);
  });
  it("[C-611] trouve « QUINCAILLERIE-zephyrine_ostrowska »", () => {
    expect(chercher("une phrase\nQUINCAILLERIE-zephyrine_ostrowska ici", liste)).toEqual([{ ligne: 2, numero: 1 }]);
  });
  it("[C-611] trouve le nom collé", () => {
    expect(chercher("quincaillerie­zephyrineostrowska.test".replace("­", ""), liste)).toHaveLength(1);
  });
  it("[C-611] ne déclenche pas sur « Lemoine Rénovation »", () => {
    expect(chercher("Lemoine Rénovation et Lemoine-Renovation", liste)).toEqual([]);
  });
  it("[C-611] trouve le nom dans un nom de fichier, sans le montrer", () => {
    const n = chercherNomDeFichier("docs/quincaillerie-zephyrine-ostrowska.md", liste);
    expect(formaterNomDeFichier(n)).toEqual(["nom de fichier interdit (n° 1)"]);
  });
  it("[C-531] la sortie ne contient jamais le nom", () => {
    const texte = `${NOM}\nQUINCAILLERIE-zephyrine_ostrowska`;
    const sortie = [...formaterTrouvailles("fichier x.md", chercher(texte, liste)), ...formaterNomDeFichier([1]), ...verifierTextePr(NOM, texte, liste)].join("\n");
    for (const morceau of ["quincaillerie", "zephyrine", "zéphyrine", "ostrowska"]) expect(sortie.toLowerCase()).not.toContain(morceau);
    expect(sortie).toContain("nom interdit, fichier x.md, ligne 1");
  });
  it("[C-611] verifier-texte-pr refuse un titre ou un corps contenant le nom", () => {
    expect(verifierTextePr("T0-10", "ok", liste)).toEqual([]);
    expect(verifierTextePr("T0-10", `a\n${NOM}`, liste)).toEqual(["nom interdit, corps de la PR, ligne 2"]);
    expect(verifierTextePr(NOM, "ok", liste)).toEqual(["nom interdit, titre de la PR, ligne 1"]);
  });
});

describe("garde des noms : échec fermé", () => {
  it("[C-611] liste absente et AXION_ROUTINE=1 : refus ; sinon avertissement", () => {
    expect(chargerListe({ AXION_ROUTINE: "1" }).refus).toBeDefined();
    expect(chargerListe({ AXION_ROUTINE: "1", NOMS_CLIENTS: "  \n" }).refus).toBeDefined();
    expect(chargerListe({}).refus).toBeUndefined();
    expect(chargerListe({}).avertissement).toBeDefined();
    expect(chargerListe({ AXION_ROUTINE: "1", NOMS_CLIENTS: NOM }).refus).toBeUndefined();
  });
  it("[C-611] pre-push refuse si NOMS_CLIENTS absente et AXION_ROUTINE=1", () => {
    const r = spawnSync("sh", [join(racine, ".githooks/pre-push")], { cwd: racine, input: "", encoding: "utf8", env: env({ AXION_ROUTINE: "1" }) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("NOMS_CLIENTS absente");
  });
});

describe("garde des noms : crochets sur un dépôt temporaire", () => {
  const lancer = (mode: string, entree = "", extra: Record<string, string> = {}) =>
    spawnSync("node", [chercherTs, mode], { cwd: depot, input: entree, encoding: "utf8", env: env({ AXION_ROUTINE: "1", NOMS_CLIENTS: NOM, ...extra }) });

  it("[C-611] pre-commit refuse une ligne ajoutée, avec fichier et ligne, sans le nom", () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@exemple.fr");
    git("config", "user.name", "t");
    writeFileSync(join(depot, "a.md"), `propre\nvoici ${NOM}\n`);
    git("add", "a.md");
    const r = lancer("pre-commit");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nom interdit, fichier a.md, ligne 2");
    expect(r.stderr.toLowerCase()).not.toContain("ostrowska");
  });
  it("[C-611] pre-commit refuse un nom de fichier", () => {
    git("reset", "-q");
    mkdirSync(join(depot, "d"), { recursive: true });
    writeFileSync(join(depot, "d/quincaillerie-zephyrine-ostrowska.md"), "propre\n");
    git("add", "d");
    const r = lancer("pre-commit");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nom de fichier interdit (n° 1)");
  });
  it("[C-531] pre-commit masque le chemin quand le nom de fichier contient déjà le nom", () => {
    git("reset", "-q");
    writeFileSync(join(depot, "d/quincaillerie-zephyrine-ostrowska.md"), `propre\n${NOM}\n`);
    git("add", "d");
    const r = lancer("pre-commit");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("fichier masqué (n° 1), ligne 2");
    expect(r.stderr.toLowerCase()).not.toContain("ostrowska");
    expect(r.stderr.toLowerCase()).not.toContain("quincaillerie");
  });
  it("[C-531] pre-commit masque aussi le chemin quand il contient une espace", () => {
    git("reset", "-q");
    writeFileSync(join(depot, "d/quincaillerie zephyrine ostrowska notes.md"), `propre\n${NOM}\n`);
    git("add", "d");
    const r = lancer("pre-commit");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("fichier masqué (n° 1), ligne 2");
    expect(r.stderr.toLowerCase()).not.toContain("ostrowska");
    expect(r.stderr.toLowerCase()).not.toContain("quincaillerie");
  });
  const masquePour = (chemin: string, contenu: string) => {
    git("reset", "-q");
    writeFileSync(join(depot, chemin), contenu);
    git("add", "--", chemin);
    const r = lancer("pre-commit");
    const sortie = `${r.stdout}${r.stderr}`.toLowerCase();
    expect(r.status).toBe(1);
    for (const morceau of ["quincaillerie", "zephyrine", "zéphyrine", "ostrowska"]) expect(sortie).not.toContain(morceau);
    return r.stderr;
  };
  it("[C-531] chemin avec guillemet : jamais écrit, nom dans le chemin ET le contenu", () => {
    expect(masquePour('quincaillerie-zephyrine-ostrowska "v2".md', `propre\n${NOM}\n`)).toContain("fichier masqué (n° 1), ligne 2");
  });
  it("[C-531] chemin avec barre oblique inverse : jamais écrit", () => {
    expect(masquePour("quincaillerie-zephyrine-ostrowska\\v2.md", `propre\n${NOM}\n`)).toContain("fichier masqué (n° 1), ligne 2");
  });
  it("[C-531] chemin avec caractère de contrôle : jamais écrit", () => {
    expect(masquePour("quincaillerie\tzephyrine-ostrowska.md", `propre\n${NOM}\n`)).toContain("fichier masqué (n° 1), ligne 2");
  });
  it("[C-531] nom dans le contenu seulement, chemin à caractères spéciaux : chemin affiché sans le nom", () => {
    expect(masquePour('notes "v2" é.md', `${NOM}\n`)).toContain("ligne 1 (n° 1)");
  });
  it("[C-531] nom accentué ou en ligature dans le chemin : jamais écrit", () => {
    expect(masquePour("QUINCAILLERIE-Zéphyrine-Ostrowska-é.md", `${NOM}\n`)).toContain("fichier masqué (n° 1), ligne 1");
  });
  const coupes: [string, string][] = [
    ["barre oblique inverse au milieu du nom", "quincaillerie-zephyrine\\ostrowska.md"],
    ["barre oblique entre dossiers", "quincaillerie/zephyrine/ostrowska.md"],
    ["saut de ligne dans le chemin", "quincaillerie-zephyrine\nostrowska.md"],
  ];
  for (const [titre, chemin] of coupes) {
    it(`[C-531] nom coupé (${titre}) et dans le contenu : chemin jamais écrit`, () => {
      mkdirSync(join(depot, "quincaillerie/zephyrine"), { recursive: true });
      expect(masquePour(chemin, `propre\n${NOM}\n`)).toContain("fichier masqué (n° 1), ligne 2");
    });
    it(`[C-531] nom coupé (${titre}) sans contenu fautif : refusé, jamais écrit`, () => {
      mkdirSync(join(depot, "quincaillerie/zephyrine"), { recursive: true });
      expect(masquePour(chemin, "propre\n")).toContain("nom de fichier interdit (n° 1)");
    });
  }
  it("[C-531] dequoter défait le quoting de git", () => {
    expect(dequoter('"a\\"b\\\\c\\td\\303\\251"')).toBe('a"b\\c\td\u00e9');
  });
  it("[C-611] pre-commit refuse une ligne ajoutée qui commence par « ++ » (fausse ligne d'en-tête)", () => {
    git("reset", "-q");
    writeFileSync(join(depot, "c.md"), `++ ${NOM}\n`);
    git("add", "c.md");
    const r = lancer("pre-commit");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nom interdit, fichier c.md, ligne 1");
  });
  it("[C-611] pre-commit refuse aussi le nom dans un fichier au nom non ASCII", () => {
    git("reset", "-q");
    writeFileSync(join(depot, "énoncé.md"), `${NOM}\n`);
    git("add", "énoncé.md");
    expect(lancer("pre-commit").stderr).toContain("nom interdit, fichier énoncé.md, ligne 1");
  });
  it("[C-611] pre-commit laisse passer un contenu propre", () => {
    git("reset", "-q");
    writeFileSync(join(depot, "b.md"), "Lemoine Rénovation\n");
    git("add", "b.md");
    expect(lancer("pre-commit").status).toBe(0);
  });
  it("[C-611] pre-push refuse un message de commit et un nom de branche", () => {
    git("commit", "-q", "-m", `note ${NOM}`);
    const sha = git("rev-parse", "HEAD").trim();
    const zero = "0".repeat(40);
    const message = lancer("pre-push", `refs/heads/ok ${sha} refs/heads/ok ${zero}\n`);
    expect(message.status).toBe(1);
    expect(message.stderr).toContain("message du commit");
    const branche = lancer("pre-push", `refs/heads/x ${sha} refs/heads/quincaillerie-zephyrine-ostrowska ${zero}\n`);
    expect(branche.stderr).toContain("nom interdit, nom de branche");
    expect(`${message.stderr}${branche.stderr}`.toLowerCase()).not.toContain("ostrowska");
  });
});
