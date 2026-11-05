import { describe, expect, it } from "vitest";
import { CLES_PUBLIQUES, clesAcceptees, type ClePublique, type ListesEpinglees } from "./cles-publiques.ts";

const cle = (idCle: string, revoquee?: boolean): ClePublique => ({ idCle, publique: "pem-de-test", ...(revoquee ? { revoquee: true } : {}) });
const listes: ListesEpinglees = { publication: [cle("modules-publication:v1"), cle("modules-publication:v2", true)], recette: [cle("modules-recette:v1")] };

describe("listes épinglées de clés publiques par environnement", () => {
  it("[A-304] la production n'accepte que les clés de modules-publication ; la recette accepte les deux", () => {
    expect(clesAcceptees("production", listes).map((c) => c.idCle)).toEqual(["modules-publication:v1", "modules-publication:v2"]);
    expect(clesAcceptees("recette", listes).map((c) => c.idCle).sort()).toEqual(["modules-publication:v1", "modules-publication:v2", "modules-recette:v1"]);
  });

  it("[A-304] un environnement inconnu ou absent est refusé (aucune liste par défaut permissive)", () => {
    for (const mauvais of [undefined, "", "Production", "test", "dev", "production ", 1, null]) expect(() => clesAcceptees(mauvais, listes), String(mauvais)).toThrow();
  });

  it("[A-304] une clé de recette glissée dans la liste de publication (ou l'inverse) fait refuser le chargement des listes", () => {
    expect(() => clesAcceptees("production", { publication: [cle("modules-recette:v1")], recette: [] })).toThrow();
    expect(() => clesAcceptees("recette", { publication: [], recette: [cle("modules-publication:v1")] })).toThrow();
    expect(() => clesAcceptees("production", { publication: [cle("modules-publication:v1x")], recette: [] })).toThrow();
  });

  it("[A-302] sans listes injectées, la production ne reçoit aucune clé tant que le déploiement n'a pas épinglé celle du coffre", () => {
    expect(clesAcceptees("production")).toEqual([]);
    expect(CLES_PUBLIQUES).toEqual([]);
  });
});
