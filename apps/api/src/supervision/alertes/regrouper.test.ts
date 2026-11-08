import { describe, expect, it } from "vitest";
import { cleRegroupement, depuisMesure, depuisSante, ErreurRegroupement } from "./regrouper.js";

describe("clé de regroupement", () => {
  it("[B-427] la clé de regroupement ne contient que des codes : un message brut avec une adresse ou un espace est refusé", () => {
    expect(() => cleRegroupement({ cause: "Erreur pour jean@exemple.fr" })).toThrow(ErreurRegroupement);
    expect(() => cleRegroupement({ cause: "timeout", connecteur: "mon connecteur" })).toThrow(ErreurRegroupement);
    expect(() => cleRegroupement({ cause: "" })).toThrow(ErreurRegroupement);
    expect(() => cleRegroupement({ cause: "a".repeat(65) })).toThrow(ErreurRegroupement);
  });
  it("[B-427] clés de même cause et de connecteurs différents → deux clés ; même cause et même connecteur → la même clé", () => {
    expect(cleRegroupement({ cause: "Timeout", connecteur: "Mail", version: "v2" })).toBe("timeout:mail:v2");
    expect(cleRegroupement({ cause: "timeout", connecteur: "mail" })).toBe("timeout:mail");
    expect(cleRegroupement({ cause: "timeout", connecteur: "mail" })).not.toBe(cleRegroupement({ cause: "timeout", connecteur: "agenda" }));
  });
  it("[B-427] les relevés de mesure et de santé donnent des codes, jamais un texte libre", () => {
    expect(depuisMesure({ cause: "base_saturee", raison: "connexions_80_pourcent" })).toEqual({ cause: "base_saturee" });
    expect(() => depuisMesure({ cause: "base_saturee", raison: "Trop de connexions !" })).toThrow(ErreurRegroupement);
    expect(depuisSante({ raisons: ["succes_sous_95", "connexion_expiree"], connecteur: "mail", version: "v1" })).toEqual({ cause: "sante_instance", connecteur: "mail", version: "v1" });
    // Retour au vert : T5-03 envoie raisons: [] ; ce n'est pas une erreur. Une raison qui n'est pas un code reste refusée.
    expect(depuisSante({ raisons: [] })).toEqual({ cause: "sante_instance" });
    expect(() => depuisSante({ raisons: ["Trop de pannes !"] })).toThrow(ErreurRegroupement);
    // Clé stable : orange (succes_sous_95) puis rouge (succes_sous_80) donnent la même clé.
    expect(cleRegroupement(depuisSante({ raisons: ["succes_sous_95"], connecteur: "mail" }))).toBe(cleRegroupement(depuisSante({ raisons: ["succes_sous_80"], connecteur: "mail" })));
  });
});
