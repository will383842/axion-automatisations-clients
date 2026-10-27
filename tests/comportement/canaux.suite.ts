import { expect } from "vitest";
import { cleDIntention } from "../../packages/contrats/src/index.ts";
import { envoyerSigne, type Identifiants } from "../bouchons/hub/client-signe.ts";

// Suite de comportement partagée (C-537) : la même contre les bouchons ici, contre les vraies copies à la recette (CIBLE_RECETTE, lot 1-B).
// Une cible qui répond autrement que le bouchon fait échouer la suite.
export interface Cible {
  url: string;
  ident: Identifiants;
  ecriture: { chemin: string; corps: (variante: string) => unknown };
  // Vérifie, avec expect, la réponse d'une lecture ou d'une écriture sur une fiche absorbée par une fusion.
  verifierFusion: () => Promise<void>;
  // Absents sur une vraie copie : on ne coupe pas la porte d'un système de recette depuis un test.
  couper?: () => void;
  rouvrir?: () => void;
}

const nouvelleCle = () => cleDIntention("suite-comportement", crypto.randomUUID());
const maintenant = () => Math.floor(Date.now() / 1000);

const cas: Record<string, (c: Cible) => Promise<void>> = {
  "signature fausse : 401 signature_invalide": async (c) => {
    const r = await envoyerSigne(c.url, { ...c.ident, secret: "TEST-NE-PAS-UTILISER-autre" }, "POST", c.ecriture.chemin, c.ecriture.corps("a"), { cleIdempotence: nouvelleCle() });
    expect([r.statut, r.corps.erreur.code]).toEqual([401, "signature_invalide"]);
  },
  "horodatage hors fenêtre : 401 horodatage_perime": async (c) => {
    const r = await envoyerSigne(c.url, c.ident, "POST", c.ecriture.chemin, c.ecriture.corps("a"), { cleIdempotence: nouvelleCle(), horodatage: maintenant() - 400 });
    expect([r.statut, r.corps.erreur.code]).toEqual([401, "horodatage_perime"]);
  },
  "rejeu de la même signature : 401 rejeu": async (c) => {
    const options = { cleIdempotence: nouvelleCle(), horodatage: maintenant() - 7 };
    const premier = await envoyerSigne(c.url, c.ident, "POST", c.ecriture.chemin, c.ecriture.corps("b"), options);
    expect(premier.statut).toBeLessThan(300);
    const second = await envoyerSigne(c.url, c.ident, "POST", c.ecriture.chemin, c.ecriture.corps("b"), options);
    expect([second.statut, second.corps.erreur.code]).toEqual([401, "rejeu"]);
  },
  "même clé, même corps : même réponse, Idempotency-Replayed": async (c) => {
    const cleIdempotence = nouvelleCle();
    const premier = await envoyerSigne(c.url, c.ident, "POST", c.ecriture.chemin, c.ecriture.corps("c"), { cleIdempotence, horodatage: maintenant() - 2 });
    const second = await envoyerSigne(c.url, c.ident, "POST", c.ecriture.chemin, c.ecriture.corps("c"), { cleIdempotence, horodatage: maintenant() - 1 });
    expect(premier.entetes.get("Idempotency-Replayed")).toBeNull();
    expect(second.entetes.get("Idempotency-Replayed")).toBe("true");
    expect([second.statut, second.corps]).toEqual([premier.statut, premier.corps]);
  },
  "même clé, corps différent : 409 cle_reutilisee": async (c) => {
    const cleIdempotence = nouvelleCle();
    await envoyerSigne(c.url, c.ident, "POST", c.ecriture.chemin, c.ecriture.corps("d"), { cleIdempotence, horodatage: maintenant() - 4 });
    const r = await envoyerSigne(c.url, c.ident, "POST", c.ecriture.chemin, c.ecriture.corps("e"), { cleIdempotence, horodatage: maintenant() - 3 });
    expect([r.statut, r.corps.erreur.code]).toEqual([409, "cle_reutilisee"]);
  },
  "fiche fusionnée": (c) => c.verifierFusion(),
  "porte fermée : 503 porte_fermee": async (c) => {
    if (!c.couper || !c.rouvrir) return;
    c.couper();
    try {
      const r = await envoyerSigne(c.url, c.ident, "POST", c.ecriture.chemin, c.ecriture.corps("f"), { cleIdempotence: nouvelleCle() });
      expect([r.statut, r.corps.erreur.code]).toEqual([503, "porte_fermee"]);
    } finally {
      c.rouvrir();
    }
  },
};

export async function lancerSuite(cible: Cible): Promise<void> {
  for (const [nom, essai] of Object.entries(cas)) {
    try {
      await essai(cible);
    } catch (e) {
      throw new Error(`${nom} : ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }
}
