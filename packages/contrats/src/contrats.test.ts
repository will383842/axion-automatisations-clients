import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculerEmpreintes, calculerSommaire } from "../scripts/empreinte.ts";
import { CELLULES, CLES_TEST, constantes, schemasJson } from "../scripts/signer-fixtures.ts";
import { CONTRATS, lireVersions } from "../scripts/versions.ts";
import { Fait } from "./c2/faits.ts";
import { PREFIXE_C1, ROUTES_C1, type RouteC1 } from "./c1/routes.ts";
import { verifier } from "./commun/signature.ts";

const racine = new URL("../", import.meta.url);
const lire = (p: string) => readFileSync(new URL(p, racine), "utf8");
const json = (p: string) => JSON.parse(lire(p)) as unknown;

interface Cas { nom: string; valide: boolean; cle: string; horodatage: string; methode: string; chemin: string; corps: string; signature: string; secret: string }
interface Reponse { statut: number; nom: string; valide: boolean; corps: unknown }
const cas = (dossier: string) =>
  readdirSync(new URL(`fixtures/${dossier}/`, racine))
    .filter((f) => f.endsWith(".json") && f !== "json-schema.json")
    .map((f) => ({ f, ...(JSON.parse(lire(`fixtures/${dossier}/${f}`)) as { cas: Cas[]; reponses?: Reponse[] }) }));
const signee = (c: Cas) => verifier([{ id: c.cle, secret: c.secret }], { ...c, corps: Buffer.from(c.corps) }, Number(c.horodatage), () => false);

describe("fixtures signées", () => {
  it("[C-538] une empreinte par contrat, commun et C5 compris, chaque fichier d'empreintes correspond aux fixtures de son contrat", () => {
    const attendu = calculerEmpreintes(racine.pathname);
    expect(Object.keys(attendu)).toEqual(["commun", "c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(readdirSync(new URL("empreintes/", racine)).sort()).toEqual(Object.keys(attendu).map((c) => `${c}.sha256`).sort());
    for (const [c, texte] of Object.entries(attendu)) {
      expect(texte, c).not.toBe("");
      expect(lire(`empreintes/${c}.sha256`), c).toBe(texte);
    }
  });
  it("[C-538] l'empreinte d'un contrat ne contient que ses fixtures, celles que l'autre dépôt copie", () => {
    for (const [c, texte] of Object.entries(calculerEmpreintes(racine.pathname))) {
      for (const l of texte.trim().split("\n")) expect(l, c).toMatch(new RegExp(`^[0-9a-f]{64}  fixtures/${c}/`));
    }
  });
  it("[C-538] contrats.sha256 résume toutes les empreintes (commun et C5 compris) et VERSION, à jour", () => {
    const sommaire = lire("contrats.sha256");
    expect(sommaire).toBe(calculerSommaire(racine.pathname));
    for (const c of CONTRATS) expect(sommaire).toMatch(new RegExp(`  empreintes/${c}\\.sha256\\n`));
    expect(sommaire).toMatch(/ {2}VERSION\n$/);
  });

  it("[LOT0-contrats] la version de chaque fichier généré est celle de VERSION, tous les contrats en 0.x", () => {
    const v = lireVersions(racine.pathname);
    for (const c of CONTRATS) expect(v[c], c).toMatch(/^0\.\d+\.\d+$/);
    expect((json("fixtures/c1/json-schema.json") as { version: string }).version).toBe(v.c1);
    expect((json("fixtures/c2/json-schema.json") as { version: string }).version).toBe(v.c2);
    expect((json("fixtures/c3/json-schema.json") as { c3: { version: string } }).c3.version).toBe(v.c3);
    expect((json("fixtures/c4/json-schema.json") as { version: string }).version).toBe(v.c4);
    expect((json("fixtures/commun/constantes.json") as { version: string }).version).toBe(v.commun);
    expect((json("fixtures/c5/invariants.json") as { version: string }).version).toBe(v.c5);
    expect((json("fixtures/c6/constantes.json") as { version: string }).version).toBe(v.c6);
  });

  it("[LOT0-contrats] les JSON Schema et les constantes commités sont ceux que le code produit", () => {
    const s = schemasJson();
    expect(json("fixtures/c1/json-schema.json")).toEqual(s.c1);
    expect(json("fixtures/c2/json-schema.json")).toEqual(s.c2);
    expect(json("fixtures/c4/json-schema.json")).toEqual(s.c4);
    expect(json("fixtures/c4/cellules.json")).toEqual(CELLULES);
    const k = constantes();
    expect(json("fixtures/commun/constantes.json")).toEqual(k.commun);
    expect(json("fixtures/c5/invariants.json")).toEqual(k.c5);
    expect(json("fixtures/c6/constantes.json")).toEqual(k.c6);
  });

  it("[LOT0-c1] chaque route a un exemple valide et un invalide, signés avec la clé de test", () => {
    const fichiers = cas("c1");
    expect(fichiers.map((x) => x.f.replace(".json", "")).sort()).toEqual(Object.keys(ROUTES_C1).sort());
    for (const { f, cas: liste } of fichiers) {
      const route: RouteC1 = ROUTES_C1[f.replace(".json", "") as keyof typeof ROUTES_C1];
      expect(liste.some((c) => c.valide) && liste.some((c) => !c.valide)).toBe(true);
      for (const c of liste) {
        expect(c.secret.startsWith("TEST-NE-PAS-UTILISER-")).toBe(true);
        expect(signee(c)).toEqual({ ok: true, cle: CLES_TEST.c1.cle });
        const [chemin, requete = ""] = c.chemin.slice(PREFIXE_C1.length).split("?");
        const modele = new RegExp(`^${route.chemin.replace(/\{[^}]+\}/g, "[^/]+")}$`);
        const donnees = c.corps !== "" ? JSON.parse(c.corps) : Object.fromEntries(new URLSearchParams(requete));
        const conforme = modele.test(chemin ?? "") && (!route.requete || route.requete.safeParse(donnees).success);
        expect(conforme, `${f} / ${c.nom}`).toBe(c.valide);
      }
    }
  });

  it("[LOT0-c1] chaque réponse de C1 a un exemple valide et un invalide, pour chacun de ses statuts", () => {
    for (const { f, reponses = [] } of cas("c1")) {
      const route: RouteC1 = ROUTES_C1[f.replace(".json", "") as keyof typeof ROUTES_C1];
      for (const statut of Object.keys(route.reponses)) {
        const siennes = reponses.filter((r) => String(r.statut) === statut);
        expect(siennes.some((r) => r.valide) && siennes.some((r) => !r.valide), `${f} ${statut}`).toBe(true);
      }
      for (const r of reponses) expect(route.reponses[r.statut]?.safeParse(r.corps).success, `${f} / ${r.nom}`).toBe(r.valide);
    }
  });

  it("[LOT0-c2] chaque fait a un exemple valide et un invalide, signés avec la clé de test du Hub (un secret par sens)", () => {
    const fichiers = cas("c2");
    expect(fichiers).toHaveLength(10);
    for (const { f, cas: liste } of fichiers) {
      expect(liste.some((c) => c.valide) && liste.some((c) => !c.valide)).toBe(true);
      for (const c of liste) {
        expect(c.secret).toBe(CLES_TEST.c2.secret);
        expect(signee(c)).toEqual({ ok: true, cle: CLES_TEST.c2.cle });
        const r = Fait.safeParse(JSON.parse(c.corps));
        expect(r.success, `${f} / ${c.nom}`).toBe(c.valide);
        if (c.valide && r.success) expect(r.data.event_type).toBe(f.replace(".json", ""));
      }
    }
  });

  it("[LOT0-contrats] les fixtures archivées d'une version gelée restent valides (non-régression, README)", () => {
    const archives = new URL("fixtures-gelees/", racine);
    const versions = existsSync(archives) ? readdirSync(archives) : [];
    for (const v of versions) {
      for (const c of readdirSync(new URL(`${v}/c2/`, archives)).filter((f) => f !== "json-schema.json")) {
        const { cas: liste } = JSON.parse(readFileSync(new URL(`${v}/c2/${c}`, archives), "utf8")) as { cas: Cas[] };
        for (const x of liste.filter((y) => y.valide)) expect(Fait.safeParse(JSON.parse(x.corps)).success, `${v} ${c} ${x.nom}`).toBe(true);
      }
    }
    expect(versions.every((v) => /^\d+\.\d+\.\d+$/.test(v))).toBe(true);
  });
});
