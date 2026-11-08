import { describe, expect, it } from "vitest";
import { CATALOGUE_EMAILS } from "../packages/contrats/src/messages/catalogue.ts";
import { TABLE_ENVOIS } from "../packages/contrats/src/notifications/table.ts";

// Test à la racine : packages/contrats ne dépend jamais de packages/design.
describe("[C-557] textes de la table des envois", () => {
  it("[C-557] chaque cleTexte existe dans le catalogue des e-mails", () => {
    for (const e of TABLE_ENVOIS) {
      if (e.cleTexte !== null) expect(Object.keys(CATALOGUE_EMAILS), e.evenement).toContain(e.cleTexte);
    }
  });

  it("[C-557] chaque envoi a un texte au catalogue", () => {
    for (const e of TABLE_ENVOIS) expect(e.cleTexte, e.evenement).not.toBeNull();
  });
});
