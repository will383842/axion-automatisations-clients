import { describe, expect, it } from "vitest";
import { ErreurApi } from "../plugins/erreurs.js";
import { creerServiceDonnees, type PortsDonnees, type SessionDonnees } from "../donnees/service.js";
import { LISTE_BLANCHE, type Requete } from "../donnees/requetes/liste.js";
import { declarer } from "../donnees/requetes/structure.js";
import { MASQUE_VUE, permiseEnVue } from "./masque.js";

// Masque de la vue (B-068) : refus sur la DÉCLARATION, avant toute base ; aucun oracle par la valeur, le message ou le temps.
const A = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-11-07T10:00:00Z");
const FIN = new Date(T0.getTime() + 600_000);
const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as ErreurApi).code;
const FICHIERS = "commun.index_fichiers";
const simple = (extra: Record<string, unknown>, parametres: Record<string, unknown> = {}) =>
  declarer({ nom: "essai", mode: "lecture", metadonnees: false, parametres, forme: { type: "simple", table: FICHIERS, sortie: { lignes: [{ colonne: "id" }] }, limite: { fixe: 10 }, ...extra } });
// Formes que la déclaration refuse déjà (somme d'un texte, colonne chiffrée) : forcées à la main pour prouver que le masque ne dépend pas de ce premier contrôle.
const forcee = (forme: Record<string, unknown>, variantes?: unknown[]) => ({ nom: "essai", mode: "lecture", metadonnees: false, parametres: {}, forme, ...(variantes ? { variantes } : {}) }) as unknown as Requete;

const MASQUEES: [string, Requete][] = [
  ["en sortie", simple({ sortie: { lignes: [{ colonne: "cle_objet" }] } })],
  ["en filtre", simple({ filtres: [{ colonne: "cle_objet", operateur: "egal", parametre: "p" }] }, { p: { type: "texte", max: 50 } })],
  ["en filtre sans valeur", simple({ filtres: [{ colonne: "cle_objet", operateur: "n_est_pas_nul" }] })],
  ["en tri", simple({ tri: [{ colonne: "cle_objet", sens: "asc" }] })],
  ["en agrégat", forcee({ type: "simple", table: FICHIERS, sortie: { agregats: [{ fonction: "somme", colonne: "cle_objet", alias: "s" }] } })],
  ["dans une partie composée", forcee({ type: "composee", parties: [
    { alias: "a", table: "commun.personnes", agregat: { fonction: "compter", alias: "a" } },
    { alias: "b", table: FICHIERS, agregat: { fonction: "compter", alias: "b" }, filtres: [{ colonne: "cle_objet", operateur: "est_nul" }] },
  ] })],
  ["dans une variante", forcee({ type: "simple", table: FICHIERS, sortie: { lignes: [{ colonne: "id" }] }, limite: { fixe: 1 } }, [{ depuis: 2, forme: { type: "simple", table: FICHIERS, sortie: { lignes: [{ colonne: "id" }] }, limite: { fixe: 1 }, tri: [{ colonne: "cle_objet", sens: "desc" }] } }])],
  ["colonne chiffrée", forcee({ type: "simple", table: "commun.personnes", sortie: { lignes: [{ colonne: "courriel_chiffre" }] }, limite: { fixe: 1 } })],
];

function ports(o: { vue: boolean }) {
  const appels = { base: 0, ouvrir: 0 };
  const p: PortsDonnees = {
    base: async () => { appels.base++; return { nomBase: "cli_1111", etat: "active" }; },
    ouvrir: async () => { appels.ouvrir++; return { requete: async (texte) => (texte.includes("commun.etablissements") ? [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] : [{ id: "x" }]), fermer: async () => {} }; },
    accordValide: async () => true,
    vueRangee: () => (o.vue ? { expireLe: FIN } : undefined),
    maintenant: () => T0,
  };
  return { p, appels };
}
const equipe: SessionDonnees = { tenantId: A, role: "equipe", acteur: "e1", etablissements: [], vue: { tenantId: A, expireLe: FIN } };
const client: SessionDonnees = { tenantId: A, role: "client", acteur: "u1", etablissements: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] };

describe("masque de la vue", () => {
  it("[B-068] @isolation une colonne masquée ne fuit ni par le tri ni par la recherche", async () => {
    expect(MASQUE_VUE.has("commun.index_fichiers.cle_objet")).toBe(true);
    for (const [nom, r] of MASQUEES) {
      expect(permiseEnVue(r), nom).toBe(false);
      const { p, appels } = ports({ vue: true });
      const service = creerServiceDonnees(p, { essai: r });
      // Même refus, quelle que soit la valeur du paramètre : aucune base n'est jamais atteinte.
      for (const valeur of ["a", "zzz", "%"]) expect(await code(service.executer(equipe, "essai", { p: valeur })), nom).toBe("action_interdite");
      expect(appels, nom).toEqual({ base: 0, ouvrir: 0 });
    }
  });

  it("[B-068] hors vue (session du client), la même requête passe ; les requêtes sans colonne masquée passent en vue", async () => {
    const [, filtre] = MASQUEES[1]!;
    const hors = ports({ vue: false });
    expect(await creerServiceDonnees(hors.p, { essai: filtre }).executer(client, "essai", { p: "a" })).toEqual([{ id: "x" }]);
    for (const nom of ["compterPersonnes", "listerListesProspects", "etatDonnees"]) expect(permiseEnVue(LISTE_BLANCHE[nom]!), nom).toBe(true);
    const dedans = ports({ vue: true });
    expect(await creerServiceDonnees(dedans.p).executer(equipe, "listerListesProspects", {})).toBeDefined();
    expect(dedans.appels.ouvrir).toBe(1);
  });

  it("[B-068] le refus du masque a lieu avant la base : le même code et le même message qu'un autre refus", async () => {
    const { p } = ports({ vue: true });
    const service = creerServiceDonnees(p, { essai: MASQUEES[0]![1], propre: simple({}) });
    const masque = (await service.executer(equipe, "essai", {}).catch((e: unknown) => e)) as ErreurApi;
    const sansVue = (await creerServiceDonnees(ports({ vue: false }).p, { propre: simple({}) }).executer({ ...equipe, vue: undefined }, "propre", {}).catch((e: unknown) => e)) as ErreurApi;
    expect([masque.code, masque.message]).toEqual([sansVue.code, sansVue.message]);
  });
});
