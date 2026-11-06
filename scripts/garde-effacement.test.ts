import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifierEffacement } from "./garde-effacement.ts";

const D = "apps/api/src/fin-de-contrat/";
const f = (chemin: string, contenu: string) => ({ chemin: chemin.includes("/") ? chemin : D + chemin, contenu });
const fichiers = (dossier: string): string[] =>
  statSync(dossier, { throwIfNoEntry: false })?.isDirectory()
    ? readdirSync(dossier).flatMap((n) => (statSync(join(dossier, n)).isDirectory() ? fichiers(join(dossier, n)) : [join(dossier, n)]))
    : [];
const EFFACER = "export const gestionnaireEffacement = () => { const s = tx.source(); if (s.etat !== \"acceptee\") return; DROP DATABASE x; detruireCleClient(t); };";
const DECISION = "export const idTacheEffacement = (g) => g; export async function accepter() { mettreEnFile(idTacheEffacement(x)); }\nexport async function reexaminerApresLevee() { return 1; }";
const base = () => [f("effacer.ts", EFFACER), f("decision-proposition.ts", DECISION), f("proposition-suppression.ts", "export const creer = 1;"), f("machine.ts", "export const m = 1;")];

describe("garde de l'effacement (aucune échéance ne détruit)", () => {
  it("[A-257] la garde échoue si un job planifié par date atteint effacer.ts, une suppression, DELETE, DROP ou TRUNCATE", () => {
    expect(verifierEffacement(base())).toEqual([]);
    for (const [racine, contenu] of [
      ["proposition-suppression.ts", "import { x } from \"./effacer.js\";"],
      ["machine.ts", "import { x } from \"./decision-proposition.js\";"],
      ["proposition-suppression.ts", "import { y } from \"./intermediaire.js\";"],
      ["machine.ts", "await sql`DELETE FROM t`"],
      ["proposition-suppression.ts", "await sql`truncate t`"],
      ["machine.ts", "await p.supprimerBase(t)"],
      ["mettre-a-l-ecart.ts", "await sql`DROP TABLE t`"],
    ] as const) {
      const fichiersTest = [...base().filter((x) => !x.chemin.endsWith(racine)), f(racine, contenu), f("intermediaire.ts", "import { z } from \"./effacer.js\";")];
      expect(verifierEffacement(fichiersTest).length, `${racine} ${contenu}`).toBeGreaterThan(0);
    }
    expect(verifierEffacement([...base(), f("apps/api/src/ordonnanceur/x.ts", "import { e } from \"../fin-de-contrat/effacer.js\";")]).length).toBeGreaterThan(0);
  });
  it("[A-257] la garde échoue si l'appelant de effacerClient n'est pas le gestionnaire de l'événement d'acceptation", () => {
    expect(verifierEffacement([...base(), f("apps/api/src/routes/x.ts", "await gestionnaireEffacement(p)(job)")]).length).toBeGreaterThan(0);
    expect(verifierEffacement([f("effacer.ts", "export const gestionnaireEffacement = () => { DROP DATABASE x; };")]).join()).toMatch(/relire|acceptee/);
  });
  it("[A-257] la garde échoue si un job d'effacement est mis en file par autre chose qu'un clic, ou par le gestionnaire du gel levé", () => {
    expect(verifierEffacement([...base(), f("apps/api/src/gel/gel.ts", "mettreEnFile(idTacheEffacement(x))")]).length).toBeGreaterThan(0);
    const leve = "export async function reexaminerApresLevee() { mettreEnFile(idTacheEffacement(x)); }";
    expect(verifierEffacement([...base().filter((x) => !x.chemin.endsWith("decision-proposition.ts")), f("decision-proposition.ts", "export const idTacheEffacement = 1;\n" + leve)]).length).toBeGreaterThan(0);
  });
  it("[A-257] la garde trouve un DROP DATABASE ou un detruireCleClient hors de effacer.ts", () => {
    expect(verifierEffacement([...base(), f("apps/api/src/provisionnement/x.ts", "await sql`DROP DATABASE cli_x`")]).length).toBeGreaterThan(0);
    expect(verifierEffacement([...base(), f("apps/api/src/autre/x.ts", "await c.detruireCleClient(t)")]).length).toBeGreaterThan(0);
    expect(verifierEffacement([...base(), f("apps/api/src/coffre/enveloppe.ts", "async detruireCleClient() {}")])).toEqual([]);
    expect(verifierEffacement([...base(), f("apps/api/src/autre/x.test.ts", "DROP DATABASE x; detruireCleClient()")])).toEqual([]);
  });
  it("[A-257] les fichiers réels du dépôt passent la garde", () => {
    const racine = new URL("..", import.meta.url).pathname;
    const reels = fichiers(join(racine, "apps/api/src")).map((p) => f(p.slice(racine.length), readFileSync(p, "utf8")));
    expect(reels.some((x) => x.chemin.endsWith("fin-de-contrat/effacer.ts"))).toBe(true);
    expect(verifierEffacement(reels)).toEqual([]);
  });
});
