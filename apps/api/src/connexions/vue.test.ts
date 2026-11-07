import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { REQUETE_CONNEXIONS, lireLignesConnexions, versVues, type LigneConnexion } from "./vue.js";

// Vue des connexions d'un client (T3-17a) : requête constante aux colonnes nommées, projection clé par clé.
const MARQUEUR = "MARQUEUR-" + randomBytes(8).toString("hex");
const A = "11111111-1111-4111-8111-111111111111";
const ligne = (extra: Record<string, unknown> = {}): LigneConnexion =>
  ({
    id: "c1", outil: "messagerie", connecteur: "microsoft365", etat: "active",
    expire_le: "2026-12-01T09:30:45.000Z", dernier_test_le: "2026-11-07T10:42:37.123+02:00",
    automatisation_code: "REL-001", automatisation_nom: "Relance des devis",
    contact_nom: "Camille Test", contact_role: "technique", ...extra,
  }) as LigneConnexion;

describe("vue des connexions", () => {
  it("[C-013] la requête de la vue nomme ses colonnes et ne cite jamais reference_coffre, portee ni « * »", () => {
    expect(REQUETE_CONNEXIONS).not.toMatch(/reference_coffre|portee|organisation_id|\*/);
    expect(REQUETE_CONNEXIONS).toMatch(/c\.outil/);
  });

  it("[C-013] chaque table de la requête est filtrée par le client demandé", () => {
    const tables = [...REQUETE_CONNEXIONS.matchAll(/\b(?:FROM|JOIN)\s+(\w+)\s+(\w+)/g)].map((m) => ({ table: m[1] as string, alias: m[2] as string }));
    expect(tables.map((t) => t.table).sort()).toEqual(["automatisations", "connexions", "connexions_instances", "contacts", "instances"]);
    for (const t of tables.filter((x) => x.table !== "automatisations")) expect(REQUETE_CONNEXIONS, t.table).toContain(`${t.alias}.tenant_id = $1`);
  });

  it("[C-013] la lecture passe le client en seul paramètre et rend les lignes du dépôt", async () => {
    const vues: { sql: string; params: unknown[] }[] = [];
    const tx = { query: async (sql: string, params: unknown[]) => { vues.push({ sql, params }); return { rows: [ligne()] }; } };
    expect(await lireLignesConnexions(tx, A)).toEqual([ligne()]);
    expect(vues).toEqual([{ sql: REQUETE_CONNEXIONS, params: [A] }]);
  });

  it("[B-042] chaque connexion rend outil, connecteur, état, expiration, dernier test, automatisations et personne à contacter, clés exactes", () => {
    const [v] = versVues([ligne()]);
    expect(Object.keys(v ?? {}).sort()).toEqual(["a_contacter", "automatisations", "connecteur", "dernier_test", "etat", "expire_le", "id", "outil"]);
    expect(Object.keys(v?.dernier_test ?? {}).sort()).toEqual(["code", "le", "resultat"]);
    expect(v?.automatisations).toEqual([{ code: "REL-001", nom: "Relance des devis" }]);
  });

  it("[B-042] une connexion liée à deux automatisations est rendue une seule fois, sans doublon", () => {
    const vues = versVues([ligne(), ligne({ automatisation_code: "REL-002", automatisation_nom: "Rappel de rendez-vous" }), ligne({ id: "c2", automatisation_code: null, automatisation_nom: null })]);
    expect(vues.map((v) => v.id)).toEqual(["c1", "c2"]);
    expect(vues[0]?.automatisations.map((a) => a.code)).toEqual(["REL-001", "REL-002"]);
    expect(vues[1]?.automatisations).toEqual([]);
  });

  it("[B-044] une ligne brute qui porte contenu, reference_coffre ou organisation_id ne fait sortir aucune de ces clés", () => {
    const v = versVues([ligne({ reference_coffre: `bao:clients/${A}/${MARQUEUR}`, organisation_id: A, contenu: MARQUEUR, portee: "lecture", contact_email: "camille@exemple.fr" })]);
    const texte = JSON.stringify(v);
    expect(texte).not.toContain(MARQUEUR);
    expect(texte).not.toContain("reference_coffre");
    expect(texte).not.toContain("organisation_id");
    expect(texte).not.toContain("camille@exemple.fr");
  });

  it("[B-042] la personne à contacter est le contact technique, sinon le principal, nom et rôle seulement", () => {
    expect(REQUETE_CONNEXIONS).toMatch(/role IN \('technique', 'principal'\)/);
    expect(REQUETE_CONNEXIONS).toMatch(/ORDER BY \(\w+\.role = 'technique'\) DESC, \w+\.cree_le/);
    expect(REQUETE_CONNEXIONS).not.toMatch(/email/);
    expect(versVues([ligne({ contact_role: "principal" })])[0]?.a_contacter).toEqual({ nom: "Camille Test", role: "principal" });
    expect(versVues([ligne({ contact_nom: null, contact_role: null })])[0]?.a_contacter).toBeNull();
  });

  it("[B-042] expiration et dernier test sont rendus à la minute en UTC", () => {
    const [v] = versVues([ligne({ expire_le: new Date("2026-12-01T09:30:45.000Z") })]);
    expect(v?.dernier_test.le).toBe("2026-11-07T08:42Z");
    expect(v?.expire_le).toBe("2026-12-01T09:30Z");
    const [vide] = versVues([ligne({ expire_le: null, dernier_test_le: null })]);
    expect(vide?.expire_le).toBeNull();
    expect(vide?.dernier_test.le).toBeNull();
  });

  it("[B-042] le résultat du dernier test vient de l'état, et le code est toujours null tant que la base ne le range pas", () => {
    const resultat = (etat: string) => versVues([ligne({ etat, code: MARQUEUR, dernier_test_code: MARQUEUR })])[0]?.dernier_test;
    expect(resultat("active")).toEqual({ le: "2026-11-07T08:42Z", resultat: "ok", code: null });
    expect(resultat("en_echec")?.resultat).toBe("echec");
    expect(resultat("expiree")?.resultat).toBe("echec");
    expect(resultat("a_tester")?.resultat).toBeNull();
    expect(resultat("revoquee")?.resultat).toBeNull();
    expect(JSON.stringify(resultat("en_echec"))).not.toContain(MARQUEUR);
  });
});
