import { describe, expect, it } from "vitest";
import { ACTION_PAR_ROUTE, fusionnerActions } from "./actions-par-route.js";

// Copie littérale des déclarations d'avant la bascule (T-REG-2) : objectContaining, jamais l'égalité, pour ne pas recréer un compteur partagé.
const AVANT = {
  "POST /api/console/v1/a-trancher/:id/appliquer": "modifier_reglages",
  "POST /api/console/v1/a-trancher/:id/ecarter": "modifier_reglages",
  "GET /api/console/v1/canaux/echecs": "lire",
  "POST /api/console/v1/canaux/echecs/:tenantId/:id/renvoyer": "relancer",
  "POST /api/console/v1/clients/:id/base/reprendre": "relancer",
  "GET /api/console/v1/clients": "lire",
  "GET /api/console/v1/clients/vues": "lire",
  "POST /api/console/v1/clients/vues": "lire",
  "POST /api/console/v1/clients/export": "lire",
  "POST /api/console/v1/clients/:tenantId/instances": "modifier_reglages",
  "POST /api/console/v1/clients/:tenantId/instances/:id/activation": "modifier_reglages",
  "POST /api/console/v1/clients/:tenantId/instances/:id/tests-a-blanc": "modifier_reglages",
  "GET /api/console/v1/clients/:id/fiche": "lire",
  "GET /api/console/v1/clients/:id/gel": "lire",
  "GET /api/console/v1/clients/:id/notes": "lire",
  "POST /api/console/v1/clients/:id/notes": "modifier_reglages",
  "POST /api/console/v1/clients/:id/notes/:idNote/epingler": "modifier_reglages",
  "POST /api/console/v1/clients/:id/notes/appel-et-cloture": "modifier_reglages",
  "POST /api/console/v1/clients/:id/gel": "disjoncteur",
  "POST /api/console/v1/clients/:id/gel/:idGel/lever": "disjoncteur",
  "POST /api/console/v1/instances/:id/reglages": "modifier_reglages",
  "POST /api/console/v1/instances/:id/reglages/revenir": "modifier_reglages",
  "GET /api/console/v1/instances/:id/reglages/versions": "lire",
  "POST /api/console/v1/journal/:id/annuler": "modifier_reglages",
  "GET /equipe/journal": "journal_complet",
};

describe("actions par route (T-REG-2)", () => {
  it("[LOT3-droits] la fusion des fragments refuse une route déclarée dans deux fichiers", () => {
    const a = { nom: "a.ts", module: { default: { "GET /x": "lire" } } };
    const b = { nom: "b.ts", module: { default: { "GET /x": "lire" } } };
    expect(() => fusionnerActions([a, b])).toThrow(/GET \/x/);
    expect(fusionnerActions([a, { nom: "b.ts", module: { default: { "GET /y": "lire" } } }])).toEqual({ "GET /x": "lire", "GET /y": "lire" });
  });

  it("[LOT3-droits] la fusion refuse une action hors de la liste fermée, un nom de fichier hors forme et un fragment qui n'est pas un objet", () => {
    expect(() => fusionnerActions([{ nom: "a.ts", module: { default: { "GET /x": "tout_faire" } } }])).toThrow(/tout_faire/);
    expect(() => fusionnerActions([{ nom: "A.ts", module: { default: { "GET /x": "lire" } } }])).toThrow(/hors forme/);
    expect(() => fusionnerActions([{ nom: "a.test.ts", module: { default: { "GET /x": "lire" } } }])).toThrow(/hors forme/);
    expect(() => fusionnerActions([{ nom: "a.ts", module: { default: ["lire"] } }])).toThrow(/objet/);
    expect(() => fusionnerActions([{ nom: "a.ts", module: { default: null } }])).toThrow(/objet/);
    expect(() => fusionnerActions([{ nom: "a.ts", module: {} }])).toThrow(/objet/);
    expect(() => fusionnerActions([{ nom: "a.ts", module: { default: { "x /y": "lire" } } }])).toThrow(/clé/);
    expect(() => fusionnerActions([{ nom: "a.ts", module: { default: { "GET y": "lire" } } }])).toThrow(/clé/);
  });

  it("[LOT3-droits] le registre réel est gelé, trié et contient les 21 déclarations d'avant la bascule avec leur action", () => {
    expect(Object.isFrozen(ACTION_PAR_ROUTE)).toBe(true);
    const cles = Object.keys(ACTION_PAR_ROUTE);
    expect(cles).toEqual([...cles].sort());
    expect(ACTION_PAR_ROUTE).toEqual(expect.objectContaining(AVANT));
  });
});
