import { describe, expect, it } from "vitest";
import { ROUTES_C1 } from "../c1/routes.ts";
import { ROUTE_C2 } from "../c2/enveloppe.ts";
import { ROUTES_C3 } from "../c3/lecture-entreprise.ts";
import { ROUTES_C4 } from "../c4/cellule.ts";
import { ROUTE_C6 } from "../c6/jeton.ts";
import { BpsPourcentage, Centimes } from "./argent.ts";
import { LIMITES_DEBIT, entetesDebitDepasse } from "./debit.ts";
import { ErreurSchema, STATUT_PAR_CODE } from "./erreurs.ts";
import { Adresse, Siren } from "./identifiants.ts";
import type { RouteContrat } from "./routes.ts";

const TOUTES: [string, RouteContrat][] = [
  ...Object.entries(ROUTES_C1).map(([n, r]) => [`c1 ${n}`, r] as [string, RouteContrat]),
  ["c2 faits", ROUTE_C2],
  ...Object.entries(ROUTES_C3).map(([n, r]) => [`c3 ${n}`, r] as [string, RouteContrat]),
  ...Object.entries(ROUTES_C4).map(([n, r]) => [`c4 ${n}`, r] as [string, RouteContrat]),
  ["c6 entree", ROUTE_C6],
];

describe("contrats : règles communes", () => {
  it("[LOT0-commun] chaque route de C1 à C6 a sa limite de débit, et chaque limite sert", () => {
    for (const [nom, r] of TOUTES) expect(LIMITES_DEBIT, nom).toHaveProperty(r.limite);
    expect(new Set(TOUTES.map(([, r]) => r.limite))).toEqual(new Set(Object.keys(LIMITES_DEBIT)));
    expect(LIMITES_DEBIT.c1).toEqual({ parMinute: 60, alerteRefusParMinute: 10, par: "cle" });
  });

  it("[LOT0-commun] 429 debit_depasse porte toujours Retry-After en secondes entières de 1 à 60", () => {
    expect(STATUT_PAR_CODE.debit_depasse).toBe(429);
    expect(entetesDebitDepasse(30)).toEqual({ "Retry-After": "30" });
    for (const s of [0, 61, 1.5, -1]) expect(() => entetesDebitDepasse(s)).toThrow();
  });

  it("[LOT0-commun] anti-doublon : Idempotency-Key sur chaque écriture de C1, event_id pour les faits et événements poussés", () => {
    for (const [nom, r] of TOUTES) {
      if (r.methode === "GET") expect(r.antiDoublon, nom).toMatch(/^(lecture|jti)$/);
      else if (nom.startsWith("c1 ")) expect(r.antiDoublon, nom).toBe("idempotency_key");
      else if (nom.startsWith("c2 ") || nom.startsWith("c3 ")) expect(r.antiDoublon, nom).toBe("event_id");
      else expect(r.antiDoublon, nom).toBe("execution");
    }
  });

  it("[LOT0-commun] un seul SIREN (Luhn) et une seule adresse (avec ligne2) pour C1, C2 et C3", () => {
    expect(Siren.safeParse("812345676").success).toBe(true);
    expect(Siren.safeParse("123456789").success).toBe(false);
    const adresse = { ligne1: "1 rue d'essai", ligne2: "Bâtiment B", codePostal: "75001", ville: "Ville-Test", pays: "FR" };
    expect(Adresse.parse(adresse)).toEqual(adresse);
    expect(Adresse.safeParse({ ...adresse, etage: "2" }).success).toBe(false);
  });

  it("[LOT0-commun] montants et taux jamais négatifs ; acompte de 0 à 10 000 points de base", () => {
    expect(Centimes.safeParse(0).success).toBe(true);
    expect(Centimes.safeParse(-1).success).toBe(false);
    expect(BpsPourcentage.safeParse(10000).success).toBe(true);
    expect(BpsPourcentage.safeParse(10001).success).toBe(false);
  });

  it("[LOT0-commun] reauthentification_requise est un code du contrat (401) ; motif facultatif et fermé", () => {
    expect(STATUT_PAR_CODE.reauthentification_requise).toBe(401);
    const e = { erreur: { code: "regle_metier", message: "Refusé.", id_trace: "trace-0001" } };
    expect(ErreurSchema.safeParse(e).success).toBe(true);
    expect(ErreurSchema.safeParse({ erreur: { ...e.erreur, motif: "fonction_non_permise" } }).success).toBe(true);
    expect(ErreurSchema.safeParse({ erreur: { ...e.erreur, motif: "Texte libre" } }).success).toBe(false);
  });
});
