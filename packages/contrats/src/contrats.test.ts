import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculerEmpreinteArchive, calculerEmpreintes, calculerSommaire } from "../scripts/empreinte.ts";
import { CELLULES, CLES_TEST, constantes, schemasJson } from "../scripts/signer-fixtures.ts";
import { CONTRATS, CONTRATS_GELES, lireVersions } from "../scripts/versions.ts";
import { CONTROLES_ARCHIVE } from "./archives.ts";
import { Fait } from "./c2/faits.ts";
import { PREFIXE_C1, ROUTES_C1, type RouteC1 } from "./c1/routes.ts";
import { LIMITES_DEBIT, RETRY_AFTER_MAX_SECONDES } from "./commun/debit.ts";
import { PERIODE_MAX_MOIS } from "./commun/identifiants.ts";
import { TVA_AUTOMATISATION_BPS } from "./commun/argent.ts";
import { ANTI_REJEU_SECONDES, FENETRE_SECONDES, verifier } from "./commun/signature.ts";

// SHA-256 de empreintes/gelees-1.0.0.sha256, recopié dans l'ADR 0033. Ne change qu'avec une v2 (ADR).
const SHA256_ARCHIVE_1_0_0 = "A_REMPLIR";

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
    expect(readdirSync(new URL("empreintes/", racine)).sort()).toEqual([...Object.keys(attendu).map((c) => `${c}.sha256`), "gelees-1.0.0.sha256"].sort());
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

  it("[C-538] gel 1.0.0 : commun, C1, C2, C3 et C6 en 1.x ; C4 et C5 restent en 0.x (ADR 0033)", () => {
    const v = lireVersions(racine.pathname);
    expect(CONTRATS_GELES).toEqual(["commun", "c1", "c2", "c3", "c6"]);
    for (const c of CONTRATS) expect(v[c], c).toMatch(CONTRATS_GELES.includes(c) ? /^1\.\d+\.\d+$/ : /^0\.\d+\.\d+$/);
  });

  it("[C-538] l'archive 1.0.0 contient les fixtures de chaque contrat gelé, et seulement eux", () => {
    expect(readdirSync(new URL("fixtures-gelees/1.0.0/", racine)).sort()).toEqual([...CONTRATS_GELES].sort());
    for (const c of CONTRATS_GELES) expect(readdirSync(new URL(`fixtures-gelees/1.0.0/${c}/`, racine)).length, c).toBeGreaterThan(0);
  });

  it("[LOT0-contrats] la version de chaque fichier généré est celle de VERSION", () => {
    const v = lireVersions(racine.pathname);
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

  it("[C-538] les fixtures archivées d'une version gelée restent valides, pour chaque contrat archivé (non-régression, README)", () => {
    const archives = new URL("fixtures-gelees/", racine);
    const versions = existsSync(archives) ? readdirSync(archives) : [];
    expect(versions.every((v) => /^\d+\.\d+\.\d+$/.test(v))).toBe(true);
    let vus = 0;
    for (const v of versions) {
      for (const c of readdirSync(new URL(`${v}/`, archives))) {
        const controle = CONTROLES_ARCHIVE[c];
        expect(controle, `${v}/${c} : aucun contrôle d'archive`).toBeDefined();
        for (const f of readdirSync(new URL(`${v}/${c}/`, archives))) {
          for (const [nom, ok] of controle?.(f, JSON.parse(readFileSync(new URL(`${v}/${c}/${f}`, archives), "utf8"))) ?? []) {
            expect(ok, `${v} ${c}/${f} ${nom}`).toBe(true);
            vus++;
          }
        }
      }
    }
    if (versions.length > 0) expect(vus).toBeGreaterThan(60);
  });

  it("[C-538] l'archive 1.0.0 ne change jamais : une empreinte par fichier archivé, scellée par une constante (ADR 0033) et par contrats.sha256", () => {
    const texte = calculerEmpreinteArchive(racine.pathname, "1.0.0");
    const fichiers = texte.trimEnd().split("\n").map((l) => l.slice(66));
    expect(fichiers.length).toBeGreaterThan(30);
    expect(fichiers).toEqual([...fichiers].sort());
    expect(fichiers.every((f) => f.startsWith("fixtures-gelees/1.0.0/"))).toBe(true);
    expect(lire("empreintes/gelees-1.0.0.sha256")).toBe(texte);
    expect(lire("contrats.sha256")).toMatch(/  empreintes\/gelees-1\.0\.0\.sha256\n/);
    expect(createHash("sha256").update(texte).digest("hex")).toBe(SHA256_ARCHIVE_1_0_0);
    expect(lire("../../docs/adr/0033-gel-des-contrats-en-1-0-0.md")).toContain(SHA256_ARCHIVE_1_0_0);
  });

  it("[C-538] les constantes de comportement de commun ne se rétrécissent pas : égalité pour la fenêtre, l'anti-rejeu, la TVA et le curseur ; jamais moins pour la période, Retry-After et le débit", () => {
    const k = JSON.parse(lire("fixtures/commun/constantes.json")) as Record<string, unknown> & { limitesDebit: Record<string, { parMinute: number }> };
    const ok = (archive: object) => CONTROLES_ARCHIVE.commun?.("constantes.json", archive).every(([, bon]) => bon);
    expect(ok(k)).toBe(true);
    expect(ok({ ...k, fenetreSecondes: FENETRE_SECONDES + 1 })).toBe(false);
    expect(ok({ ...k, fenetreSecondes: FENETRE_SECONDES - 1 })).toBe(false);
    expect(ok({ ...k, antiRejeuSecondes: ANTI_REJEU_SECONDES + 1 })).toBe(false);
    expect(ok({ ...k, tvaAutomatisationBps: TVA_AUTOMATISATION_BPS + 1 })).toBe(false);
    expect(ok({ ...k, curseurInitial: "1" })).toBe(false);
    expect(ok({ ...k, periodeMaxMois: PERIODE_MAX_MOIS + 1 })).toBe(false);
    expect(ok({ ...k, periodeMaxMois: PERIODE_MAX_MOIS - 1 })).toBe(true);
    expect(ok({ ...k, retryAfterMaxSecondes: RETRY_AFTER_MAX_SECONDES + 1 })).toBe(false);
    const c1 = k.limitesDebit.c1 as { parMinute: number };
    expect(ok({ ...k, limitesDebit: { ...k.limitesDebit, c1: { ...c1, parMinute: LIMITES_DEBIT.c1.parMinute + 1 } } })).toBe(false);
    expect(ok({ ...k, limitesDebit: { ...k.limitesDebit, c_retire: c1 } })).toBe(false);
  });

  it("[C-538] le contrôle d'archive refuse un exemple valide devenu invalide, dans chaque contrat gelé", () => {
    const casC1 = (JSON.parse(lire("fixtures/c1/devis.json")) as { cas: Cas[] }).cas.find((c) => c.valide) as Cas;
    const faux = { ...casC1, corps: JSON.stringify({ ...JSON.parse(casC1.corps), axiCli: undefined }) };
    expect(CONTROLES_ARCHIVE.c1?.("devis.json", { cas: [faux] }).every(([, ok]) => ok)).toBe(false);
    const casC3 = (JSON.parse(lire("fixtures/c3/plan.resume.json")) as { cas: Cas[] }).cas.find((c) => c.valide) as Cas;
    expect(CONTROLES_ARCHIVE.c3?.("plan.resume.json", { cas: [{ ...casC3, corps: "{}" }] }).every(([, ok]) => ok)).toBe(false);
    const jetons = JSON.parse(lire("fixtures/c6/jetons.json")) as { cas: { valide: boolean }[] };
    expect(CONTROLES_ARCHIVE.c6?.("jetons.json", { ...jetons, cas: jetons.cas.map((x) => ({ ...x, valide: true })) }).every(([, ok]) => ok)).toBe(false);
    const k = JSON.parse(lire("fixtures/commun/constantes.json")) as { codesErreur: Record<string, number> };
    expect(CONTROLES_ARCHIVE.commun?.("constantes.json", { ...k, codesErreur: { ...k.codesErreur, code_retire: 400 } }).every(([, ok]) => ok)).toBe(false);
  });
});

describe("documents du gel (mineurs du tour 2 de T0-30)", () => {
  const depot = new URL("../../", racine);
  const doc = (p: string) => readFileSync(new URL(p, depot), "utf8");

  it("[LOT0-contrats] php/README.md fait copier les fixtures et empreintes de commun avec celles de C3, et dit la même chose pour axion-ia", () => {
    const php = lire("php/README.md");
    for (const m of ["fixtures/c3/", "empreintes/c3.sha256", "fixtures/commun/", "empreintes/commun.sha256", "axion-ia", "fixtures/c1/", "fixtures/c2/", "fixtures/c6/"]) expect(php, m).toContain(m);
  });

  it("[LOT0-contrats] le README dit comment appliquer x-axion-regles (ajv et autre validateur)", () => {
    expect(lire("README.md")).toMatch(/addKeyword\(\{ keyword: "x-axion-regles"/);
    expect(lire("README.md")).toContain("autre validateur");
  });

  it("[LOT0-contrats] le CHANGELOG décrit GET /statuts et GET /faits chacun dans sa phrase, et porte l'entrée 1.0.0", () => {
    const journal = lire("CHANGELOG.md");
    const statuts = journal.split("\n").filter((l) => l.includes("GET /statuts"));
    expect(statuts.length).toBeGreaterThan(0);
    for (const l of statuts) expect(l).not.toMatch(/limite|GET \/faits/);
    expect(journal).toMatch(/^## .*1\.0\.0/m);
  });

  it("[LOT0-contrats] l'en-tête de l'ADR 0024 dit qu'il est accepté", () => {
    expect(doc("docs/adr/0024-reauthentification-requise-dans-les-contrats.md").split("\n")[2]).toMatch(/Statut : \*?\*?accepté/);
  });
});
