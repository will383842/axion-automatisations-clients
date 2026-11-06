import { describe, expect, it } from "vitest";
import { COMPTE, ENTREES, ONGLETS, entreesPour, niveauDe } from "./navigation.ts";

describe("navigation de la console", () => {
  it("[A-003] le menu montre les 7 entrées et le bloc du compte", () => {
    expect(ENTREES.map((e) => e.libelle)).toEqual(["Accueil", "Clients", "Alertes", "Demandes", "Facturation", "Catalogue et prix", "Conformité"]);
    expect(COMPTE.libelle).toBe("Sécurité et accès");
    expect(ENTREES.every((e) => e.href.startsWith("/"))).toBe(true);
  });

  it("[A-003] sous 720 px, 5 onglets dont « Plus »", () => {
    expect(ONGLETS.map(([, l]) => l)).toEqual(["Accueil", "Clients", "Alertes", "Demandes", "Plus"]);
  });

  it("[B-001] la navigation distingue pilotage global et pilotage par client", () => {
    expect(niveauDe("/alertes")).toEqual({ niveau: "global" });
    expect(niveauDe("/clients/boulangerie-rivoire/alertes")).toEqual({ niveau: "client", clientId: "boulangerie-rivoire" });
    expect(niveauDe("/clients/..%2F/alertes")).toEqual({ niveau: "global" });
    expect(entreesPour({ niveau: "global" })).toBe(ENTREES);
    const parClient = entreesPour({ niveau: "client", clientId: "garage-fontaine" });
    expect(parClient.every((e) => e.href.startsWith("/clients/garage-fontaine"))).toBe(true);
  });

  it("[A-003] l'entrée active se déduit du chemin", async () => {
    const { actifDe } = await import("./navigation.ts");
    expect(actifDe("/")).toBe("accueil");
    expect(actifDe("/facturation")).toBe("facturation");
    expect(actifDe("/clients/atelier-bertin/demandes")).toBe("clients");
    expect(actifDe("/inconnu")).toBeUndefined();
  });
});
