import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { construireModele, migrerBase } from "./migrer-base.ts";
import { deroulerPlan, planifierVagues, type BaseRegistre, type PortsVagues } from "./vagues.ts";
import { journalEchecs } from "../provisionnement/journal-echecs.js";
// Journal des échecs (CI) : le rapport JSON n'est pas publié ; la cause de chaque test rouge s'imprime ici, adresses de connexion masquées.
journalEchecs(import.meta.url);

// T2-38 : 100 bases fictives créées par CREATE DATABASE … TEMPLATE, EN SÉRIE, depuis un modèle jetable ; une migration additive v2 d'essai (copie du dossier, jamais le vrai) les passe toutes par les vagues.
// Grappe jetable (T232_PG_ADMIN_URL) ; sans elle, ces essais ne tournent pas (même dette que migrer-base.int.test.ts). Aucune donnée de client : tout vit dans le conteneur de la CI.
const ADMIN = process.env["T232_PG_ADMIN_URL"];
const DOSSIER = fileURLToPath(new URL("../../drizzle-cli", import.meta.url));
const vers = (base: string) => { const u = new URL(ADMIN ?? "postgres://x@localhost/postgres"); u.pathname = `/${base}`; return u.toString(); };
const N = 9000 + Math.floor(Math.random() * 900);
const admin = new pg.Pool({ connectionString: ADMIN, max: 2 });
admin.on("error", () => undefined);
const noms: string[] = [];

describe.skipIf(!ADMIN)("vagues sur 100 bases fictives (grappe jetable)", () => { // fiche: T2-38
  let dossierV2 = "";
  const registre: BaseRegistre[] = [];
  beforeAll(async () => {
    await construireModele(N, { url: vers("postgres") });
    dossierV2 = mkdtempSync(join(tmpdir(), "cli-v2-"));
    cpSync(DOSSIER, dossierV2, { recursive: true });
    const journal = JSON.parse(readFileSync(join(dossierV2, "meta/_journal.json"), "utf8"));
    journal.entries.push({ idx: 1, version: "7", when: journal.entries[0].when + 1000, tag: "0001_essai_vagues", breakpoints: true });
    writeFileSync(join(dossierV2, "meta/_journal.json"), JSON.stringify(journal));
    writeFileSync(join(dossierV2, "0001_essai_vagues.sql"), 'ALTER TABLE "commun"."etablissements" ADD COLUMN "note_vagues" text;');
    for (let i = 0; i < 100; i++) {
      const base = `cli_${randomBytes(6).toString("hex")}`;
      for (const r of ["proprietaire", "app", "lecture"]) await admin.query(`CREATE ROLE "${base}_${r}" NOLOGIN`);
      await admin.query(`CREATE DATABASE "${base}" TEMPLATE "modele_v${N}" OWNER "${base}_proprietaire"`);
      noms.push(base);
      const c = new pg.Client({ connectionString: vers(base) });
      await c.connect();
      try { await c.query(`REASSIGN OWNED BY modele_proprietaire TO "${base}_proprietaire"`); } finally { await c.end(); }
      registre.push({ id: `id${i}`, tenantId: `t${i}`, nomBase: base, versionStructure: 1, etat: "active" });
    }
  }, 600_000);
  afterAll(async () => { await admin.end().catch(() => undefined); });

  it("[C-476] une migration canari réussit sur 100 bases", async () => {
    const journal: string[] = [];
    const ports: PortsVagues = {
      async bases() { return registre.map((b) => ({ ...b })); },
      async graine() { return undefined; },
      async enregistrerGraine() {},
      tirerGraine: () => 476,
      async migrer(nomBase, cible) { await migrerBase(nomBase, cible, { url: vers(nomBase), dossier: dossierV2 }); },
      async noter(baseId, version, resultat) { journal.push(`${resultat}`); if (resultat === "ok") registre.find((b) => b.id === baseId)!.versionStructure = version; },
      async alerter() { throw new Error("aucune alerte attendue"); },
    };
    const plan = await planifierVagues(2, { recette: [noms[0]!], internes: [noms[1]!, noms[2]!] }, ports);
    expect(plan.vagues.find((v) => v.nom === "canari")?.bases).toHaveLength(5);
    const r = await deroulerPlan(plan, ports);
    expect(r.arretee).toBe(false);
    expect(r.vagues.flatMap((v) => v.echecs)).toEqual([]);
    expect(journal.filter((x) => x === "ok")).toHaveLength(100);
    // Relu dans les bases elles-mêmes, pas seulement dans le registre.
    for (const base of [noms[0]!, noms[50]!, noms[99]!]) {
      const c = new pg.Client({ connectionString: vers(base) });
      await c.connect();
      try {
        expect((await c.query("SELECT max(version)::int AS v FROM public.version_structure")).rows[0]?.v).toBe(2);
        expect((await c.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'etablissements' AND column_name = 'note_vagues'")).rowCount).toBe(1);
      } finally { await c.end(); }
    }
  }, 600_000);

  it("[A-232] en production, migrerBase refuse une cible plus basse sur une base réelle déjà en version 2", async () => {
    const avant = process.env["NODE_ENV"];
    try {
      process.env["NODE_ENV"] = "production";
      await expect(migrerBase(noms[3]!, 1, { url: vers(noms[3]!), dossier: dossierV2 })).rejects.toThrow(/descendante/);
    } finally {
      if (avant === undefined) delete process.env["NODE_ENV"]; else process.env["NODE_ENV"] = avant;
    }
  }, 60_000);
});
