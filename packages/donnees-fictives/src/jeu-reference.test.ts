import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLAGES_TELEPHONE_FICTION } from "../../../scripts/scanner-journaux.js";
import { genererJeuReference } from "./jeu-reference.js";

const jeu = genererJeuReference(42);
const texte = JSON.stringify(jeu);

describe("jeu de référence", () => {
  it("[C-532] même graine → même jeu de référence", () => {
    expect(JSON.stringify(genererJeuReference(42))).toBe(texte);
    expect(JSON.stringify(genererJeuReference(43))).not.toBe(texte);
  });
  it("[C-532] tous les e-mails du jeu sont @exemple.fr ou .test et tous les téléphones sont dans les plages de fiction", () => {
    const courriels = [...texte.matchAll(/[\w.+-]+@([\w.-]+)/g)];
    expect(courriels.length).toBeGreaterThan(20);
    for (const m of courriels) expect(/^exemple\.fr$|\.test$/.test(m[1] ?? "")).toBe(true);
    const telephones: string[] = [];
    const parcourir = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(parcourir);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (k === "telephone") telephones.push(String(x));
          else parcourir(x);
        }
      }
    };
    parcourir(JSON.parse(texte));
    expect(telephones.length).toBeGreaterThan(20);
    for (const t of telephones) expect(t).toMatch(/^0\d{9}$/);
    for (const t of telephones) expect(PLAGES_TELEPHONE_FICTION.some((p) => t.startsWith(p))).toBe(true);
  });
  it("[C-532] la structure du jeu respecte les effectifs du plan", () => {
    expect(jeu.entreprises).toHaveLength(20);
    expect(jeu.particuliers).toHaveLength(3);
    expect(jeu.entreprises.some((e) => e.siren === undefined)).toBe(true);
    expect(jeu.entreprises.some((e) => e.siren !== undefined)).toBe(true);
    expect(jeu.entreprises.filter((e) => e.doublonDe !== undefined).length).toBeGreaterThanOrEqual(1);
    expect(jeu.entreprises.filter((e) => e.fusionneeDans !== undefined)).toHaveLength(1);
    for (const formule of ["abonnement-mensuel", "6-mois", "12-mois"] as const) {
      expect(jeu.clients.filter((c) => c.formule === formule)).toHaveLength(5);
    }
    expect(new Set(jeu.factures.map((f) => f.statut))).toEqual(new Set(["payee", "en-retard", "impayee"]));
    for (const f of jeu.factures) expect(Number.isInteger(f.montantCentimes)).toBe(true);
  });
  it("[C-532] le jeu de référence contient chacun des 7 pièges listés", () => {
    const p = jeu.pieges;
    const hub = jeu.entreprises.find((e) => e.id === p.ficheHubSansSiren);
    expect(hub?.source).toBe("hub");
    expect(hub?.siren).toBeUndefined();
    const absorbee = jeu.entreprises.find((e) => e.id === p.ficheAbsorbeeAvecIdentifiantConsole);
    expect(absorbee?.fusionneeDans).toBeDefined();
    expect(absorbee?.identifiantConsole).toBeDefined();
    const partage = jeu.particuliers.find((x) => x.id === p.particulierEmailPartage);
    const autres = [...jeu.particuliers.filter((x) => x.id !== partage?.id), ...jeu.entreprises.flatMap((e) => e.contacts)];
    expect(autres.some((x) => x.email === partage?.email)).toBe(true);
    expect(jeu.plans.filter((x) => x.clientId === p.planEnDouble && x.statut === "actif").length).toBeGreaterThanOrEqual(2);
    const parti = jeu.clients.find((c) => c.id === p.planActifClientParti);
    expect(parti?.statut).toBe("parti");
    expect(jeu.plans.some((x) => x.clientId === parti?.id && x.statut === "actif")).toBe(true);
    expect(jeu.taches.filter((t) => t.cle === p.tacheGenerationDeuxFois)).toHaveLength(2);
    const [a, b] = p.deuxClientsContactsMemeNom.map((id) => jeu.clients.find((c) => c.id === id));
    const contacts = (c?: (typeof jeu.clients)[number]) => jeu.entreprises.find((e) => e.id === c?.entrepriseId)?.contacts ?? [];
    expect(a?.id).not.toBe(b?.id);
    const noms = (c?: (typeof jeu.clients)[number]) => contacts(c).map((x) => `${x.prenom} ${x.nom}`);
    expect(noms(a).some((n) => noms(b).includes(n))).toBe(true);
  });
  it("[LOT1-fictif] aucun nom-sentinelle des tests de T0-10 n'est produit par le générateur", () => {
    const source = readFileSync(fileURLToPath(new URL("../../../scripts/garde-noms/chercher.test.ts", import.meta.url)), "utf8");
    const sentinelle = /const NOM = "([^"]+)"/.exec(source)?.[1];
    expect(sentinelle).toBeDefined();
    const mots = (sentinelle ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").split(/\s+/);
    for (const graine of [1, 2, 42, 99, 1234]) {
      const brut = JSON.stringify(genererJeuReference(graine)).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
      for (const mot of mots) expect(brut.includes(mot)).toBe(false);
    }
  });
});
