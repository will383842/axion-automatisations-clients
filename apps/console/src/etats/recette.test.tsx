import { describe, expect, it } from "vitest";
import { ECRANS } from "../ecrans.ts";
import { rendreEcran } from "./forcer.tsx";
import { boutonsPrincipaux, controlesStructurels, etatChargementValide, etatVideValide, motsInterdits, pastillesSansMot, texteVisible, tutoiement } from "./regles.ts";
import lexique from "../../../../scripts/lexique-interdit.json" with { type: "json" };

const CAS = ECRANS.flatMap((e) => e.etats.map((etat) => ({ e, etat })));

describe("recette des écrans inscrits, dans chaque état déclaré", () => {
  it("[C-594] chaque écran inscrit passe les contrôles structurels dans chaque état (axe-core et formats : Playwright)", async () => {
    expect(CAS.length).toBeGreaterThan(0);
    for (const { e, etat } of CAS) expect(controlesStructurels(await rendreEcran(e, etat)), `${e.route} ${etat}`).toEqual([]);
  });

  it("[B-201] un seul bouton principal par écran", async () => {
    for (const { e, etat } of CAS) expect(boutonsPrincipaux(await rendreEcran(e, etat)), `${e.route} ${etat}`).toBeLessThanOrEqual(1);
  });

  it("[B-301] chaque état vide a une phrase et un bouton", async () => {
    for (const { e, etat } of CAS.filter((c) => c.etat === "vide")) expect(etatVideValide(await rendreEcran(e, etat)), e.route).toBe(true);
  });

  it("[B-302] l'indicateur de chargement paraît avant 1 s", async () => {
    for (const { e, etat } of CAS.filter((c) => c.etat === "chargement")) expect(etatChargementValide(await rendreEcran(e, etat)), e.route).toBe(true);
  });

  it("[B-205] [B-268] aucune pastille sans mot", async () => {
    for (const { e, etat } of CAS) expect(pastillesSansMot(await rendreEcran(e, etat)), `${e.route} ${etat}`).toBe(0);
  });

  it("[B-226] aucun mot du lexique interdit", async () => {
    for (const { e, etat } of CAS) expect(motsInterdits(await rendreEcran(e, etat), lexique.mots), `${e.route} ${etat}`).toEqual([]);
  });

  it("[B-309] aucun tutoiement", async () => {
    for (const { e, etat } of CAS) expect(tutoiement(texteVisible(await rendreEcran(e, etat))), `${e.route} ${etat}`).toEqual([]);
  });

  it("[B-202] chaque parcours inscrit compte trois clics au plus depuis l'accueil", () => {
    for (const e of ECRANS) for (const p of e.parcours ?? []) expect(p.clics, `${e.route} ${p.nom}`).toBeLessThanOrEqual(3);
  });

  it("chaque état déclaré au registre peut être forcé par les aides de test", async () => {
    for (const { e, etat } of CAS) await expect(rendreEcran(e, etat), `${e.route} ${etat}`).resolves.toEqual(expect.any(String));
  });

  it.todo("[C-594] aucun défilement horizontal à 360 px (Playwright, workflow ecrans-console)");
});
