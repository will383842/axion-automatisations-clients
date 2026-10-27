import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { calculerEmpreintes } from "../../scripts/empreinte.ts";
import { ROUTES_C4, celluleDeLaCle, controlerLecture, controlerPaquet, emplacementCoffre } from "./cellule.ts";
import { Configuration, DUREE_CACHE_MAX_SECONDES } from "./configuration.ts";
import { EtatVoulu } from "./etat-voulu.ts";
import { Paquet } from "./evenements-executeur.ts";
import { deriverCleIntention } from "./intention.ts";

const lire = (p: string) => JSON.parse(readFileSync(new URL(`../../fixtures/c4/${p}`, import.meta.url), "utf8")) as { cas: { nom: string; valide: boolean; corps: unknown }[] };
interface Cellules {
  instances: Record<string, string>;
  paquets: { nom: string; valide: boolean; cle: string; corps: unknown }[];
  lectures: { nom: string; valide: boolean; cle: string; instanceId: string }[];
}
const cellules = JSON.parse(readFileSync(new URL("../../fixtures/c4/cellules.json", import.meta.url), "utf8")) as Cellules;
const celluleDe = (id: string) => cellules.instances[id] ?? null;

const debut = { type: "debut", instanceId: "inst-0001", executionId: "exec-0001", a: "2026-10-24T10:00:00Z" };
const fin = { type: "fin", instanceId: "inst-0001", executionId: "exec-0001", dureeMs: 1200, elements: 3, minutesGagnees: 15, jetons: 800, coutIaMicroCentimes: 4200 };
const vie = { type: "signal_de_vie", instanceId: "inst-0001", celluleId: "auto-run-1", a: "2026-10-24T10:00:30Z" };
const erreur = { type: "erreur", instanceId: "inst-0001", executionId: "exec-0001", classe: "passagere", code: "delai_depasse" };

describe("contrat C4 : échanges exécuteur ↔ console", () => {
  it("[A-344] un paquet mêlant debut, fin et signal_de_vie est valide", () => {
    expect(Paquet.safeParse({ evenements: [debut, vie, fin] }).success).toBe(true);
  });

  it("[LOT0-c4] un paquet vide est refusé", () => {
    expect(Paquet.safeParse({ evenements: [] }).success).toBe(false);
  });

  it("[LOT0-c4] un événement erreur avec un champ texte libre est refusé", () => {
    expect(Paquet.safeParse({ evenements: [erreur] }).success).toBe(true);
    expect(Paquet.safeParse({ evenements: [{ ...erreur, message: "Facture de Boulangerie Rivoire en échec" }] }).success).toBe(false);
    expect(Paquet.safeParse({ evenements: [{ ...erreur, code: "Texte libre avec espaces" }] }).success).toBe(false);
  });

  it("[LOT0-c4] un événement erreur avec une classe inconnue est refusé", () => {
    expect(Paquet.safeParse({ evenements: [{ ...erreur, classe: "autre" }] }).success).toBe(false);
  });

  it("[LOT0-c4] un coût IA flottant est refusé", () => {
    expect(Paquet.safeParse({ evenements: [{ ...fin, coutIaMicroCentimes: 4200.5 }] }).success).toBe(false);
    expect(Paquet.safeParse({ evenements: [{ ...fin, coutIaMicroCentimes: -1 }] }).success).toBe(false);
  });

  it("[LOT0-c4] la configuration d'une instance se garde 24 h au plus", () => {
    const base = { instanceId: "inst-0001", moduleCode: "accuse-reception", moduleVersion: "1.0.0", clientId: "cli-0001", automatisationId: "auto-0001", reglages: { actionsAutomatiquesAutorisees: [] }, dureeCacheSecondes: DUREE_CACHE_MAX_SECONDES };
    expect(DUREE_CACHE_MAX_SECONDES).toBe(86400);
    expect(Configuration.safeParse(base).success).toBe(true);
    expect(Configuration.safeParse({ ...base, dureeCacheSecondes: 86401 }).success).toBe(false);
  });

  it("[LOT0-c4] l'état voulu reste léger : un état et une version", () => {
    expect(EtatVoulu.safeParse({ instanceId: "inst-0001", etat: "pause", arretEnvois: false, version: 4 }).success).toBe(true);
    expect(EtatVoulu.safeParse({ instanceId: "inst-0001", etat: "inconnu", arretEnvois: false, version: 4 }).success).toBe(false);
    expect(EtatVoulu.safeParse({ instanceId: "inst-0001", etat: "actif", arretEnvois: false, version: 4, reglages: {} }).success).toBe(false);
  });

  it("[LOT0-c4] les fixtures de paquets sont conformes", () => {
    for (const c of lire("paquets.json").cas) expect(Paquet.safeParse(c.corps).success, c.nom).toBe(c.valide);
  });

  it("[LOT4-c4] un état voulu sans arretEnvois est refusé", () => {
    expect(EtatVoulu.safeParse({ instanceId: "inst-0001", etat: "actif", version: 4 }).success).toBe(false);
    expect(EtatVoulu.safeParse({ instanceId: "inst-0001", etat: "actif", arretEnvois: "oui", version: 4 }).success).toBe(false);
    expect(EtatVoulu.safeParse({ instanceId: "inst-0001", etat: "actif", arretEnvois: true, version: 4 }).success).toBe(true);
  });

  it("[LOT4-c4] un événement a_trancher avec un champ texte est refusé", () => {
    const aTrancher = { type: "a_trancher", instanceId: "inst-0001", executionId: "exec-0001", etape: "accuser", code: "effet_incertain" };
    expect(Paquet.safeParse({ evenements: [aTrancher] }).success).toBe(true);
    expect(Paquet.safeParse({ evenements: [{ ...aTrancher, message: "Envoi à vérifier chez Garage Fontaine" }] }).success).toBe(false);
    expect(Paquet.safeParse({ evenements: [{ ...aTrancher, code: "Texte libre avec espaces" }] }).success).toBe(false);
  });

  it("[LOT4-c4] le signal de vie nomme sa cellule et l'instance porte ses étiquettes", () => {
    expect(Paquet.safeParse({ evenements: [{ ...vie, celluleId: undefined }] }).success).toBe(false);
    const base = { instanceId: "inst-0001", moduleCode: "accuse-reception", moduleVersion: "1.0.0", reglages: {}, dureeCacheSecondes: 60 };
    expect(Configuration.safeParse(base).success).toBe(false);
    expect(Configuration.safeParse({ ...base, clientId: "cli-0001" }).success).toBe(false);
  });

  it("[LOT4-c4] la clé d'intention est la même pour la même entrée, différente si l'élément change (1 000 tirages)", () => {
    const e = { instanceId: "inst-0001", executionId: "exec-0001", etape: "accuser", action: "envoyer" };
    expect(deriverCleIntention({ ...e, element: "msg-1" })).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const vues = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const cle = deriverCleIntention({ ...e, element: `msg-${i}` });
      expect(deriverCleIntention({ ...e, element: `msg-${i}` })).toBe(cle);
      vues.add(cle);
    }
    expect(vues.size).toBe(1000);
  });

  it("[LOT4-c4] la clé d'intention change si l'action, l'étape, l'exécution ou l'instance change", () => {
    const e = { instanceId: "inst-0001", executionId: "exec-0001", etape: "accuser", action: "envoyer", element: "msg-1" };
    const cles = [e, { ...e, action: "classer" }, { ...e, etape: "relancer" }, { ...e, executionId: "exec-0002" }, { ...e, instanceId: "inst-0002" }].map(deriverCleIntention);
    expect(new Set(cles).size).toBe(cles.length);
    // Le séparateur ne crée aucune ambiguïté : ("a","b|c") et ("a|b","c") donnent deux clés.
    expect(deriverCleIntention({ ...e, etape: "a", element: "b|c" })).not.toBe(deriverCleIntention({ ...e, etape: "a|b", element: "c" }));
  });

  it("[LOT4-c4] l'empreinte des fixtures change et le test de contrat le voit", () => {
    const racine = new URL("../../", import.meta.url).pathname;
    const copie = mkdtempSync(`${tmpdir()}/c4-empreinte-`);
    try {
      for (const d of ["fixtures", "src/c1", "src/c2"]) cpSync(`${racine}${d}`, `${copie}/${d}`, { recursive: true });
      const publiee = readFileSync(`${racine}empreintes/c4.sha256`, "utf8");
      expect(calculerEmpreintes(copie).c4).toBe(publiee);
      writeFileSync(`${copie}/fixtures/c4/paquets.json`, `${readFileSync(`${copie}/fixtures/c4/paquets.json`, "utf8")} `);
      expect(calculerEmpreintes(copie).c4).not.toBe(publiee);
    } finally {
      rmSync(copie, { recursive: true, force: true });
    }
  });

  it("[C-536] la console refuse en 403 toute instance d'une autre cellule que celle de la clé ; un paquet mixte est refusé en entier", () => {
    expect(cellules.paquets.some((c) => !c.valide) && cellules.lectures.some((c) => !c.valide)).toBe(true);
    for (const c of cellules.paquets) {
      const paquet = Paquet.parse(c.corps);
      expect(controlerPaquet(c.cle, paquet, celluleDe).ok, c.nom).toBe(c.valide);
      if (!c.valide) expect(controlerPaquet(c.cle, paquet, celluleDe)).toEqual({ ok: false, code: "action_interdite", statut: 403 });
    }
    for (const c of cellules.lectures) expect(controlerLecture(c.cle, c.instanceId, celluleDe).ok, c.nom).toBe(c.valide);
  });

  it("[C-536] une seule forme de cellule, celle du coffre : minuscules, chiffres et tirets ; X-Axion-Cle c4:<cellule>:<kid> ↔ technique/echanges/c4-<cellule>/<kid>", () => {
    expect(emplacementCoffre("c4:auto-run-1:a")).toEqual({ canal: "c4-auto-run-1", kid: "a" });
    expect(emplacementCoffre("c4:auto-run-1:cle-2")).toEqual({ canal: "c4-auto-run-1", kid: "cle-2" });
    for (const cle of ["c4:Auto_Run:a", "c4:auto_run:a", "c4:auto-run-1:A", "c4:-auto:a", "c4:auto-:a", "c4:auto-run-1:a_b", `c4:${"a".repeat(65)}:a`]) {
      expect(celluleDeLaCle(cle), cle).toBeNull();
      expect(emplacementCoffre(cle), cle).toBeNull();
    }
    // Même motif que le coffre (apps/api/src/coffre/cles-echanges.ts : CANAL et KID).
    const CANAL = /^c4-[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const KID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    for (const c of [...cellules.paquets, ...cellules.lectures].map((x) => x.cle).filter((x) => x.startsWith("c4:"))) {
      const e = emplacementCoffre(c);
      expect(e && CANAL.test(e.canal) && KID.test(e.kid), c).toBe(true);
    }
  });

  it("[LOT0-c4] la cellule se lit dans l'identifiant de clé c4:<cellule>:<n>, sans ambiguïté", () => {
    expect(celluleDeLaCle("c4:auto-run-1:a")).toBe("auto-run-1");
    for (const cle of ["c4:auto-run-1", "c4::a", "c1:auto-run-1:a", "c4:auto:run:a"]) expect(celluleDeLaCle(cle), cle).toBeNull();
    expect(Object.values(ROUTES_C4).map((r) => r.chemin)).toEqual([
      "/api/executeur/v1/instances/{instanceId}/configuration",
      "/api/executeur/v1/instances/{instanceId}/etat-voulu",
      "/api/executeur/v1/evenements",
    ]);
  });
});
