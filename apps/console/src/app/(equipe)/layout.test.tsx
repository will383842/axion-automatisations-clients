import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

let cookie = "";
let chemin = "/alertes";
const redirige = vi.fn((a: string) => { throw new Error(`REDIRECT:${a}`); });
vi.mock("next/headers.js", () => ({ headers: async () => new Headers({ cookie, "x-chemin": chemin }) }));
vi.mock("next/navigation.js", () => ({ redirect: (a: string) => redirige(a) }));
const { magasin } = await import("../../lib/session.ts");
const { default: MiseEnPage } = await import("./layout.tsx");

beforeEach(() => { cookie = ""; chemin = "/alertes"; redirige.mockClear(); });

describe("disposition de l'équipe", () => {
  it("[C-541] sans session valide côté serveur, la disposition renvoie à la reconnexion (cookie inventé refusé)", async () => {
    cookie = "__Host-session=inventee";
    await expect(MiseEnPage({ children: "x" })).rejects.toThrow("REDIRECT:/connexion/reconnexion?retour=%2Falertes");
  });

  it("[A-003] avec une session, le menu a 7 entrées, le bloc du compte et 5 onglets", async () => {
    const s = magasin.ouvrirSession({ sub: "u1", jeton: "j" });
    cookie = `__Host-session=${s.id}`;
    const html = renderToStaticMarkup(await MiseEnPage({ children: "contenu" }));
    const menu = /<nav aria-label="Menu principal".*?<\/nav>/s.exec(html)?.[0] ?? "";
    expect(menu.match(/<a /g)).toHaveLength(7);
    expect(menu).toContain('aria-current="page"');
    expect(html).toContain("Sécurité et accès");
    expect(/<nav class="r-onglets".*?<\/nav>/s.exec(html)?.[0].match(/<a /g)).toHaveLength(5);
    expect(html).toContain("contenu");
  });

  it("[A-104] le lien vers le back-office vient de la configuration, absent sans elle", async () => {
    const s = magasin.ouvrirSession({ sub: "u2", jeton: "j" });
    cookie = `__Host-session=${s.id}`;
    vi.stubEnv("BACKOFFICE_URL", "");
    expect(renderToStaticMarkup(await MiseEnPage({ children: "x" }))).not.toContain("Back-office");
    vi.stubEnv("BACKOFFICE_URL", "https://bo.exemple.test");
    expect(renderToStaticMarkup(await MiseEnPage({ children: "x" }))).toContain('href="https://bo.exemple.test"');
    vi.unstubAllEnvs();
  });
});
