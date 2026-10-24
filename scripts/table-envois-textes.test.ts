import { describe, expect, it } from "vitest";
import { TABLE_ENVOIS } from "../packages/contrats/src/notifications/table.ts";
import { messages } from "../packages/design/src/textes/messages.fr.ts";

// Test à la racine : packages/contrats ne dépend jamais de packages/design.
describe("[C-557] textes de la table des envois", () => {
  it("[C-557] chaque cleTexte existe dans messages.fr.ts", () => {
    for (const e of TABLE_ENVOIS) {
      if (e.cleTexte !== null) expect(Object.keys(messages), e.evenement).toContain(e.cleTexte);
    }
  });

  // Le catalogue (T0-23) n'a pas encore les textes d'e-mail : écart noté, à combler au lot 6.
  it.fails("[C-557] @lot-6 chaque envoi a un texte au catalogue", () => {
    for (const e of TABLE_ENVOIS) expect(e.cleTexte, e.evenement).not.toBeNull();
  });
});
