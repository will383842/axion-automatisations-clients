import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { consommerClic, creerClicEquipe } from "./clic-equipe.js";

const RACINE_API = fileURLToPath(new URL("../", import.meta.url));

function sources(dossier: string): string[] {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) return sources(chemin);
    return /\.ts$/.test(nom) && !/\.test\.ts$/.test(nom) ? [chemin] : [];
  });
}

describe("preuve de clic de l'équipe", () => {
  it("[C-557] une preuve de clic ne sert qu'une fois et pour sa seule clé", () => {
    const clic = creerClicEquipe({ role: "will", acteur: "acteur-1" }, "relanceImpaye");
    expect(consommerClic(clic, "nonPaiement30Jours")).toBe(false);
    expect(consommerClic(clic, "relanceImpaye")).toBe(true);
    expect(consommerClic(clic, "relanceImpaye")).toBe(false);
  });

  it("[C-557] une preuve fabriquée à la main est refusée", () => {
    expect(consommerClic({ role: "will", acteur: "x", cle: "relanceImpaye" } as never, "relanceImpaye")).toBe(false);
    expect(consommerClic(undefined as never, "relanceImpaye")).toBe(false);
  });

  it("[C-557] second_administrateur ne peut cliquer que notificationViolation", () => {
    expect(() => creerClicEquipe({ role: "second_administrateur", acteur: "acteur-2" }, "relanceImpaye")).toThrow();
    const clic = creerClicEquipe({ role: "second_administrateur", acteur: "acteur-2" }, "notificationViolation");
    expect(consommerClic(clic, "notificationViolation")).toBe(true);
  });

  it("[C-557] creerClicEquipe n'est importé que sous apps/api/src/routes/** (lecture des sources)", () => {
    const fautifs = sources(RACINE_API)
      .filter((f) => !f.endsWith(`${sep}courriel${sep}clic-equipe.ts`))
      .filter((f) => readFileSync(f, "utf8").includes("creerClicEquipe"))
      .map((f) => relative(RACINE_API, f))
      .filter((f) => !f.startsWith(`routes${sep}`));
    expect(fautifs).toEqual([]);
  });

  it("[C-557] aucun canal autre que l'e-mail n'est appelé en V1 (aucun import de canaux/ dans courriel/ ni portail/notifications)", () => {
    const concernes = sources(RACINE_API).filter((f) => {
      const r = relative(RACINE_API, f);
      return r.startsWith(`courriel${sep}`) || r === `portail${sep}notifications.ts` || r === `portail${sep}resume-hebdo.ts`;
    });
    expect(concernes.length).toBeGreaterThan(0);
    for (const f of concernes) expect(readFileSync(f, "utf8"), f).not.toMatch(/canaux\//);
  });
});
