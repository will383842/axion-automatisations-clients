import { describe, expect, it } from "vitest";
import { assemblerNiveaux, type Entrees } from "./lire-niveaux.ts";
import { calculerPlan, ErreurPlan } from "./plan.ts";

// Montants FICTIFS en centimes ; jamais un tarif réel.
const FORMULES = ["abonnement", "achat", "installation_maintenance"];
const GRILLE = { fraisMiseEnPlaceCentimes: 5000, tarifMensuelCentimes: 1000, maintenanceIncluseMois: 3, formulesActives: FORMULES };
const DEFAUTS = [
  { type: "engagement", valeur: { engagement_mois: 12, suite_maintenance: "arret" } },
  { type: "periode", valeur: { periode_facturation_mois: 1, mode_avance: "aucune" } },
  { type: "garantie", valeur: { garantie_mois: 3 } },
  { type: "delai", valeur: { delai_jours: 5 } },
  { type: "seuil_alerte", valeur: { seuil_alerte_bps: 8000 } },
];
const base = (extra: Partial<Entrees> = {}): Entrees => ({ grille: GRILLE, defauts: DEFAUTS, metier: null, client: [], instance: {}, ...extra });
const plan = (extra: Partial<Entrees> = {}, formule = "abonnement") => {
  const e = base(extra);
  return calculerPlan(assemblerNiveaux(e), formule, e.grille ? e.grille.formulesActives : null);
};

describe("plan commercial calculé", () => {
  it("[C-138] @argent le plan d'une instance prend la grille, puis les conditions par défaut, puis celles du client", () => {
    const grilleSeule = plan({ defauts: DEFAUTS });
    expect(grilleSeule.fraisMiseEnPlaceHtCentimes).toBe(5000);
    expect(grilleSeule.sources.fraisMiseEnPlace).toBe("grille");
    const avecDefaut = plan({ defauts: [...DEFAUTS, { type: "frais", valeur: { frais_mise_en_place_centimes: 4000 } }] });
    expect(avecDefaut.fraisMiseEnPlaceHtCentimes).toBe(4000);
    expect(avecDefaut.sources.fraisMiseEnPlace).toBe("defaut");
    const avecClient = plan({ defauts: [...DEFAUTS, { type: "frais", valeur: { frais_mise_en_place_centimes: 4000 } }], client: [{ type: "frais", valeur: { frais_mise_en_place_centimes: 3000 } }] });
    expect(avecClient.fraisMiseEnPlaceHtCentimes).toBe(3000);
    expect(avecClient.sources.fraisMiseEnPlace).toBe("client");
    // Une valeur du client n'est jamais écrasée par celle du métier (ordre inversé, attaque 1).
    const metier = { donnees: { engagement_mois: 24 }, version: 2 };
    expect(plan({ metier, client: [{ type: "engagement", valeur: { engagement_mois: 6 } }] }).engagementMois).toBe(6);
    expect(plan({ metier }).engagementMois).toBe(24);
  });

  it("[A-143] @argent chaque valeur du plan préparé porte sa source", () => {
    const p = plan({ client: [{ type: "frais", valeur: { tarif_mensuel_centimes: 900 } }] });
    expect(Object.keys(p.sources).sort()).toEqual(["engagement", "formule", "fraisMiseEnPlace", "maintenanceIncluse", "modeAvance", "periodeFacturation", "prixRecurrentMensuel", "suiteMaintenance"]);
    for (const source of Object.values(p.sources)) expect(["grille", "defaut", "client", "instance"]).toContain(source);
    expect(p.sources.prixRecurrentMensuel).toBe("client");
    expect(p.sources.formule).toBe("instance");
    for (const v of Object.values(p.valeurs)) expect(v.source).toMatch(/^(global|automatisation|metier|client|instance)$/);
  });

  it("[A-039] tarif, remise, frais, engagement, garantie, délais et seuils ont une valeur par défaut modifiable pour un client", () => {
    const defaut = plan({ defauts: [...DEFAUTS, { type: "remise", valeur: { remise_bps: 500 } }] });
    const client = plan({
      defauts: [...DEFAUTS, { type: "remise", valeur: { remise_bps: 500 } }],
      client: [
        { type: "frais", valeur: { frais_mise_en_place_centimes: 100, tarif_mensuel_centimes: 200 } },
        { type: "remise", valeur: { remise_bps: 1000 } },
        { type: "engagement", valeur: { engagement_mois: 6 } },
        { type: "garantie", valeur: { garantie_mois: 9 } },
        { type: "delai", valeur: { delai_jours: 2 } },
        { type: "seuil_alerte", valeur: { seuil_alerte_bps: 5000 } },
      ],
    });
    expect(defaut.valeurs["remise_bps"]).toMatchObject({ valeur: 500, source: "global" });
    for (const [cle, valeur] of [["remise_bps", 1000], ["engagement_mois", 6], ["garantie_mois", 9], ["delai_jours", 2], ["seuil_alerte_bps", 5000], ["frais_mise_en_place_centimes", 100], ["tarif_mensuel_centimes", 200]] as const) {
      expect(client.valeurs[cle]).toMatchObject({ valeur, source: "client" });
    }
    expect(defaut.valeurs["garantie_mois"]).toMatchObject({ valeur: 3, source: "global" });
  });

  it("[A-044] maintenance incluse, engagement, garantie et période de paiement se règlent client par client", () => {
    const a = plan({ client: [{ type: "engagement", valeur: { maintenance_incluse_mois: 6, engagement_mois: 24 } }, { type: "periode", valeur: { periode_facturation_mois: 12 } }, { type: "garantie", valeur: { garantie_mois: 12 } }] });
    const b = plan({ client: [{ type: "engagement", valeur: { maintenance_incluse_mois: 1 } }, { type: "periode", valeur: { periode_facturation_mois: 6 } }] });
    expect([a.maintenanceIncluseMois, a.engagementMois, a.periodeFacturationMois, a.valeurs["garantie_mois"]?.valeur]).toEqual([6, 24, 12, 12]);
    expect([b.maintenanceIncluseMois, b.engagementMois, b.periodeFacturationMois, b.valeurs["garantie_mois"]?.valeur]).toEqual([1, 12, 6, 3]);
  });

  it("[A-006] deux instances du même client portent deux formules différentes", () => {
    const client = [{ type: "frais", valeur: { tarif_mensuel_centimes: 700 } }];
    const abonnement = plan({ client }, "abonnement");
    const achat = plan({ client }, "achat");
    expect([abonnement.formule, achat.formule]).toEqual(["abonnement", "achat"]);
    // Le prix récurrent résolu est enregistré tel quel, pour toute formule (colonne obligatoire) : ce n'est PAS une règle d'égalité (voir ADR 0058, dette).
    expect(abonnement.sources.formule).toBe("instance");
    expect(() => plan({}, "formule_inconnue")).toThrow(ErreurPlan);
  });

  it("[A-160] @argent la remise s'applique aux frais et au prix, arrondie vers le bas, jamais négative", () => {
    const p = plan({ client: [{ type: "remise", valeur: { remise_bps: 3333 } }] });
    expect(p.fraisMiseEnPlaceHtCentimes).toBe(5000 - Math.floor((5000 * 3333) / 10000));
    expect(p.prixRecurrentMensuelHtCentimes).toBe(1000 - Math.floor((1000 * 3333) / 10000));
    expect(p.sources.prixRecurrentMensuel).toBe("client");
    // Une remise annulée par null explicite ne revient pas (attaque 2).
    const annulee = plan({ defauts: [...DEFAUTS, { type: "remise", valeur: { remise_bps: 2000 } }], client: [{ type: "remise", valeur: { remise_bps: null } }] });
    expect(annulee.prixRecurrentMensuelHtCentimes).toBe(1000);
    // Remise de 100 % ou plus, négative, à virgule : refusée (attaque 3).
    for (const bps of [10000, 10001, -1, 0.5]) expect(() => plan({ client: [{ type: "remise", valeur: { remise_bps: bps } }] })).toThrow(ErreurPlan);
  });

  it("[A-160] @argent un montant hors borne ou une clé non permise est refusé", () => {
    expect(() => plan({ grille: { ...GRILLE, tarifMensuelCentimes: Number.MAX_SAFE_INTEGER + 1 } })).toThrow(/valeur_invalide/);
    expect(() => plan({ client: [{ type: "frais", valeur: { cle_inconnue: 1 } }] })).toThrow(/cle_non_heritable/);
    expect(() => plan({ client: [{ type: "remise", valeur: { engagement_mois: 1 } }] })).toThrow(/cle_non_heritable/);
    // L'instance ne surcharge que les clés que la liste lui permet (attaque 1).
    expect(() => plan({ instance: { tarif_mensuel_centimes: 1 } })).toThrow(/surcharge_instance_interdite/);
    expect(plan({ instance: { delai_jours: 1 } }).valeurs["delai_jours"]).toMatchObject({ valeur: 1, source: "instance" });
    // Sans valeur nulle part, pas de repli inventé.
    expect(() => plan({ defauts: [] })).toThrow(/valeur_manquante/);
  });

  it("[A-160] @argent mêmes entrées, même plan", () => {
    const entrees = base({ client: [{ type: "frais", valeur: { frais_mise_en_place_centimes: 10, tarif_mensuel_centimes: 20 } }, { type: "remise", valeur: { remise_bps: 25 } }] });
    const renverse = { ...entrees, defauts: [...entrees.defauts].reverse() };
    expect(JSON.stringify(calculerPlan(assemblerNiveaux(renverse), "abonnement", FORMULES))).toBe(JSON.stringify(calculerPlan(assemblerNiveaux(entrees), "abonnement", FORMULES)));
  });

  it("[C-138] @argent une formule absente des formules actives de la grille est refusée ; sans grille, aucune liste ne s'applique", () => {
    const refus = (formule: string, actives: string[]) => expect(() => calculerPlan(assemblerNiveaux(base()), formule, actives)).toThrow(expect.objectContaining({ motif: "formule_non_proposee" }));
    refus("achat", ["abonnement"]);
    refus("abonnement", []);
    expect(calculerPlan(assemblerNiveaux(base()), "achat", ["achat"]).formule).toBe("achat");
    expect(calculerPlan(assemblerNiveaux(base({ grille: null, defauts: [...DEFAUTS, { type: "frais", valeur: { frais_mise_en_place_centimes: 1, tarif_mensuel_centimes: 2 } }, { type: "engagement", valeur: { maintenance_incluse_mois: 0 } }] })), "achat", null).formule).toBe("achat");
  });

  it("[A-160] @argent engagement, maintenance incluse et période respectent la borne des colonnes integer (2147483647), en ErreurPlan", () => {
    const MAX32 = 2147483647;
    expect(plan({ client: [{ type: "engagement", valeur: { engagement_mois: MAX32, maintenance_incluse_mois: MAX32 } }] }).engagementMois).toBe(MAX32);
    for (const cle of ["engagement_mois", "maintenance_incluse_mois"]) {
      expect(() => plan({ client: [{ type: "engagement", valeur: { [cle]: MAX32 + 1 } }] }), cle).toThrow(expect.objectContaining({ motif: `valeur_invalide:${cle}` }));
    }
    expect(() => plan({ grille: { ...GRILLE, maintenanceIncluseMois: MAX32 + 1 } })).toThrow(ErreurPlan);
    for (const p of [0, 2, 13, 2147483648]) expect(() => plan({ client: [{ type: "periode", valeur: { periode_facturation_mois: p } }] }), String(p)).toThrow(ErreurPlan);
  });
});
