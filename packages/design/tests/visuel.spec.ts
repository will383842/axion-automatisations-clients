import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Galerie de 3 maquettes (C-597, C-595) : entreprises inventées, aucun montant.
const PAGES = [
  { id: "console-alertes", url: "/console-alertes.html" },
  { id: "portail-automatisation", url: "/portail-automatisation.html" },
  { id: "tel-portail-relire", url: "/tel-portail-relire.html" },
];

const ouvrir = async (page: Page, url: string) => {
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
};

test.describe("[C-597] galerie à 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("[C-597] la galerie à 390 px n'a aucun défilement horizontal", async ({ page }) => {
    for (const { url } of PAGES) {
      await ouvrir(page, url);
      const { document: largeur, fenetre } = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, fenetre: window.innerWidth }));
      expect(largeur, url).toBeLessThanOrEqual(fenetre);
    }
  });

  test("[C-597] la galerie à 390 px n'a aucun bouton d'action recouvert par la barre d'onglets", async ({ page }) => {
    for (const { url } of PAGES) {
      await ouvrir(page, url);
      const boutons = page.locator("main button:visible");
      for (let i = 0; i < (await boutons.count()); i++) {
        const bouton = boutons.nth(i);
        await bouton.scrollIntoViewIfNeeded();
        const libre = await bouton.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const point = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return point !== null && el.contains(point);
        });
        expect(libre, `${url} bouton ${i}`).toBe(true);
      }
    }
  });

  test("[C-597] la galerie à 390 px n'a aucune cible tactile < 48 px et aucun texte < 13 px", async ({ page }) => {
    for (const { url } of PAGES) {
      await ouvrir(page, url);
      const fautes = await page.evaluate(() => {
        const sorties: string[] = [];
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
        };
        for (const el of document.querySelectorAll("button, input:not([type=checkbox]):not([type=radio]), select, textarea, nav a")) {
          const r = el.getBoundingClientRect();
          if (visible(el) && (r.height < 47.5 || r.width < 47.5)) sorties.push(`cible ${el.tagName} ${Math.round(r.width)}x${Math.round(r.height)} ${el.textContent?.slice(0, 20)}`);
        }
        for (const el of document.querySelectorAll("body *")) {
          const propre = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "");
          if (propre && visible(el) && parseFloat(getComputedStyle(el).fontSize) < 13) sorties.push(`texte ${el.tagName} ${getComputedStyle(el).fontSize}`);
        }
        return sorties;
      });
      expect(fautes, url).toEqual([]);
    }
  });

  test("[C-597] sous 720 px le menu latéral est caché et la barre d'onglets visible", async ({ page }) => {
    await ouvrir(page, PAGES[1]!.url);
    await expect(page.locator(".r-menu")).toBeHidden();
    await expect(page.locator(".r-onglets")).toBeVisible();
  });
});

test.describe("[C-597] galerie à 1440 px", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("[C-597] au-dessus de 720 px le menu latéral est visible et la barre d'onglets cachée", async ({ page }) => {
    await ouvrir(page, PAGES[0]!.url);
    await expect(page.locator(".r-menu")).toBeVisible();
    await expect(page.locator(".r-onglets")).toBeHidden();
  });
});

test.describe("axe-core WCAG 2.2 AA", () => {
  for (const { id, url } of PAGES) {
    test(`[C-597] axe-core WCAG 2.2 AA sans violation sur ${id}`, async ({ page }) => {
      await ouvrir(page, url);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(violations.map((v) => `${v.id} : ${v.nodes.length}`)).toEqual([]);
    });
  }
});

test.describe("captures de référence", () => {
  for (const { id, url } of PAGES) {
    test(`[C-595] captures de la galerie à 1440 et 390 px : ${id}`, async ({ page }, info) => {
      await ouvrir(page, url);
      await expect(page).toHaveScreenshot(`${id}-${info.project.name}.png`, { fullPage: true, animations: "disabled" });
    });
  }
});
