import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { analyserModele } from "@axion-auto/donnees-module";
import { PlacesMemoire } from "../files/semaphore.ts";
import type { BaseLecture } from "../courtier/client.ts";
import { creerFileParPlaces, creerFileValkey, type FileLecture } from "./file-lecture.ts";
import { creerFabriquePort, type PortsLecture } from "./port.ts";

// Données générées : aucun vrai client, aucun secret réel.
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const INST = "33333333-3333-4333-8333-333333333333";
const COR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ETAB = "44444444-4444-4444-8444-444444444444";
const MODELE = analyserModele('CREATE TABLE "commun"."factures_essai" (\n  "id" uuid PRIMARY KEY,\n  "etablissement_id" uuid NOT NULL,\n  "libelle" text\n);');
const LIMITES = { delaiMs: 300, delaiTotalMs: 60_000, maxLignes: 2, hotes: ["pgbouncer-donnees.test"] };
const BAIL = 60_000 + 2 * 300 + 5000;
const DONNEES = { requetes: [{ nom: "liste-factures", mode: "lecture", parametres: {}, forme: { type: "simple", table: "commun.factures_essai", sortie: { lignes: [{ colonne: "libelle" }] }, limite: { fixe: 10 } } }], actions: [] };
const nomBase = (t: string): string => `cli_${t.replaceAll("-", "").slice(0, 12)}`;

afterEach(() => { vi.useRealTimers(); });

// Ports simulés ; `actives` compte les sessions ouvertes en même temps (partagé entre « processus »).
function ports(compteur: { actives: number; max: number; ouvertures: number }): PortsLecture {
  return {
    instance: async () => ({ empreinte: "sha256:aaaa", installee: true, ecart: false, impaye: false, etat: "actif", donnees: DONNEES }),
    baseLecture: async (t) => ({ hote: "pgbouncer-donnees.test", base: nomBase(t), role: `${nomBase(t)}_lecture`, motDePasse: "mdp-d-essai", expire: new Date("2030-01-01"), valideJusqua: null }) satisfies BaseLecture,
    ouvrir: async (b) => {
      compteur.actives += 1; compteur.ouvertures += 1; compteur.max = Math.max(compteur.max, compteur.actives);
      return {
        query: async (texte) => {
          await new Promise((ok) => setTimeout(ok, 5));
          if (texte === "SAVEPOINT axion_sonde") throw Object.assign(new Error("x"), { code: "25P01" });
          if (texte.startsWith("SELECT current_setting")) return { rows: [{ ro: "on" }] };
          if (texte.includes("current_user")) return { rows: [{ u: b.role, d: b.base, id: ETAB }] };
          return { rows: [{ libelle: "un" }] };
        },
        liberer: () => { compteur.actives -= 1; },
      };
    },
    tracer: () => undefined,
  };
}
const ctx = (t = A) => ({ tenantId: t, instanceId: INST, idTache: "tache-1", correlation: COR });

describe("file de lecture partagée entre processus", () => {
  it("[A-170] Valkey injoignable : la lecture est refusée (indisponible), jamais servie hors file", async () => {
    const compteur = { actives: 0, max: 0, ouvertures: 0 };
    const hs = { time: async () => { throw new Error("ECONNREFUSED"); }, eval: async () => { throw new Error("ECONNREFUSED"); }, zrem: async () => { throw new Error("ECONNREFUSED"); } } as unknown as Redis;
    const lire = creerFabriquePort(ports(compteur), LIMITES, MODELE, creerFileValkey(hs, LIMITES))(ctx()).lire;
    await expect(lire("liste-factures", {})).rejects.toMatchObject({ code: "indisponible" });
    expect(compteur.ouvertures).toBe(0); // aucune session : la lecture n'a pas eu lieu hors file
  });

  it("[A-170] deux processus de l'exécuteur lisant le même client ne dépassent pas CONNECTION LIMIT", async () => {
    vi.useFakeTimers();
    const places = new PlacesMemoire(() => Date.now()); // le « Valkey » commun aux deux processus
    const compteur = { actives: 0, max: 0, ouvertures: 0 };
    // Deux processus = deux fabriques, deux files locales, deux cellules différentes, une seule file partagée.
    const p1 = creerFabriquePort(ports(compteur), LIMITES, MODELE, creerFileParPlaces(places, LIMITES))(ctx()).lire;
    const p2 = creerFabriquePort(ports(compteur), LIMITES, MODELE, creerFileParPlaces(places, LIMITES))(ctx()).lire;
    const tout = Promise.all([p1("liste-factures", {}), p2("liste-factures", {}), p1("liste-factures", {}), p2("liste-factures", {}), p1("liste-factures", {}), p2("liste-factures", {})]);
    await vi.advanceTimersByTimeAsync(20_000);
    await tout;
    expect(compteur.ouvertures).toBe(6);
    expect(compteur.max).toBe(1);
  });

  it("[A-170] une place perdue par un processus tué revient après le bail", async () => {
    let maintenant = 1_000_000;
    const file: FileLecture = creerFileParPlaces(new PlacesMemoire(() => maintenant), LIMITES);
    expect(await file.prendre(A, "processus-tue", new AbortController().signal)).toBe(true); // jamais rendue : le processus est mort
    const refusee = new AbortController();
    setTimeout(() => refusee.abort(), 20);
    maintenant += BAIL - 1;
    expect(await file.prendre(A, "autre", refusee.signal)).toBe(false); // le bail court encore
    maintenant += 2;
    expect(await file.prendre(A, "autre", new AbortController().signal)).toBe(true); // le bail est échu : la place revient
  });

  it("[C-624] @isolation la place d'un client n'est jamais rendue par la lecture d'un autre client", async () => {
    const file = creerFileParPlaces(new PlacesMemoire(() => Date.now()), LIMITES);
    expect(await file.prendre(A, "p1", new AbortController().signal)).toBe(true);
    await file.rendre(B, "p1"); // même propriétaire, autre client
    await file.rendre(A, "p2"); // même client, autre propriétaire
    const attente = new AbortController();
    setTimeout(() => attente.abort(), 20);
    expect(await file.prendre(A, "p3", attente.signal)).toBe(false); // la place de A est toujours tenue par p1
    expect(await file.prendre(B, "p4", new AbortController().signal)).toBe(true); // B a sa propre place
    await file.rendre(A, "p1");
    expect(await file.prendre(A, "p3", new AbortController().signal)).toBe(true);
  });

  it("[A-170] la file Valkey range une seule place par client sous donnees:lecture, sans la cellule, avec un bail qui couvre une lecture entière", async () => {
    const appels: unknown[][] = [];
    const client = { time: async () => ["1000", "0"], eval: async (...a: unknown[]) => { appels.push(a); return 1; }, zrem: async () => 1 } as unknown as Redis;
    const file = creerFileValkey(client, LIMITES);
    expect(await file.prendre(A, "proprietaire-1", new AbortController().signal)).toBe(true);
    const [, nbCles, cle, maintenant, bail, limite, proprietaire] = appels[0]!;
    expect(nbCles).toBe(1);
    expect(cle).toBe(`axion:places:donnees:lecture:${A}`); // pas de cellule : CONNECTION LIMIT vaut pour toute la grappe
    expect(maintenant).toBe(1_000_000);
    expect(bail).toBe(BAIL); // délai total + deux délais de requête + 5 s
    expect(limite).toBe(1); // la 2e place de CONNECTION LIMIT 2 reste à la console
    expect(proprietaire).toBe("proprietaire-1");
  });
});
