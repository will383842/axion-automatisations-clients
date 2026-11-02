import { describe, expect, it } from "vitest";
import { verifierCommission } from "./commissions.ts";

const VU = new Date("2026-11-01T03:00:00Z");
describe("commission d'un apporteur", () => {
  it("[A-147] une commission due non nulle est refusée sans SIREN, sans vérification, ou avec un SIREN dont la clé de Luhn est fausse", () => {
    expect(verifierCommission({ siren: null, sirenActifVerifieLe: VU, commissionsDuesCentimes: 100 })).toEqual({ ok: false, raison: "siren_absent" });
    expect(verifierCommission({ siren: "123456782", sirenActifVerifieLe: null, commissionsDuesCentimes: 100 })).toEqual({ ok: false, raison: "siren_non_verifie" });
    expect(verifierCommission({ siren: "123456789", sirenActifVerifieLe: VU, commissionsDuesCentimes: 100 })).toEqual({ ok: false, raison: "siren_luhn" });
    expect(verifierCommission({ siren: "12345678", sirenActifVerifieLe: VU, commissionsDuesCentimes: -100 })).toEqual({ ok: false, raison: "siren_luhn" });
  });

  it("[A-147] une commission nulle est acceptée sans SIREN ; un SIREN valide et vérifié accepte un solde positif ou négatif", () => {
    expect(verifierCommission({ siren: null, sirenActifVerifieLe: null, commissionsDuesCentimes: 0 })).toEqual({ ok: true });
    expect(verifierCommission({ siren: "123456782", sirenActifVerifieLe: VU, commissionsDuesCentimes: 100 })).toEqual({ ok: true });
    expect(verifierCommission({ siren: "123456782", sirenActifVerifieLe: VU, commissionsDuesCentimes: -100 })).toEqual({ ok: true });
  });

  it("[A-147] un montant non entier ou hors des entiers sûrs est refusé", () => {
    for (const c of [10.5, 2 ** 53, Number.NaN]) expect(verifierCommission({ siren: "123456782", sirenActifVerifieLe: VU, commissionsDuesCentimes: c })).toEqual({ ok: false, raison: "montant_invalide" });
  });
});
