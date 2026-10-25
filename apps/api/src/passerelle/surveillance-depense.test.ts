import { beforeEach, describe, expect, it } from "vitest";
import { alertesEnMemoire } from "../alertes/port.js";
import { creerSurveillance, ErreurSurveillance } from "./surveillance-depense.js";

const A = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
const NOM_CLIENT = "Atelier Bertin";
const PLAFOND_TEST = 1_000_000; // micro-centimes, fictif
const SEUIL = 5;

let alertes: ReturnType<typeof alertesEnMemoire>;
let bloques: { tenantId: string; motif: string }[];
let derniereHeure: unknown;
let habituel: unknown;
const monter = (o: { blocagePanne?: boolean; alertePanne?: boolean } = {}) =>
  creerSurveillance({
    source: { depenseDerniereHeure: async () => derniereHeure as number, rythmeHabituel: async () => habituel as number },
    alertes: o.alertePanne ? { envoyer: async () => { throw new Error("alerte en panne"); } } : alertes,
    bloquerCle: async (tenantId, motif) => {
      if (o.blocagePanne) throw new Error("passerelle en panne");
      bloques.push({ tenantId, motif });
    },
    seuil: SEUIL,
    plafondCle: PLAFOND_TEST,
  });
const refus = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ErreurSurveillance);
  expect((e as ErreurSurveillance).code).toBe(code);
};
beforeEach(() => { alertes = alertesEnMemoire(); bloques = []; derniereHeure = 0; habituel = 10_000; });

describe("surveillance de la dépense d'IA", () => {
  it("[C-598] un rythme normal n'envoie aucune alerte et ne bloque rien", async () => {
    derniereHeure = 50_000; // exactement le seuil : pas « au-delà »
    expect(await monter().verifier(A)).toBe("normal");
    expect(alertes.envoyees).toEqual([]);
    expect(bloques).toEqual([]);
  });
  it("[C-598] un rythme anormal envoie l'alerte soupcon_acces_non_autorise sans nom de client, puis bloque la clé", async () => {
    derniereHeure = 50_001;
    expect(await monter().verifier(A)).toBe("alerte");
    expect(alertes.envoyees).toEqual([{ type: "soupcon_acces_non_autorise", clientId: A }]);
    expect(JSON.stringify(alertes.envoyees)).not.toContain(NOM_CLIENT);
    expect(bloques).toHaveLength(1);
    expect(bloques[0]?.tenantId).toBe(A);
  });
  it("[C-598] @argent attaque : client neuf (rythme habituel nul) → référence = plafond lissé sur le mois, pas de division par zéro ni d'alerte permanente", async () => {
    habituel = 0;
    derniereHeure = 1000; // 5 × 1 000 000 / 720 ≈ 6 944 : sous le seuil
    expect(await monter().verifier(A)).toBe("normal");
    derniereHeure = 7000;
    expect(await monter().verifier(A)).toBe("alerte");
  });
  it("[C-598] @argent attaque : un rythme habituel gonflé à la main ne repousse pas le seuil au-delà du plafond", async () => {
    habituel = PLAFOND_TEST * 1000;
    derniereHeure = PLAFOND_TEST + 1;
    expect(await monter().verifier(A)).toBe("alerte");
  });
  it("[C-598] @argent attaque : mesure illisible (négative, NaN, infinie, décimale, texte, absente) → refus, jamais « normal » par défaut", async () => {
    for (const v of [-1, Number.NaN, Infinity, 1.5, "100", null, undefined]) {
      derniereHeure = v;
      await refus(monter().verifier(A), "mesure_invalide");
      derniereHeure = 0;
      habituel = v;
      await refus(monter().verifier(A), "mesure_invalide");
      habituel = 10_000;
    }
    expect(bloques).toEqual([]);
  });
  it("[C-598] @isolation attaque : identifiant de client forgé refusé sans lecture ni alerte", async () => {
    for (const t of ["", "Atelier-Bertin", `${A}/../x`, ` ${A}`]) await refus(monter().verifier(t), "tenant_invalide");
    expect(alertes.envoyees).toEqual([]);
  });
  it("[C-598] attaque : blocage en panne → l'erreur remonte (rien n'est avalé) et l'alerte est déjà partie", async () => {
    derniereHeure = 99_999;
    await refus(monter({ blocagePanne: true }).verifier(A), "blocage_impossible");
    expect(alertes.envoyees).toHaveLength(1);
  });
  it("[C-598] attaque : alerte en panne → la clé est tout de même bloquée avant l'erreur (le blocage ne dépend pas de l'alerte)", async () => {
    derniereHeure = 99_999;
    await refus(monter({ alertePanne: true }).verifier(A), "alerte_impossible");
    expect(bloques).toHaveLength(1);
  });
  it("[C-598] @argent clé volée qui boucle : 300 appels en rafale sur une clé → bloquée, et la dépense totale ne dépasse pas le plafond de test plus la marge", async () => {
    const COUT = 20_000;
    const PAQUET = 10; // la passerelle n'écrit la dépense que par paquets : la mesure est en retard
    let ecrit = 0;
    let reel = 0;
    let bloquee = false;
    let acceptes = 0;
    habituel = 0;
    const s = creerSurveillance({
      source: { depenseDerniereHeure: async () => ecrit, rythmeHabituel: async () => 0 },
      alertes,
      bloquerCle: async () => { bloquee = true; },
      seuil: SEUIL,
      plafondCle: PLAFOND_TEST,
    });
    for (let i = 1; i <= 300; i++) {
      if (bloquee) continue;
      acceptes++;
      reel += COUT;
      if (i % PAQUET === 0) {
        ecrit = reel;
        await s.verifier(A);
      }
    }
    expect(bloquee).toBe(true);
    expect(acceptes).toBeLessThan(300);
    const MARGE = PAQUET * COUT; // une écriture par paquet : au plus un paquet de retard
    expect(reel).toBeLessThanOrEqual(PLAFOND_TEST + MARGE);
    expect(alertes.envoyees).toHaveLength(1);
  });
});
function "Atelier-Bertin" { return "Atelier-Bertin"; }
