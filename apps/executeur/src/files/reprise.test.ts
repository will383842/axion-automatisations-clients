import { describe, expect, it } from "vitest";
import { ErreurConnecteur } from "../noyau/politique-erreurs.ts";
import { HorlogeFactice } from "../noyau/horloge.ts";
import { planifierReprise } from "./travailleur.ts";

// L'attente avant un nouvel essai vient de la politique des erreurs, jamais de l'option « backoff » de BullMQ.
describe("attentes BullMQ pilotées par la politique", () => {
  it("[A-324] étape bloquée 121 s : coupée, classée passagère, nouvel essai reporté par la politique", () => {
    const h = new HorlogeFactice();
    h.aleas.push(0);
    expect(planifierReprise(new ErreurConnecteur("passagere", "delai_depasse"), 1, h)).toEqual({ action: "reporter", delaiMs: 1000 });
    h.aleas.push(0);
    expect(planifierReprise(new ErreurConnecteur("passagere", "delai_depasse"), 3, h)).toEqual({ action: "reporter", delaiMs: 4000 });
  });

  it("[A-322] erreur d'identification : instance en pause, aucun report", () => {
    expect(planifierReprise(new ErreurConnecteur("identification", "jeton_refuse"), 1, new HorlogeFactice())).toEqual({ action: "pause", code: "jeton_refuse" });
  });

  it("[A-321] plafond de 5 essais pour une erreur passagère, puis abandon sans nouveau report", () => {
    const h = new HorlogeFactice();
    expect(planifierReprise(new ErreurConnecteur("passagere", "reseau"), 5, h)).toEqual({ action: "abandon", code: "essais_epuises" });
  });

  it("[A-320] erreur définitive : abandon tout de suite, le code seul est gardé", () => {
    expect(planifierReprise(new Error("texte libre avec un secret"), 1, new HorlogeFactice())).toEqual({ action: "abandon", code: "erreur_inconnue" });
  });
});
