import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { messages } from "@axion-auto/design/src/textes/messages.fr.ts";
import { boutonsPrincipaux, controlesStructurels, etatChargementValide, etatErreurValide, etatVideValide, motsInterdits, pastillesSansMot, texteVisible, tutoiement } from "./regles.ts";

const lexique = JSON.parse(readFileSync(new URL("../../../../scripts/lexique-interdit.json", import.meta.url), "utf8")) as { mots: string[] };

describe("règles de recette des écrans", () => {
  it("[B-201] [B-290] un seul bouton principal par écran", () => {
    expect(boutonsPrincipaux('<button data-variante="principal">A</button>')).toBe(1);
    expect(boutonsPrincipaux('<button data-variante="principal">A</button><button data-variante="principal">B</button>')).toBe(2);
    expect(boutonsPrincipaux('<button data-variante="secondaire">A</button>')).toBe(0);
  });

  it("[B-301] chaque état vide a une phrase et un bouton", () => {
    expect(etatVideValide('<p>Aucun client pour le moment.</p><button>Ajouter un client</button>')).toBe(true);
    expect(etatVideValide("<p>Aucun client pour le moment.</p>")).toBe(false);
    expect(etatVideValide("<button>Ajouter</button>")).toBe(false);
    expect(etatVideValide("<p>Une.</p><p>Deux.</p><button>Ajouter</button>")).toBe(false);
  });

  it("[B-302] l'indicateur de chargement paraît avant 1 s : il est dans le premier rendu, avec un mot", () => {
    expect(etatChargementValide('<div role="status" aria-busy="true">Chargement des clients…</div>')).toBe(true);
    expect(etatChargementValide("")).toBe(false);
    expect(etatChargementValide('<div role="status" aria-busy="true"></div>')).toBe(false);
  });

  it("[B-303] après une erreur, la saisie est conservée et le message vient du catalogue", () => {
    const m = messages["erreur.exportImpossible"];
    const bon = `<p>${m.titre}</p><p>${m.phrase}</p><input name="nom" value="Atelier Bertin"/>`;
    expect(etatErreurValide(bon, { nom: "Atelier Bertin" })).toBe(true);
    expect(etatErreurValide(bon, { nom: "autre" })).toBe(false);
    expect(etatErreurValide('<p>Oups, ça a planté</p><input name="nom" value="Atelier Bertin"/>', { nom: "Atelier Bertin" })).toBe(false);
  });

  it("[B-205] [B-268] une pastille sans mot est repérée", () => {
    expect(pastillesSansMot('<span data-couleur="vert">Fait</span>')).toBe(0);
    expect(pastillesSansMot('<span data-couleur="vert"></span>')).toBe(1);
  });

  it("[B-226] aucun mot du lexique interdit", () => {
    expect(lexique.mots.length).toBeGreaterThan(5);
    expect(motsInterdits("<p>Le webhook a échoué</p>", lexique.mots)).toEqual(["webhook"]);
    expect(motsInterdits("<p>Votre message est parti.</p>", lexique.mots)).toEqual([]);
  });

  it("[B-309] aucun tutoiement", () => {
    expect(tutoiement("Tu peux annuler ton envoi")).not.toEqual([]);
    expect(tutoiement("Vous pouvez annuler votre envoi..")).toEqual([]);
  });

  it("[C-594] les contrôles structurels repèrent image sans alt, bouton sans nom et champ sans libellé", () => {
    expect(controlesStructurels('<main><h1>Titre</h1><img src="a.svg"/></main>')).toContain("image sans alt");
    expect(controlesStructurels("<main><h1>Titre</h1><button></button></main>")).toContain("bouton sans nom");
    expect(controlesStructurels('<main><h1>Titre</h1><input name="a"/></main>')).toContain("champ sans libellé");
    expect(controlesStructurels('<main><h1>Titre</h1><label for="a">Nom</label><input id="a"/><button>Ok</button></main>')).toEqual([]);
    expect(controlesStructurels("<main><p>sans titre</p></main>")).toContain("un titre h1 attendu");
  });

  it("texteVisible retire les balises et décode les entités", () => {
    expect(texteVisible("<p>L&#x27;été &amp; vous</p>")).toBe("L'été & vous");
  });
});
