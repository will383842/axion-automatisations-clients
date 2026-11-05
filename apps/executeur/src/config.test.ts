import { describe, expect, it } from "vitest";
import { type ListesEpinglees } from "../../../packages/sdk-module/src/emballage/cles-publiques.ts";
import { SignataireMemoire, signerArtefact } from "../../../packages/sdk-module/src/emballage/signer.ts";
import { chargerConfig } from "./config.ts";
import { chargerModule } from "./noyau/charger-module.ts";

const octets = (t: string) => new TextEncoder().encode(t);
const base = () => ({ "module.js": octets("export default 42;"), "manifest.json": octets('{"nom":"demo"}') });
const env = { VALKEY_HOTE: "valkey.test" };

// Le signataire de test imite les deux clés du coffre : mêmes idCle, clés différentes.
const publication = new SignataireMemoire("modules-publication:v1");
const recette = new SignataireMemoire("modules-recette:v1");
const listes: ListesEpinglees = {
  publication: [{ idCle: "modules-publication:v1", publique: publication.clePublique }],
  recette: [{ idCle: "modules-recette:v1", publique: recette.clePublique }],
};

describe("clés acceptées par l'exécuteur selon l'environnement", () => {
  it("[C-018] un module signé par modules-publication se charge en production", async () => {
    const config = chargerConfig({ ...env, EXECUTEUR_ENVIRONNEMENT: "production" }, listes);
    const m = await chargerModule(signerArtefact(base(), publication), config.clesAcceptees);
    expect(m["default"]).toBe(42);
  });

  it("[A-304] un module signé par modules-recette est refusé par l'exécuteur de production", async () => {
    const config = chargerConfig({ ...env, EXECUTEUR_ENVIRONNEMENT: "production" }, listes);
    await expect(chargerModule(signerArtefact(base(), recette), config.clesAcceptees)).rejects.toMatchObject({ code: "module_non_signe" });
  });

  it("[A-304] l'exécuteur de la recette accepte les deux clés", async () => {
    const config = chargerConfig({ ...env, EXECUTEUR_ENVIRONNEMENT: "recette" }, listes);
    expect((await chargerModule(signerArtefact(base(), recette), config.clesAcceptees))["default"]).toBe(42);
    expect((await chargerModule(signerArtefact(base(), publication), config.clesAcceptees))["default"]).toBe(42);
  });

  it("[A-304] sans réglage, l'environnement est la production (le plus strict) ; un environnement inconnu empêche le démarrage", () => {
    expect(chargerConfig(env, listes).environnement).toBe("production");
    expect(chargerConfig(env, listes).clesAcceptees.map((c) => c.idCle)).toEqual(["modules-publication:v1"]);
    for (const mauvais of ["", "test", "Recette", "prod", "recette,production"]) expect(() => chargerConfig({ ...env, EXECUTEUR_ENVIRONNEMENT: mauvais }, listes), mauvais).toThrow("EXECUTEUR_ENVIRONNEMENT");
  });

  it("[A-304] attaque 3 : aucune variable d'environnement ne peut ajouter, remplacer ou vider une clé de la liste épinglée", () => {
    const pirate = new SignataireMemoire("modules-publication:v1");
    const avant = chargerConfig(env, listes).clesAcceptees;
    const apres = chargerConfig({ ...env, EXECUTEUR_CLES_PUBLIQUES: pirate.clePublique, CLES_PUBLIQUES: pirate.clePublique, EXECUTEUR_CLE_PUBLIQUE: pirate.clePublique, MODULES_CLES: pirate.clePublique, EXECUTEUR_CLES_REVOQUEES: "modules-publication:v1" }, listes).clesAcceptees;
    expect(apres).toEqual(avant);
    expect(apres.map((c) => c.publique)).toEqual([publication.clePublique]);
  });

  it("[A-304] la liste de production par défaut (celle du dépôt) refuse tout module tant que le déploiement n'a rien épinglé", async () => {
    const config = chargerConfig(env);
    expect(config.clesAcceptees).toEqual([]);
    await expect(chargerModule(signerArtefact(base(), publication), config.clesAcceptees)).rejects.toMatchObject({ code: "module_non_signe" });
  });
});
