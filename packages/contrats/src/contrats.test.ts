import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculerEmpreintes } from "../scripts/empreinte.ts";
import { schemasJson } from "../scripts/signer-fixtures.ts";
import { Fait } from "./c2/faits.ts";
import { PREFIXE_C1, ROUTES_C1, type RouteC1 } from "./c1/routes.ts";
import { verifier } from "./commun/signature.ts";

const racine = new URL("../", import.meta.url);
const lire = (p: string) => readFileSync(new URL(p, racine), "utf8");

interface Cas { nom: string; valide: boolean; horodatage: string; methode: string; chemin: string; corps: string; signature: string; secret: string }
const cas = (dossier: string) =>
  readdirSync(new URL(`fixtures/${dossier}/`, racine))
    .filter((f) => f.endsWith(".json") && f !== "json-schema.json")
    .map((f) => ({ f, ...(JSON.parse(lire(`fixtures/${dossier}/${f}`)) as { cas: Cas[] }) }));

describe("fixtures signées", () => {
  it("[C-538] une empreinte par contrat, chaque fichier d'empreintes correspond aux fichiers de son contrat", () => {
    const attendu = calculerEmpreintes(racine.pathname);
    expect(Object.keys(attendu)).toEqual(["c1", "c2", "c3", "c4", "c6"]);
    expect(readdirSync(new URL("empreintes/", racine)).sort()).toEqual(Object.keys(attendu).map((c) => `${c}.sha256`));
    for (const [c, texte] of Object.entries(attendu)) expect(lire(`empreintes/${c}.sha256`), c).toBe(texte);
  });
  it("[C-538] l'empreinte d'un contrat ne contient que ses fichiers, et l'ancien fichier agrégé a disparu", () => {
    for (const [c, texte] of Object.entries(calculerEmpreintes(racine.pathname))) {
      for (const l of texte.trim().split("\n")) expect(l, c).toMatch(new RegExp(`  (fixtures|src)/${c}/`));
    }
    expect(() => lire("contrats.sha256")).toThrow();
  });

  it("[LOT0-contrats] les JSON Schema commités sont à jour", () => {
    const s = schemasJson();
    expect(JSON.parse(lire("fixtures/c1/json-schema.json"))).toEqual(s.c1);
    expect(JSON.parse(lire("fixtures/c2/json-schema.json"))).toEqual(s.c2);
  });

  it("[LOT0-c1] chaque route a un exemple valide et un invalide, signés avec la clé de test", () => {
    const fichiers = cas("c1");
    expect(fichiers.map((x) => x.f.replace(".json", "")).sort()).toEqual(Object.keys(ROUTES_C1).sort());
    for (const { f, cas: liste } of fichiers) {
      const route: RouteC1 = ROUTES_C1[f.replace(".json", "") as keyof typeof ROUTES_C1];
      expect(liste.some((c) => c.valide) && liste.some((c) => !c.valide)).toBe(true);
      for (const c of liste) {
        expect(c.secret.startsWith("TEST-NE-PAS-UTILISER-")).toBe(true);
        expect(verifier(c.secret, c.horodatage, c.methode, c.chemin, Buffer.from(c.corps), c.signature, Number(c.horodatage))).toEqual({ ok: true });
        const [chemin, requete = ""] = c.chemin.slice(PREFIXE_C1.length).split("?");
        const modele = new RegExp(`^${route.chemin.replace(/\{[^}]+\}/g, "[^/]+")}$`);
        const donnees = c.corps !== "" ? JSON.parse(c.corps) : Object.fromEntries(new URLSearchParams(requete));
        const conforme = modele.test(chemin ?? "") && (!route.requete || route.requete.safeParse(donnees).success);
        expect(conforme, `${f} / ${c.nom}`).toBe(c.valide);
      }
    }
  });

  it("[LOT0-c2] chaque fait a un exemple valide et un invalide, signés avec la clé de test", () => {
    const fichiers = cas("c2");
    expect(fichiers).toHaveLength(10);
    for (const { f, cas: liste } of fichiers) {
      expect(liste.some((c) => c.valide) && liste.some((c) => !c.valide)).toBe(true);
      for (const c of liste) {
        expect(verifier(c.secret, c.horodatage, c.methode, c.chemin, Buffer.from(c.corps), c.signature, Number(c.horodatage))).toEqual({ ok: true });
        const r = Fait.safeParse(JSON.parse(c.corps));
        expect(r.success, `${f} / ${c.nom}`).toBe(c.valide);
        if (c.valide && r.success) expect(r.data.event_type).toBe(f.replace(".json", ""));
      }
    }
  });
});
