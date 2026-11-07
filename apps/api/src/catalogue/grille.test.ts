import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { creerServiceGrilles, depotSqlGrilles, type DepotGrilles, type GrilleLue, type LigneAEcrire, type LigneHistorique, type TxGrilles, type ValeursGrille } from "./grille.js";

// Grille de prix d'une automatisation (T3-31a1, ADR 0133). Montants fictifs seulement. Faux dépôt en mémoire qui enregistre chaque opération.
const AUTO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PREC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AUTRE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACTEUR = "agent-essai";
const CORPS = {
  formules: ["abonnement"],
  frais_mise_en_place_ht_centimes: "12345",
  prix_mensuel_ht_centimes: "6789",
  maintenance_ensuite_ht_centimes: "1500",
  maintenance_incluse_mois: 3,
  grille_precedente_id: null as string | null,
  motif: "Mise à jour de la grille d'essai",
};
const PRECEDENTE: GrilleLue = { id: PREC, formules: ["abonnement"], installation: "10000", mensuel: "5000", maintenanceEnsuite: "1500", maintenanceIncluseMois: 3, auteur: "autre-agent", creeLe: new Date("2026-11-01T10:00:00Z") };

interface Etat {
  statut?: string | undefined; // undefined = automatisation inconnue
  grille?: GrilleLue | undefined;
  posterieure?: boolean;
  masquage?: string[];
  historique?: LigneHistorique[];
}
function faux(etat: Etat = {}) {
  const ops: string[] = [];
  const grillesEcrites: { auto: string; v: ValeursGrille; auteur: string }[] = [];
  const lignes: LigneAEcrire[] = [];
  let appels = 0;
  const e = { statut: "au_catalogue", posterieure: true, masquage: [] as string[], ...etat };
  const tx: TxGrilles = {
    async verrouiller() { ops.push("verrouiller"); return e.statut === undefined ? undefined : { statut: e.statut }; },
    async grilleEnVigueur() { ops.push("lire grille"); return e.grille ? { ...e.grille, posterieure: e.posterieure } : undefined; },
    async insererGrille(auto, v, auteur) { ops.push("INSERT grilles_prix"); grillesEcrites.push({ auto, v, auteur }); return { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", creeLe: new Date("2026-11-07T09:00:00Z") }; },
    async insererHistorique(l) { ops.push("INSERT historique_grilles_prix"); lignes.push(...l); },
    async masquage() { ops.push("masquage"); return e.masquage; },
  };
  const depot: DepotGrilles = {
    async ecrire(acteur, fn) { appels++; ops.push(`transaction ${acteur}`); return fn(tx); },
    async lire() { appels++; return e.statut === undefined ? undefined : { grille: e.grille ?? null, masquage: e.masquage }; },
    async historique() { appels++; return e.statut === undefined ? undefined : (e.historique ?? []); },
  };
  return { depot, ops, grillesEcrites, lignes, appels: () => appels, service: creerServiceGrilles(depot) };
}
const ecritures = (ops: string[]) => ops.filter((o) => o.startsWith("INSERT"));

describe("grille de prix : formules", () => {
  it("[C-167] seules les formules actives de la grille sont proposées ; une formule V2 est refusée", async () => {
    for (const formule of ["achat", "installation_maintenance"]) {
      const f = faux({ grille: PRECEDENTE });
      await expect(f.service.ecrire(AUTO, ACTEUR, { ...CORPS, formules: ["abonnement", formule], grille_precedente_id: PREC })).rejects.toMatchObject({ code: "regle_metier", message: "Formule non proposée en V1." });
      expect(f.appels()).toBe(0);
    }
    const f = faux({ grille: { ...PRECEDENTE, formules: ["abonnement", "standard"] } });
    const lue = await f.service.lire(AUTO);
    expect(lue.grille?.formules).toEqual(["abonnement", "standard"]);
    expect(lue.grille?.formules_proposees).toEqual(["abonnement"]);
    // Une chaîne hors de formule_instance est un schéma invalide, pas une règle V2.
    await expect(f.service.ecrire(AUTO, ACTEUR, { ...CORPS, formules: ["standard"] })).rejects.toMatchObject({ code: "schema_invalide" });
    await expect(f.service.ecrire(AUTO, ACTEUR, { ...CORPS, formules: [] })).rejects.toMatchObject({ code: "schema_invalide" });
    await expect(f.service.ecrire(AUTO, ACTEUR, { ...CORPS, formules: ["abonnement", "abonnement"] })).rejects.toMatchObject({ code: "schema_invalide" });
  });
});

describe("grille de prix : montants", () => {
  it("[C-168] @argent la grille abonnement garde frais de mise en place, prix mensuel et maintenance, en centimes entiers", async () => {
    const f = faux();
    const corps = { ...CORPS, frais_mise_en_place_ht_centimes: "0", prix_mensuel_ht_centimes: "999999999999", maintenance_ensuite_ht_centimes: "999999999999", maintenance_incluse_mois: 120 };
    const r = await f.service.ecrire(AUTO, ACTEUR, corps);
    expect(f.grillesEcrites[0]?.v).toEqual({ formules: ["abonnement"], installation: "0", mensuel: "999999999999", maintenanceEnsuite: "999999999999", maintenanceIncluseMois: 120 });
    expect(r.grille).toMatchObject({ frais_mise_en_place_ht_centimes: "0", prix_mensuel_ht_centimes: "999999999999", maintenance_ensuite_ht_centimes: "999999999999", maintenance_incluse_mois: 120, auteur: ACTEUR });
    expect(typeof r.grille.prix_mensuel_ht_centimes).toBe("string");
  });

  it("[C-168] @argent une saisie « 12,5 », négative ou en notation scientifique est refusée", async () => {
    const mauvaises: unknown[] = ["12,5", "12.5", "-1", "1e3", "1E3", " 1", "1 000", "1 000", "+1", "01", "", "١٢", "１２", "0x10", "Infinity", "1000000000000", 12, 12.5, null, true];
    for (const champ of ["frais_mise_en_place_ht_centimes", "prix_mensuel_ht_centimes", "maintenance_ensuite_ht_centimes"] as const) {
      for (const valeur of mauvaises) {
        const f = faux();
        await expect(f.service.ecrire(AUTO, ACTEUR, { ...CORPS, [champ]: valeur }), `${champ}=${String(valeur)}`).rejects.toMatchObject({ code: "schema_invalide" });
        expect(f.appels(), `${champ}=${String(valeur)}`).toBe(0);
      }
    }
    // Les mois : entier de 0 à 120 seulement. Le motif : 1 à 500 caractères ; la TVA et tout champ inconnu sont refusés.
    for (const mois of [-1, 121, 1.5, "3", null]) await expect(faux().service.ecrire(AUTO, ACTEUR, { ...CORPS, maintenance_incluse_mois: mois })).rejects.toMatchObject({ code: "schema_invalide" });
    for (const motif of ["", "   ", "x".repeat(501)]) await expect(faux().service.ecrire(AUTO, ACTEUR, { ...CORPS, motif })).rejects.toMatchObject({ code: "schema_invalide" });
    await expect(faux().service.ecrire(AUTO, ACTEUR, { ...CORPS, tva: "2000" })).rejects.toMatchObject({ code: "schema_invalide" });
    await expect(faux().service.ecrire(AUTO, ACTEUR, "pas un objet")).rejects.toMatchObject({ code: "schema_invalide" });
  });

  it("[LOT3-prix] @argent un prix mensuel nul est refusé", async () => {
    const f = faux();
    await expect(f.service.ecrire(AUTO, ACTEUR, { ...CORPS, prix_mensuel_ht_centimes: "0" })).rejects.toMatchObject({ code: "regle_metier", message: "Le prix mensuel ne peut pas être nul." });
    expect(f.appels()).toBe(0);
    // La formule V2 est refusée avant le prix nul (ordre des règles).
    await expect(f.service.ecrire(AUTO, ACTEUR, { ...CORPS, formules: ["achat"], prix_mensuel_ht_centimes: "0" })).rejects.toMatchObject({ message: "Formule non proposée en V1." });
  });
});

describe("grille de prix : historique", () => {
  it("[LOT3-prix] @argent changer un prix crée une ligne d'historique par champ changé, recopiée des deux grilles", async () => {
    const f = faux({ grille: PRECEDENTE });
    // Seul le mensuel change : les autres valeurs sont celles de la grille précédente.
    const corps = { ...CORPS, frais_mise_en_place_ht_centimes: PRECEDENTE.installation, prix_mensuel_ht_centimes: "5500", maintenance_ensuite_ht_centimes: PRECEDENTE.maintenanceEnsuite, maintenance_incluse_mois: PRECEDENTE.maintenanceIncluseMois, grille_precedente_id: PREC };
    const r = await f.service.ecrire(AUTO, ACTEUR, corps);
    const nouvelleId = f.grillesEcrites.length === 1 ? r.grille.id : "";
    expect(f.lignes).toEqual([{ grilleId: nouvelleId, precedenteId: PREC, champ: "mensuel", ancienne: PRECEDENTE.mensuel, nouvelle: "5500", raison: CORPS.motif }]);
    expect(r.historique).toHaveLength(1);
    expect(r.historique[0]).toMatchObject({ grille_id: nouvelleId, grille_precedente_id: PREC, champ: "mensuel", unite: "centimes", ancienne: "5000", nouvelle: "5500", auteur: ACTEUR, raison: CORPS.motif });
  });

  it("[LOT3-prix] @argent une première grille crée quatre lignes d'historique sans ancienne valeur", async () => {
    const f = faux();
    const r = await f.service.ecrire(AUTO, ACTEUR, CORPS);
    expect(f.lignes.map((l) => l.champ).sort()).toEqual(["installation", "maintenance_ensuite", "maintenance_incluse_mois", "mensuel"]);
    expect(f.lignes.every((l) => l.ancienne === null && l.precedenteId === null)).toBe(true);
    expect(f.lignes.find((l) => l.champ === "installation")?.nouvelle).toBe("12345");
    expect(f.lignes.find((l) => l.champ === "maintenance_incluse_mois")?.nouvelle).toBe("3");
    expect(r.historique).toHaveLength(4);
  });

  it("[LOT3-prix] @argent changer un prix n'écrit que dans grilles_prix et historique_grilles_prix", async () => {
    const requetes: string[] = [];
    const q = async (sql: string): Promise<Record<string, unknown>[]> => {
      requetes.push(sql);
      if (/FOR NO KEY UPDATE/.test(sql)) return [{ statut: "au_catalogue" }];
      if (/RETURNING id, cree_le/.test(sql)) return [{ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", cree_le: new Date("2026-11-07T09:00:00Z") }];
      return [];
    };
    const depot = depotSqlGrilles({ transaction: (_acteur, fn) => fn(q), lecture: (fn) => fn(q) });
    await creerServiceGrilles(depot).ecrire(AUTO, ACTEUR, CORPS);
    // Le verrou « FOR NO KEY UPDATE » n'est pas une écriture : on le retire avant de chercher UPDATE.
    const sansVerrou = (s: string) => s.replace(/FOR NO KEY UPDATE/g, "");
    const ecrits = requetes.filter((s) => /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sansVerrou(s)));
    expect(ecrits.length).toBeGreaterThan(0);
    for (const s of ecrits) expect(s).toMatch(/^\s*INSERT INTO (grilles_prix|historique_grilles_prix)\b/);
    expect(requetes.some((s) => /\b(UPDATE|DELETE|TRUNCATE)\b/i.test(sansVerrou(s)))).toBe(false);
    // Le verrou est la première requête ; les montants passent en texte, jamais convertis en nombre.
    expect(requetes[0]).toMatch(/SELECT statut FROM automatisations WHERE id = \$1 FOR NO KEY UPDATE/);
    expect(requetes.some((s) => /\$\d+::bigint/.test(s))).toBe(true);
  });

  it("[LOT3-prix] la grille en vigueur est choisie comme pour le plan (cree_le puis id décroissants)", async () => {
    const requetes: string[] = [];
    const q = async (sql: string): Promise<Record<string, unknown>[]> => { requetes.push(sql); return /FROM automatisations/.test(sql) ? [{ statut: "au_catalogue" }] : []; };
    const depot = depotSqlGrilles({ transaction: (_a, fn) => fn(q), lecture: (fn) => fn(q) });
    await depot.lire(AUTO);
    await depot.ecrire(ACTEUR, (tx) => tx.grilleEnVigueur(AUTO));
    const lectures = requetes.filter((s) => /FROM grilles_prix/.test(s));
    expect(lectures).toHaveLength(2);
    const plan = readFileSync(new URL("../commercial/lire-niveaux.ts", import.meta.url), "utf8");
    expect(plan).toContain("ORDER BY cree_le DESC, id DESC LIMIT 1");
    for (const s of lectures) expect(s).toContain("ORDER BY cree_le DESC, id DESC LIMIT 1");
  });

  it("[LOT3-prix] une grille précédente périmée est refusée sans écriture", async () => {
    const perime = { code: "regle_metier", message: "La grille a changé entre-temps : rechargez-la." };
    // Précédente différente de la grille en vigueur.
    let f = faux({ grille: PRECEDENTE });
    await expect(f.service.ecrire(AUTO, ACTEUR, { ...CORPS, grille_precedente_id: AUTRE })).rejects.toMatchObject(perime);
    expect(ecritures(f.ops)).toEqual([]);
    // Précédente nulle alors qu'une grille existe, ou non nulle alors qu'il n'y en a pas.
    await expect(f.service.ecrire(AUTO, ACTEUR, { ...CORPS, grille_precedente_id: null })).rejects.toMatchObject(perime);
    f = faux();
    await expect(f.service.ecrire(AUTO, ACTEUR, { ...CORPS, grille_precedente_id: PREC })).rejects.toMatchObject(perime);
    // Une transaction plus ancienne que la dernière grille (now() <= cree_le) est refusée de la même façon.
    f = faux({ grille: PRECEDENTE, posterieure: false });
    await expect(f.service.ecrire(AUTO, ACTEUR, { ...CORPS, grille_precedente_id: PREC })).rejects.toMatchObject(perime);
    expect(ecritures(f.ops)).toEqual([]);
  });

  it("[LOT3-prix] une grille identique est refusée sans écriture", async () => {
    const f = faux({ grille: PRECEDENTE });
    const identique = { ...CORPS, frais_mise_en_place_ht_centimes: "10000", prix_mensuel_ht_centimes: "5000", maintenance_ensuite_ht_centimes: "1500", maintenance_incluse_mois: 3, grille_precedente_id: PREC };
    await expect(f.service.ecrire(AUTO, ACTEUR, identique)).rejects.toMatchObject({ code: "regle_metier", message: "Grille identique : rien à enregistrer." });
    expect(ecritures(f.ops)).toEqual([]);
  });

  it("[LOT3-prix] une automatisation inconnue rend 404 et une automatisation archivée 422, sans écriture", async () => {
    let f = faux({ statut: undefined });
    await expect(f.service.ecrire(AUTO, ACTEUR, CORPS)).rejects.toMatchObject({ code: "introuvable" });
    expect(ecritures(f.ops)).toEqual([]);
    await expect(f.service.lire(AUTO)).rejects.toMatchObject({ code: "introuvable" });
    await expect(f.service.historique(AUTO, 50)).rejects.toMatchObject({ code: "introuvable" });
    f = faux({ statut: "archivee" });
    await expect(f.service.ecrire(AUTO, ACTEUR, CORPS)).rejects.toMatchObject({ code: "regle_metier", message: "Automatisation archivée : grille non modifiable." });
    expect(ecritures(f.ops)).toEqual([]);
    // Un acteur vide est refusé avant toute transaction (sinon le déclencheur d'audit répondrait 500).
    f = faux();
    for (const acteur of ["", "   ", "x".repeat(129)]) await expect(f.service.ecrire(AUTO, acteur, CORPS)).rejects.toMatchObject({ code: "action_interdite" });
    expect(f.appels()).toBe(0);
  });

  it("[LOT3-prix] une condition par défaut qui porte un tarif est signalée sans bloquer", async () => {
    const f = faux({ masquage: ["tarif_mensuel_centimes"] });
    const r = await f.service.ecrire(AUTO, ACTEUR, CORPS);
    expect(r.masquee_par_defaut).toEqual(["tarif_mensuel_centimes"]);
    expect(f.grillesEcrites).toHaveLength(1);
    expect((await f.service.lire(AUTO)).masquee_par_defaut).toEqual(["tarif_mensuel_centimes"]);
  });

  it("[LOT3-prix] l'historique dit l'unité de chaque champ", async () => {
    const ligne = (champ: LigneHistorique["champ"]): LigneHistorique => ({ grilleId: PREC, precedenteId: null, champ, ancienne: null, nouvelle: "3", auteur: ACTEUR, raison: "r", creeLe: new Date("2026-11-07T09:00:00Z") });
    const f = faux({ historique: (["installation", "mensuel", "maintenance_ensuite", "maintenance_incluse_mois"] as const).map(ligne) });
    const lignes = await f.service.historique(AUTO, 50);
    expect(Object.fromEntries(lignes.map((l) => [l.champ, l.unite]))).toEqual({ installation: "centimes", mensuel: "centimes", maintenance_ensuite: "centimes", maintenance_incluse_mois: "mois" });
    for (const limite of [0, 201, 1.5]) await expect(f.service.historique(AUTO, limite)).rejects.toMatchObject({ code: "schema_invalide" });
  });
});
