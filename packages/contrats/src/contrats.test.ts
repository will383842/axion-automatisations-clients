import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculerEmpreinte } from "../scripts/empreinte.js";
import { schemasJson } from "../scripts/signer-fixtures.js";
import { Fait } from "./c2/faits.js";
import { ROUTES_C1 } from "./c1/routes.js";
import { verifier } from "./commun/signature.js";

const racine = new URL("../", import.meta.url);
const lire = (p: string) => readFileSync(new URL(p, racine), "utf8");

interface Cas { nom: string; valide: boolean; horodatage: string; methode: string; chemin: string; corps: string; signature: string; secret: string }
const cas = (dossier: string) =>
  readdirSync(new URL(`fixtures/${dossier}/`, racine))
    .filter((f) => f.endsWith(".json") && f !== "json-schema.json")
    .map((f) => ({ f, ...(JSON.parse(lire(`fixtures/${dossier}/${f}`)) as { cas: Cas[] }) }));

describe("fixtures signées", () => {
  it("[LOT0-contrats] contrats.sha256 correspond aux fichiers", () => {
    expect(lire("contrats.sha256")).toBe(calculerEmpreinte(racine.pathname));
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
      const route = ROUTES_C1[f.replace(".json", "") as keyof typeof ROUTES_C1];
      expect(liste.some((c) => c.valide) && liste.some((c) => !c.valide)).toBe(true);
      for (const c of liste) {
        expect(c.secret.startsWith("TEST-NE-PAS-UTILISER-")).toBe(true);
        expect(verifier(c.secret, c.horodatage, c.methode, c.chemin, Buffer.from(c.corps), c.signature, Number(c.horodatage))).toEqual({ ok: true });
        if (route.requete && c.corps !== "") {
          expect(route.requete.safeParse(JSON.parse(c.corps)).success, `${f} / ${c.nom}`).toBe(c.valide);
        }
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
