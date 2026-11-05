import type { Forme } from "@axion-auto/contrats/src/c4/forme.ts";
import { describe, expect, it } from "vitest";
import { genererSql } from "./generer.js";
import { analyserModele } from "./modele.js";
import { verifierForme } from "./verifier.js";

const E1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const modele = analyserModele('CREATE TABLE "commun"."personnes" (\n  "id" uuid PRIMARY KEY,\n  "etablissement_id" uuid NOT NULL,\n  "nom" text,\n  "courriel_chiffre" bytea\n);');
const forme = (colonne: string): Forme => ({ type: "simple", table: "commun.personnes", sortie: { lignes: [{ colonne }] }, limite: { fixe: 10 } });

describe("paquet donnees-module : aucune variable globale", () => {
  it("[A-170] genererSql et verifierForme n'utilisent que le modèle reçu", () => {
    expect(genererSql(forme("nom"), {}, {}, [E1], modele).texte).toContain('"commun"."personnes"');
    expect(() => genererSql(forme("nom"), {}, {}, [E1], analyserModele(""))).toThrow("table inconnue");
    expect(verifierForme(forme("nom"), {}, modele).refus).toEqual([]);
    expect(verifierForme(forme("courriel_chiffre"), {}, modele).refus).toEqual(["colonne refusée : courriel_chiffre"]);
    expect(verifierForme(forme("nom"), {}, analyserModele("")).refus.length).toBeGreaterThan(0);
  });
});
