import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { COLONNES_CHIFFREES, LISTE_BLANCHE, verifierListeBlanche, type Requete } from "./requetes/liste.js";
import { creerServiceDonnees, type PortsDonnees, type SessionDonnees } from "./service.js";

// Durcissements de la liste blanche (T2-37c, étape 5) : colonnes chiffrées lues dans le MODÈLE, texte SQL et alias contrôlés, filtre en position sûre, numéros $n accordés.
const base: Requete = { nom: "x", schema: z.object({}), sql: "SELECT id FROM commun.personnes WHERE {{filtre}}", mode: "lecture", metadonnees: true, parEtablissement: true, colonnes: ["id"], valeurs: () => [] };
const refuse = (sql: string, extra: Partial<Requete> = {}) => () => verifierListeBlanche({ x: { ...base, sql, ...extra } });

describe("liste blanche : colonnes chiffrées", () => {
  it("[B-172] la liste fermée des colonnes chiffrées vient du modèle SQL, empreintes comprises", () => {
    const modele = readFileSync(fileURLToPath(new URL("../../drizzle-cli/0000_modele_base_client.sql", import.meta.url)), "utf8");
    const binaires = [...modele.matchAll(/^\s*"([a-z_]+)" "bytea"/gm)].map((m) => m[1]!);
    expect(binaires.length).toBeGreaterThan(0);
    for (const c of binaires) expect(COLONNES_CHIFFREES.has(c), c).toBe(true);
    for (const c of ["courriel_chiffre", "courriel_empreinte", "telephone_chiffre", "telephone_empreinte", "empreinte"]) expect(COLONNES_CHIFFREES.has(c), c).toBe(true);
  });

  it("[B-172] une colonne chiffrée ou une empreinte rendue est refusée, même sans suffixe (empreinte)", () => {
    expect(refuse("SELECT empreinte FROM commun.exclusions WHERE {{filtre}}", { colonnes: ["empreinte"] })).toThrow();
    expect(refuse("SELECT courriel_chiffre FROM commun.personnes WHERE {{filtre}}", { colonnes: ["courriel_chiffre"] })).toThrow();
  });

  it("[B-172] le texte SQL ne nomme jamais une colonne chiffrée, ni par alias, ni par étoile", () => {
    expect(refuse("SELECT courriel_chiffre AS id FROM commun.personnes WHERE {{filtre}}")).toThrow();
    expect(refuse("SELECT p.telephone_empreinte AS id FROM commun.personnes p WHERE {{filtre}}")).toThrow();
    expect(refuse("SELECT * FROM commun.personnes WHERE {{filtre}}")).toThrow();
    expect(refuse("SELECT p.* FROM commun.personnes p WHERE {{filtre}}")).toThrow();
    expect(refuse("SELECT encode(empreinte, 'hex') AS id FROM commun.exclusions WHERE {{filtre}}")).toThrow();
  });

  it("[B-172] un alias hors de la liste des colonnes rendues est refusé", () => {
    expect(refuse("SELECT id AS autre FROM commun.personnes WHERE {{filtre}}")).toThrow();
    expect(refuse("SELECT id AS id FROM commun.personnes WHERE {{filtre}}")).not.toThrow();
  });
});

describe("liste blanche : filtre d'établissement", () => {
  it("[B-173] le filtre est en position de condition conjonctive : WHERE ou AND, jamais après un OR", () => {
    expect(refuse("SELECT id FROM commun.personnes WHERE {{filtre}}")).not.toThrow();
    expect(refuse("SELECT id FROM commun.personnes WHERE nom = 'a' AND {{filtre}}")).not.toThrow();
    expect(refuse("SELECT id FROM commun.personnes WHERE nom IS NULL OR {{filtre}}")).toThrow();
    expect(refuse("SELECT id FROM commun.personnes WHERE {{filtre}} OR nom IS NULL")).toThrow();
    expect(refuse("SELECT id FROM commun.personnes WHERE nom = 'a' or {{filtre}}")).toThrow();
    expect(refuse("SELECT id FROM commun.personnes WHERE ({{filtre}})")).toThrow();
    expect(refuse("SELECT id FROM commun.personnes GROUP BY {{filtre}}")).toThrow();
  });

  it("[B-173] contournements : IS, NOT, UNION, sous-requête non corrélée, tout est refusé (liste blanche de formes)", () => {
    const f = "{{filtre}}";
    for (const sql of [
      `SELECT id FROM commun.personnes WHERE ${f} IS NOT TRUE`,
      `SELECT id FROM commun.personnes WHERE ${f} IS FALSE`,
      `SELECT id FROM commun.personnes WHERE ${f} IS DISTINCT FROM true`,
      `SELECT id FROM commun.personnes WHERE ${f} IS NULL`,
      `SELECT id FROM commun.personnes WHERE NOT ${f}`,
      `SELECT id FROM commun.personnes WHERE ${f} UNION SELECT id FROM commun.personnes`,
      `SELECT id FROM commun.personnes WHERE ${f} INTERSECT SELECT id FROM commun.personnes`,
      `SELECT id FROM commun.personnes WHERE ${f} EXCEPT SELECT id FROM commun.exclusions`,
      `SELECT id FROM commun.personnes WHERE EXISTS (SELECT 1 FROM commun.exclusions WHERE ${f})`,
      `SELECT id FROM commun.personnes WHERE id IN (SELECT id FROM commun.exclusions WHERE ${f})`,
      `SELECT id FROM commun.personnes WHERE ${f} = true`,
      `SELECT id FROM commun.personnes WHERE ${f}::boolean`,
      `SELECT id FROM commun.personnes WHERE x BETWEEN 1 AND ${f}`,
      `SELECT id FROM commun.personnes WHERE ${f} -- fin`,
      `SELECT id FROM commun.personnes WHERE ${f}; SELECT id FROM commun.personnes`,
      `SELECT id FROM commun.personnes UNION SELECT id FROM commun.personnes WHERE ${f}`,
      `SELECT id FROM commun.personnes ORDER BY id`,
      `SELECT 1 AS id WHERE id IN (SELECT id FROM commun.exclusions WHERE ${f})`,
    ]) expect(refuse(sql), sql).toThrow();
  });

  it("[B-173] formes permises : conjonctions AND de premier niveau, ORDER BY, LIMIT, sous-requête de projection", () => {
    const f = "{{filtre}}";
    expect(refuse(`SELECT id FROM commun.personnes WHERE ${f} AND nom = 'a' ORDER BY id LIMIT $1`)).not.toThrow();
    expect(refuse(`SELECT (SELECT count(*)::int FROM commun.personnes WHERE ${f}) AS id`)).not.toThrow();
  });

  it("[B-173] @isolation le modèle n'admet qu'un seul FROM : ni virgule, ni JOIN, ni table dérivée, filtre dans toute sous-requête, colonne qualifiée", () => {
    const f = "{{filtre}}";
    for (const sql of [
      `SELECT p.id FROM commun.personnes p, commun.listes_prospects l WHERE ${f}`,
      `SELECT p.id FROM commun.personnes p JOIN commun.listes_prospects l ON true WHERE ${f}`,
      `SELECT p.id FROM commun.personnes p CROSS JOIN commun.listes_prospects l WHERE ${f}`,
      `SELECT x.id FROM (SELECT l.nom AS id, e.id etablissement_id FROM commun.listes_prospects l, commun.etablissements e) x WHERE ${f}`,
      `SELECT x.id FROM (SELECT l.nom AS id FROM commun.listes_prospects l WHERE ${f}) x`,
      `SELECT (SELECT id FROM commun.personnes WHERE ${f}) AS id, (SELECT count(*)::int FROM commun.personnes) AS total`,
      `SELECT p.id, p.etablissement_id FROM commun.personnes p WHERE ${f}`,
    ]) expect(refuse(sql, { colonnes: ["id", "total"] }), sql).toThrow();
    // Le témoin OR reste refusé.
    expect(refuse(`SELECT id FROM commun.personnes WHERE ${f} AND (nom = 'a' OR nom = 'b')`)).toThrow();
  });

  it("[B-173] @isolation colonne qualifiée : aucune sous-requête quand le SELECT de premier niveau a un FROM (corrélation sur etablissement_id)", () => {
    const f = "{{filtre}}";
    for (const sql of [
      `SELECT (SELECT count(*)::int FROM commun.entreprises WHERE ${f}) AS total FROM commun.personnes WHERE ${f} LIMIT 1`,
      `SELECT p.id FROM commun.personnes p WHERE ${f} AND p.id = (SELECT max(e.id) FROM commun.entreprises e WHERE ${f})`,
      `SELECT (SELECT count(*)::int FROM commun.personnes WHERE ${f}) AS total FROM commun.personnes WHERE ${f}`,
    ]) expect(refuse(sql, { colonnes: ["id", "total"] }), sql).toThrow();
  });

  it("[B-173] @isolation fonctions hors liste fermée et ligne entière refusées (table_to_xml, query_to_xml, row_to_json, alias seul)", () => {
    const f = "{{filtre}}";
    for (const sql of [
      `SELECT table_to_xml('commun.personnes', true, false, '') AS id FROM commun.personnes WHERE ${f}`,
      `SELECT query_to_xml('select 1', true, false, '') AS id FROM commun.personnes WHERE ${f}`,
      `SELECT row_to_json(p) AS id FROM commun.personnes p WHERE ${f}`,
      `SELECT p AS id FROM commun.personnes p WHERE ${f}`,
      `SELECT to_jsonb(p) AS id FROM commun.personnes p WHERE ${f}`,
    ]) expect(refuse(sql), sql).toThrow();
    expect(refuse(`SELECT lower(nom) AS id, count(*)::int AS total FROM commun.personnes p WHERE ${f}`, { colonnes: ["id", "total"] })).not.toThrow();
  });

  it("[B-173] formes valides conservées : un FROM, une sous-requête de projection filtrée, tables qualifiées", () => {
    const f = "{{filtre}}";
    expect(refuse(`SELECT p.id FROM commun.personnes p WHERE ${f} ORDER BY p.id LIMIT $1`)).not.toThrow();
    expect(refuse(`SELECT (SELECT count(*)::int FROM commun.personnes WHERE ${f}) AS id, (SELECT count(*)::int FROM commun.index_fichiers WHERE ${f}) AS total`, { colonnes: ["id", "total"] })).not.toThrow();
  });

  it("[B-173] OR n'est permis nulle part dans une requête filtrée par établissement", () => {
    expect(refuse("SELECT id FROM commun.personnes WHERE {{filtre}} AND (nom = 'a' OR nom = 'b')")).toThrow();
  });

  it("[B-173] @isolation les numéros $n du texte final sont accordés au nombre de valeurs envoyées", async () => {
    const vues: unknown[][] = [];
    const ports = (): PortsDonnees => ({ base: async () => ({ nomBase: "cli_1111", etat: "active" }), ouvrir: async () => ({ requete: async (_t, v) => { vues.push(v); return []; }, fermer: async () => {} }), accordValide: async () => false, vueRangee: async () => undefined, maintenant: () => new Date("2026-11-02T10:00:00Z") });
    const session: SessionDonnees = { tenantId: "11111111-1111-4111-8111-111111111111", role: "client", acteur: "u", etablissements: [] };
    const mal = (sql: string, valeurs: unknown[]): Requete => ({ ...base, sql, valeurs: () => valeurs });
    const code = async (r: Requete) => ((await creerServiceDonnees(ports(), { x: r }).executer(session, "x", {}).catch((e: unknown) => e)) as { code?: string }).code;
    expect(await code(mal("SELECT id FROM commun.personnes WHERE {{filtre}} LIMIT $1", [5]))).toBeUndefined();
    expect(await code(mal("SELECT id FROM commun.personnes WHERE {{filtre}} LIMIT $2", [5]))).toBe("schema_invalide");
    expect(await code(mal("SELECT id FROM commun.personnes WHERE {{filtre}} LIMIT $1", []))).toBe("schema_invalide");
    expect(await code(mal("SELECT id FROM commun.personnes WHERE {{filtre}}", [5]))).toBe("schema_invalide");
    expect(await code(mal("SELECT id FROM commun.personnes WHERE {{filtre}} LIMIT $1 OFFSET $3", [5, 6]))).toBe("schema_invalide");
  });

  it("[B-172] la liste blanche livrée passe tous les contrôles", () => {
    expect(() => verifierListeBlanche(LISTE_BLANCHE)).not.toThrow();
  });
});
