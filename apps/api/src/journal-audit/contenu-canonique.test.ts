import { describe, expect, it } from "vitest";
import { contenuCanonique, empreinteDe, type LigneJournal } from "./contenu-canonique.js";

const base: LigneJournal = {
  id: "7", tenant_id: "11111111-1111-4111-8111-111111111111", acteur: "agent-essai", action: "modification", entite: "contacts", entite_id: "c1",
  ancienne: '{"a": 1, "b": [1, 2]}', nouvelle: null, ip: "192.0.2.0/24", cree: "2026-10-31T10:00:00.123456Z", empreinte_precedente: null, empreinte: "",
};

describe("contenuCanonique", () => {
  it("[C-028] le contenu canonique est le tableau JSON de la fonction SQL audit_contenu, valeurs séparées par « , »", () => {
    expect(contenuCanonique(base)).toBe('[7, "11111111-1111-4111-8111-111111111111", "agent-essai", "modification", "contacts", "c1", {"a": 1, "b": [1, 2]}, null, "192.0.2.0/24", "2026-10-31T10:00:00.123456Z"]');
  });
  it("[C-028] les valeurs absentes s'écrivent null et le texte est échappé comme PostgreSQL (guillemet, barre, contrôle, accent gardé)", () => {
    const l = { ...base, tenant_id: null, entite_id: null, ip: null, acteur: 'a"b\\c\nd\u0001é' };
    expect(contenuCanonique(l)).toBe('[7, null, "a\\"b\\\\c\\nd\\u0001é", "modification", "contacts", null, {"a": 1, "b": [1, 2]}, null, null, "2026-10-31T10:00:00.123456Z"]');
  });
  it("[C-028] l'empreinte est sha256(précédente || contenu) en hexadécimal, une précédente absente vaut le texte vide", () => {
    const e = empreinteDe(null, base);
    expect(e).toMatch(/^[0-9a-f]{64}$/);
    expect(empreinteDe("abc", base)).not.toBe(e);
  });
});
