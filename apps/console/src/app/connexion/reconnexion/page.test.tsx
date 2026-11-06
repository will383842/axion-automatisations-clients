import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Page from "./page.tsx";

const rendre = async (retour?: string) => renderToStaticMarkup(await Page({ searchParams: Promise.resolve(retour === undefined ? {} : { retour }) }));

describe("page de reconnexion", () => {
  it("[C-541] la page dit que le double facteur est redemandé et renvoie vers /connexion par un formulaire GET", async () => {
    const html = await rendre("/clients");
    expect(html).toContain("redemande toujours votre identité");
    expect(html).toContain('action="/connexion"');
    expect(html).toContain('method="get"');
    expect(html).toContain('name="retour" value="/clients"');
  });

  it("[LOT3-session] un retour vers une autre origine est remplacé par l'accueil", async () => {
    for (const mauvais of ["//autre.test", "https://autre.test/", "/\\autre.test", "/%5Cautre.test"]) {
      expect(await rendre(mauvais), mauvais).toContain('name="retour" value="/"');
    }
  });
});
