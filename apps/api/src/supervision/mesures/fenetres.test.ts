import { describe, expect, it } from "vitest";
import { tauxParAutomatisation, tauxParClient, tauxParInstance, tauxSucces, type ExecutionTerminee } from "./fenetres.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const I1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const I2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const maintenant = new Date("2026-11-06T12:00:00Z");
const H = 3_600_000;
const J = 24 * H;

let n = 0;
const exec = (p: Partial<ExecutionTerminee> = {}): ExecutionTerminee => ({
  id: `e${++n}`, tenantId: T1, instanceId: I1, automatisationId: "auto-relances", statut: "reussie", finLe: new Date(maintenant.getTime() - H), ...p,
});

describe("fenêtres de succès", () => {
  it("[B-382] 19 réussites et 1 échec en 24 h donnent 9 500 points de base", () => {
    const l = [...Array.from({ length: 19 }, () => exec()), exec({ statut: "echec" })];
    expect(tauxSucces(l, maintenant, J)).toEqual({ etat: "mesure", pointsDeBase: 9500, total: 20, echecs: 1 });
  });

  it("[B-382] la fenêtre de 7 jours ignore un échec de 8 jours", () => {
    const l = [exec(), exec({ statut: "echec", finLe: new Date(maintenant.getTime() - 8 * J) })];
    expect(tauxSucces(l, maintenant, 7 * J)).toEqual({ etat: "mesure", pointsDeBase: 10000, total: 1, echecs: 0 });
  });

  it("[B-382] un événement rejoué (même identifiant) ne compte qu'une fois", () => {
    const e = exec({ statut: "echec" });
    expect(tauxSucces([e, { ...e }], maintenant, J)).toEqual({ etat: "mesure", pointsDeBase: 0, total: 1, echecs: 1 });
  });

  it("[B-382] sans exécution attendue le taux est « sans objet », pas 0 %", () => {
    expect(tauxSucces([], maintenant, J)).toEqual({ etat: "sans_objet" });
    expect(tauxSucces([exec({ statut: "en_cours" as never })], maintenant, J)).toEqual({ etat: "sans_objet" });
  });

  it("[B-487] taux par automatisation sur tous ses clients", () => {
    const l = [exec({ tenantId: T1 }), exec({ tenantId: T2, instanceId: I2, statut: "echec" }), exec({ tenantId: T2, instanceId: I2, automatisationId: "auto-devis" })];
    const m = tauxParAutomatisation(l, maintenant, J);
    expect(m.get("auto-relances")).toEqual({ etat: "mesure", pointsDeBase: 5000, total: 2, echecs: 1 });
    expect(m.get("auto-devis")).toMatchObject({ pointsDeBase: 10000 });
  });

  it("[B-487] taux par client et par instance, séparés", () => {
    const l = [exec(), exec({ tenantId: T2, instanceId: I2, statut: "echec" })];
    expect(tauxParClient(l, maintenant, J).get(T1)).toMatchObject({ pointsDeBase: 10000 });
    expect(tauxParClient(l, maintenant, J).get(T2)).toMatchObject({ pointsDeBase: 0 });
    expect(tauxParInstance(l, maintenant, J).get(I2)).toMatchObject({ echecs: 1 });
  });

  it("[A-188] @isolation les mesures d'un client lues avec le contexte d'un autre sont vides", () => {
    const l = [exec({ tenantId: T1 })];
    const lues = l.filter((e) => e.tenantId === T2);
    expect(tauxParClient(lues, maintenant, J).size).toBe(0);
  });
});
