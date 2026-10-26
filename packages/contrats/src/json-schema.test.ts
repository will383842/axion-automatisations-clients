import { readdirSync, readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { PREFIXE_C1, ROUTES_C1 } from "./c1/routes.ts";
import { Fait } from "./c2/faits.ts";
import { EvenementConsole } from "./c3/evenements-console-vers-crm.ts";
import { EvenementCrm } from "./c3/evenements-crm-vers-console.ts";
import { LectureRequete } from "./c3/lecture-entreprise.ts";
import { Paquet } from "./c4/evenements-executeur.ts";
import { REGLES_FOND, type RegleFond } from "./commun/regles-fond.ts";

// Les JSON Schema COMMITÉS (ce que lisent axion-ia et le CRM) et les schémas Zod (la console) doivent rendre
// le même verdict sur chaque fixture. Les règles de fond nommées par `x-axion-regles` sont branchées dans ajv.
const racine = new URL("../", import.meta.url);
const lire = (p: string) => JSON.parse(readFileSync(new URL(p, racine), "utf8")) as Record<string, unknown>;

const ajv = new Ajv2020({ strict: true, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
ajv.addKeyword({
  keyword: "x-axion-regles",
  schemaType: "array",
  validate: (noms: RegleFond[], donnee: unknown) => noms.every((n) => REGLES_FOND[n](donnee)),
});
const compile = (schema: unknown) => ajv.compile(schema as object);

type Cas = { nom: string; valide: boolean; methode: string; chemin: string; corps: string };
const fixtures = (dossier: string) =>
  readdirSync(new URL(`fixtures/${dossier}/`, racine))
    .filter((f) => f.endsWith(".json") && !["json-schema.json", "siren-generes.json", "cellules.json", "lecture-entreprise.json", "paquets.json"].includes(f))
    .map((f) => ({ f, ...(lire(`fixtures/${dossier}/${f}`) as { cas: Cas[]; reponses?: { statut: number; nom: string; corps: unknown }[] }) }));
const donnees = (c: Cas) => (c.corps !== "" ? JSON.parse(c.corps) : Object.fromEntries(new URLSearchParams(c.chemin.split("?")[1] ?? "")));
const memeVerdict = (zod: ZodType, schema: unknown, valeur: unknown, nom: string) => {
  const v = compile(schema);
  expect(v(valeur), `${nom} : ${JSON.stringify(v.errors)}`).toBe(zod.safeParse(valeur).success);
};

describe("JSON Schema commités ≡ schémas Zod", () => {
  it("[LOT0-contrats] C1 : requêtes et réponses, même verdict des deux côtés", () => {
    const { routes } = lire("fixtures/c1/json-schema.json") as { routes: Record<string, { requete?: unknown; reponses: Record<string, unknown> }> };
    let vus = 0;
    for (const { f, cas, reponses = [] } of fixtures("c1")) {
      const nom = f.replace(".json", "") as keyof typeof ROUTES_C1;
      const route = ROUTES_C1[nom];
      const exporte = routes[nom];
      if (!exporte) throw new Error(nom);
      if ("requete" in route && exporte.requete) {
        for (const c of cas.filter((x) => x.chemin.startsWith(PREFIXE_C1))) {
          memeVerdict(route.requete, exporte.requete, donnees(c), `${f} / ${c.nom}`);
          vus++;
        }
      }
      for (const r of reponses) {
        const zod = (route.reponses as Record<number, ZodType>)[r.statut];
        if (!zod) continue;
        memeVerdict(zod, exporte.reponses[String(r.statut)], r.corps, `${f} / ${r.nom}`);
        vus++;
      }
    }
    expect(vus).toBeGreaterThan(30);
  });

  it("[C-589] C2 : une facture d'abonnement sans période est refusée aussi par le JSON Schema", () => {
    const { fait } = lire("fixtures/c2/json-schema.json");
    for (const { f, cas } of fixtures("c2")) for (const c of cas) memeVerdict(Fait, fait, donnees(c), `${f} / ${c.nom}`);
    const v = compile(fait);
    const facture = fixtures("c2").find((x) => x.f === "facture.emise.json")?.cas.find((c) => c.nom === "abonnement sans debutPeriode");
    expect(facture && v(JSON.parse(facture.corps))).toBe(false);
  });

  it("[LOT0-contrats] C3 : événements des deux sens et lecture, même verdict ; SIREN refusé par Luhn des deux côtés", () => {
    const { c3 } = lire("fixtures/c3/json-schema.json") as { c3: Record<string, unknown> };
    for (const { f, cas } of fixtures("c3")) {
      for (const c of cas) {
        const v = donnees(c) as { producer?: string };
        if (v.producer === "axion-crm") memeVerdict(EvenementCrm, c3.crmVersConsole, v, `${f} / ${c.nom}`);
        else memeVerdict(EvenementConsole, c3.consoleVersCrm, v, `${f} / ${c.nom}`);
      }
    }
    for (const siren of ["812345676", "123456789", "81234567"]) memeVerdict(LectureRequete, c3.lectureRequete, { siren }, siren);
  });

  it("[LOT0-contrats] C4 : paquets, même verdict des deux côtés", () => {
    const { paquet } = lire("fixtures/c4/json-schema.json");
    const { cas } = lire("fixtures/c4/paquets.json") as { cas: { nom: string; corps: unknown }[] };
    for (const c of cas) memeVerdict(Paquet, paquet, c.corps, c.nom);
  });
});
