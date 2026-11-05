import { describe, expect, it } from "vitest";
import { analyserModele, MODELE } from "./modele.js";
import { creerSchemaRequete, declarer, schemaParametres } from "./structure.js";

// Requêtes déclarées en structure (T2-37c, plan 05/11/2026) : aucun texte SQL n'entre. Chaque attaque des tours 1 à 5 est reformulée en objet et refusée par le schéma.
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const compter = (): Obj => ({ nom: "compterPersonnes", mode: "lecture", metadonnees: true, parametres: {}, forme: { type: "simple", table: "commun.personnes", sortie: { agregats: [{ fonction: "compter", alias: "total" }] } } });
const lister = (): Obj => ({
  nom: "listerListesProspects", mode: "lecture", metadonnees: false,
  parametres: { limite: { type: "entier", min: 1, max: 200, defaut: 50 } },
  forme: { type: "simple", table: "commun.listes_prospects", sortie: { lignes: [{ colonne: "id" }, { colonne: "nom" }, { colonne: "cree_le" }] }, tri: [{ colonne: "cree_le", sens: "desc" }], limite: { parametre: "limite" } },
});
const etat = (): Obj => ({
  nom: "etatDonnees", mode: "lecture", metadonnees: true, parametres: {},
  forme: { type: "composee", parties: [
    { alias: "personnes", table: "commun.personnes", agregat: { fonction: "compter", alias: "personnes" } },
    { alias: "taille_fichiers", table: "commun.index_fichiers", agregat: { fonction: "somme", colonne: "taille_octets", alias: "taille_fichiers" } },
  ] },
});
const modifie = (base: Obj, f: (o: Obj) => void): Obj => { const o = structuredClone(base); f(o); return o; };
const valide = (o: unknown) => creerSchemaRequete(MODELE).safeParse(o).success;
const refuse = (o: unknown, quoi = "") => expect(valide(o), quoi).toBe(false);

describe("requêtes déclarées : forme", () => {
  it("[B-173] les trois requêtes livrées, déclarées en structure, sont valides", () => {
    for (const o of [compter(), lister(), etat()]) expect(valide(o), String(o["nom"])).toBe(true);
    expect(declarer(lister()).nom).toBe("listerListesProspects");
  });

  it("[B-173] une écriture est refusée au chargement (v1 : lecture seulement)", () => {
    refuse(modifie(compter(), (o) => { o["mode"] = "ecriture"; }));
    refuse(modifie(compter(), (o) => { o["mode"] = "ecriture"; o["metadonnees"] = false; }));
  });

  it("[B-173] @isolation un champ sql, texte, where, filtre, expression ou toute clé inconnue est refusé à tout niveau", () => {
    for (const cle of ["sql", "texte", "where", "filtre", "expression", "inconnue"]) {
      refuse(modifie(lister(), (o) => { o[cle] = "1=1"; }), `racine ${cle}`);
      refuse(modifie(lister(), (o) => { o["forme"][cle] = "1=1"; }), `forme ${cle}`);
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"][cle] = "1"; }), `sortie ${cle}`);
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0][cle] = "1"; }), `colonne ${cle}`);
      refuse(modifie(lister(), (o) => { o["forme"]["tri"][0][cle] = "1"; }), `tri ${cle}`);
      refuse(modifie(lister(), (o) => { o["forme"]["limite"][cle] = "1"; }), `limite ${cle}`);
      refuse(modifie(lister(), (o) => { o["parametres"]["limite"][cle] = "1"; }), `paramètre ${cle}`);
      refuse(modifie(compter(), (o) => { o["forme"]["sortie"]["agregats"][0][cle] = "1"; }), `agrégat ${cle}`);
      refuse(modifie(etat(), (o) => { o["forme"]["parties"][0][cle] = "1"; }), `partie ${cle}`);
    }
    refuse(modifie(lister(), (o) => { o["forme"]["filtres"] = [{ colonne: "nom", operateur: "egal", parametre: "limite", valeur: "x" }]; }));
  });

  it("[B-173] OR, NOT, UNION, EXISTS, BETWEEN, commentaires et point-virgule dans un nom sont refusés", () => {
    for (const mauvais of ["nom OR 1=1", "nom IS NOT TRUE", "NOT nom", "id UNION SELECT 1", "EXISTS", "BETWEEN", "id--", "id;", "id/*x*/", "id INTERSECT x", "id EXCEPT x", "or"]) {
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["colonne"] = mauvais; }), `colonne ${mauvais}`);
      refuse(modifie(lister(), (o) => { o["forme"]["table"] = mauvais; }), `table ${mauvais}`);
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["alias"] = mauvais; }), `alias ${mauvais}`);
      refuse(modifie(lister(), (o) => { o["nom"] = mauvais; }), `nom ${mauvais}`);
      refuse(modifie(lister(), (o) => { o["parametres"] = { [mauvais]: { type: "entier", min: 1, max: 5 } }; o["forme"]["limite"] = { parametre: mauvais }; }), `paramètre ${mauvais}`);
    }
  });

  it("[B-173] un opérateur hors liste fermée est refusé", () => {
    const avecFiltre = (operateur: string) => modifie(lister(), (o) => { o["parametres"]["n"] = { type: "texte", max: 20 }; o["forme"]["filtres"] = [{ colonne: "nom", operateur, parametre: "n" }]; });
    expect(valide(avecFiltre("egal"))).toBe(true);
    for (const op of ["or", "OR", "=", "IS DISTINCT FROM", "~", "like", "ilike", "and", "", "egal ", "Egal"]) refuse(avecFiltre(op), op);
  });

  it("[B-173] @isolation table : liste d'une jointure, virgule, table dérivée, sans etablissement_id, inconnue, entre guillemets sont refusées", () => {
    for (const t of ["commun.personnes p, commun.listes_prospects l", "commun.personnes JOIN commun.listes_prospects", "(SELECT 1) x", "commun.entreprises", "commun.exclusions", "commun.etablissements", "commun.listes_prospects_personnes", "commun.inconnue", "\"commun\".\"personnes\"", "personnes", "commun.personnes ", "COMMUN.PERSONNES", "version_structure", "trace.evenements", "pg_catalog.pg_authid", ""]) {
      refuse(modifie(compter(), (o) => { o["forme"]["table"] = t; }), `table ${t}`);
    }
  });

  it("[B-173] @isolation etablissement_id n'est jamais nommé : sortie, alias, filtre, tri, paramètre", () => {
    refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["colonne"] = "etablissement_id"; }), "sortie");
    refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["alias"] = "etablissement_id"; }), "alias");
    refuse(modifie(lister(), (o) => { o["parametres"]["e"] = { type: "uuid" }; o["forme"]["filtres"] = [{ colonne: "etablissement_id", operateur: "egal", parametre: "e" }]; }), "filtre");
    refuse(modifie(lister(), (o) => { o["forme"]["tri"] = [{ colonne: "etablissement_id", sens: "asc" }]; }), "tri");
    refuse(modifie(etat(), (o) => { o["forme"]["parties"][1]["agregat"] = { fonction: "somme", colonne: "etablissement_id", alias: "x" }; }), "somme");
    for (const nom of ["etablissement_id", "etablissements", "etablissementId"]) {
      refuse(modifie(lister(), (o) => { o["parametres"] = { limite: o["parametres"]["limite"], [nom]: { type: "texte", max: 5 } }; }), `paramètre ${nom}`);
    }
  });

  it("[B-173] @isolation fonctions de lecture (table_to_xml, query_to_xml, row_to_json, to_jsonb, ts_stat, pg_read_file, current_setting) refusées partout", () => {
    for (const f of ["table_to_xml", "query_to_xml", "row_to_json", "to_jsonb", "ts_stat", "pg_read_file", "current_setting", "table_to_xml(0,0,0,'')", "pg_read_file('x')"]) {
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["colonne"] = f; }), `colonne ${f}`);
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["alias"] = f; }), `alias ${f}`);
      refuse(modifie(compter(), (o) => { o["forme"]["sortie"]["agregats"][0]["fonction"] = f; }), `fonction ${f}`);
      refuse(modifie(lister(), (o) => { o["parametres"]["n"] = { type: "texte", max: 5 }; o["forme"]["filtres"] = [{ colonne: "nom", operateur: f, parametre: "n" }]; }), `opérateur ${f}`);
    }
  });

  it("[B-173] @isolation la ligne entière est refusée : p, t, personnes, *, t.*, p::text", () => {
    for (const c of ["p", "t", "personnes", "*", "t.*", "p::text", "t.nom", "(t)", "count(p)"]) {
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["colonne"] = c; }), `colonne ${c}`);
      refuse(modifie(lister(), (o) => { o["forme"]["tri"][0]["colonne"] = c; }), `tri ${c}`);
    }
  });

  it("[B-173] @isolation préfixes et échappements E'', U&'', U&\"\\005f\", B'', X'', N'', antislash, guillemets doubles refusés dans un nom", () => {
    for (const c of ["E'x'", "U&'x'", "U&\"courriel\\005fchiffre\"", "B'1'", "X'ff'", "N'a'", "nom\\", "\"nom\"", "\"commun\".\"personnes\"", "nom'", "$$x$$", "$1"]) {
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["colonne"] = c; }), `colonne ${c}`);
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["alias"] = c; }), `alias ${c}`);
      refuse(modifie(lister(), (o) => { o["forme"]["table"] = c; }), `table ${c}`);
    }
  });

  it("[B-173] @isolation tour 5 : (expr).fonction, ('SELECT …').ts_stat, nom::text(1), nom::personnes, :, (, ), . dans un nom sont refusés", () => {
    for (const c of ["(nom).ts_stat", "('SELECT 1').ts_stat", "('SELECT * FROM commun.personnes').ts_stat", "nom::text(1)", "nom::personnes", "nom::text", "nom:", "(nom)", "nom)", "nom.x", "nom,id", "nom id", "nom\tid", "nom\nid"]) {
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["colonne"] = c; }), `colonne ${c}`);
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["alias"] = c; }), `alias ${c}`);
    }
  });

  it("[B-173] @isolation tour 5 : espaces Unicode et homoglyphes ne sont membres d'aucune liste (égalité exacte)", () => {
    const espaces = ["\u00a0", "\u2000", "\u2001", "\u2003", "\u200b", "\u2028", "\u2029", "\u3000", "\ufeff"];
    for (const e of espaces) {
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["colonne"] = `id${e}`; }), `colonne suffixe U+${e.charCodeAt(0).toString(16)}`);
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["colonne"] = `${e}id`; }), "colonne préfixe");
      refuse(modifie(lister(), (o) => { o["forme"]["table"] = `commun.listes_prospects${e}`; }), "table");
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["alias"] = `a${e}b`; }), "alias");
    }
    refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][1]["colonne"] = "n\u043eм"; }), "homoglyphe cyrillique");
    refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["colonne"] = "\u0456d"; }), "i cyrillique");
    refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["colonne"] = "ID"; }), "majuscules");
  });
});

describe("requêtes déclarées : colonnes chiffrées", () => {
  it("[B-172] une colonne chiffrée ou une empreinte est refusée en sortie, alias, filtre, tri et somme", () => {
    for (const c of ["courriel_chiffre", "courriel_empreinte", "telephone_chiffre", "telephone_empreinte", "empreinte"]) {
      refuse(modifie(lister(), (o) => { o["forme"]["table"] = "commun.personnes"; o["forme"]["sortie"]["lignes"][0]["colonne"] = c; o["forme"]["tri"] = []; }), `sortie ${c}`);
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["alias"] = c; }), `alias ${c}`);
      refuse(modifie(lister(), (o) => { o["forme"]["table"] = "commun.personnes"; o["parametres"]["n"] = { type: "texte", max: 9 }; o["forme"]["filtres"] = [{ colonne: c, operateur: "egal", parametre: "n" }]; }), `filtre ${c}`);
      refuse(modifie(lister(), (o) => { o["forme"]["table"] = "commun.personnes"; o["forme"]["tri"] = [{ colonne: c, sens: "asc" }]; }), `tri ${c}`);
      refuse(modifie(etat(), (o) => { o["forme"]["parties"][1]["agregat"] = { fonction: "somme", colonne: c, alias: "x" }; }), `somme ${c}`);
      refuse(modifie(etat(), (o) => { o["forme"]["parties"][1]["agregat"] = { fonction: "compter", alias: c }; }), `alias d'agrégat ${c}`);
    }
    refuse(modifie(lister(), (o) => { o["forme"]["table"] = "commun.index_fichiers"; o["forme"]["sortie"]["lignes"] = [{ colonne: "empreinte" }]; o["forme"]["tri"] = []; }), "empreinte d'index_fichiers");
  });

  it("[B-172] une colonne bytea ajoutée au modèle est refusée sans changer le code", () => {
    const sql = 'CREATE TABLE "commun"."personnes" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\t"etablissement_id" uuid NOT NULL,\n\t"nom" text NOT NULL,\n\t"note_secrete" "bytea"\n);\n';
    const modele = analyserModele(sql);
    expect(modele.chiffrees.has("note_secrete")).toBe(true);
    const o = modifie(compter(), (x) => { x["forme"]["sortie"] = { lignes: [{ colonne: "note_secrete" }], }; x["forme"]["limite"] = { fixe: 5 }; x["metadonnees"] = false; });
    expect(creerSchemaRequete(modele).safeParse(o).success).toBe(false);
    expect(creerSchemaRequete(modele).safeParse(modifie(o, (x) => { x["forme"]["sortie"] = { lignes: [{ colonne: "nom" }] }; })).success).toBe(true);
  });

  it("[B-172] le modèle lit le type de chaque colonne et la présence d'etablissement_id", () => {
    const t = MODELE.tables.get("commun.listes_prospects")!;
    expect(t.aEtablissement).toBe(true);
    expect(t.colonnes.get("cree_le")?.type).toBe("timestamp with time zone");
    expect(MODELE.tables.get("commun.index_fichiers")!.colonnes.get("taille_octets")?.type).toBe("bigint");
    expect(MODELE.tables.get("commun.entreprises")!.aEtablissement).toBe(false);
    expect(MODELE.tables.get("commun.personnes")!.colonnes.get("courriel_chiffre")?.chiffree).toBe(true);
  });
});

describe("requêtes déclarées : composée, métadonnées, prototype, limite, paramètres", () => {
  it("[B-173] composée : partie sans table, sans agrégat, plus de 5 parties, alias répétés sont refusés", () => {
    refuse(modifie(etat(), (o) => { delete o["forme"]["parties"][0]["table"]; }), "sans table");
    refuse(modifie(etat(), (o) => { delete o["forme"]["parties"][0]["agregat"]; }), "sans agrégat");
    refuse(modifie(etat(), (o) => { o["forme"]["parties"][0]["agregat"] = { fonction: "lignes", alias: "x" }; }), "pas un agrégat");
    refuse(modifie(etat(), (o) => { o["forme"]["parties"] = [o["forme"]["parties"][0]]; }), "une seule partie");
    refuse(modifie(etat(), (o) => { o["forme"]["parties"] = Array.from({ length: 6 }, (_, i) => ({ alias: `a${i}`, table: "commun.personnes", agregat: { fonction: "compter", alias: `a${i}` } })); }), "six parties");
    refuse(modifie(etat(), (o) => { o["forme"]["parties"][1]["alias"] = "personnes"; o["forme"]["parties"][1]["agregat"]["alias"] = "personnes"; }), "alias répétés");
    refuse(modifie(etat(), (o) => { o["forme"]["parties"][1]["table"] = "commun.entreprises"; }), "table sans établissement");
  });

  it("[B-070] [C-006] metadonnees: true avec une sortie en lignes est refusé ; vrai seulement pour des agrégats", () => {
    refuse(modifie(lister(), (o) => { o["metadonnees"] = true; }), "lignes déclarées métadonnées");
    refuse(modifie(compter(), (o) => { o["forme"]["sortie"] = { lignes: [{ colonne: "nom" }] }; o["forme"]["limite"] = { fixe: 5 }; }), "lignes avec metadonnees vrai");
    expect(valide(modifie(compter(), (o) => { o["metadonnees"] = false; }))).toBe(true);
    expect(declarer(compter()).metadonnees).toBe(true);
  });

  it("[B-173] @isolation pollution de prototype : __proto__, constructor, prototype refusés comme nom de requête, paramètre, table, colonne", () => {
    for (const n of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) {
      refuse(modifie(lister(), (o) => { o["nom"] = n; }), `nom ${n}`);
      refuse(modifie(lister(), (o) => { o["forme"]["table"] = n; }), `table ${n}`);
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["colonne"] = n; }), `colonne ${n}`);
      refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][0]["alias"] = n; }), `alias ${n}`);
      refuse(modifie(lister(), (o) => { o["forme"]["limite"] = { parametre: n }; }), `limite ${n}`);
    }
    const hostile = JSON.parse('{"nom":"x","mode":"lecture","metadonnees":true,"parametres":{"__proto__":{"type":"uuid"}},"forme":{"type":"simple","table":"commun.personnes","sortie":{"agregats":[{"fonction":"compter","alias":"total"}]}}}') as unknown;
    refuse(hostile, "paramètre __proto__ (JSON)");
    refuse(JSON.parse('{"__proto__":{"sql":"x"},"nom":"x"}'), "racine __proto__");
    refuse(modifie(lister(), (o) => { o["parametres"] = { constructor: { type: "entier", min: 1, max: 5 } }; o["forme"]["limite"] = { parametre: "constructor" }; }), "paramètre constructor");
  });

  it("[B-173] limite : absente sur des lignes, 0, 201, 1.5, négative, chaîne sont refusés ; paramètre hors bornes à l'appel : refusé", () => {
    refuse(modifie(lister(), (o) => { delete o["forme"]["limite"]; }), "absente");
    for (const fixe of [0, 201, 1.5, -1, "5", null, Number.NaN, Infinity]) refuse(modifie(lister(), (o) => { o["forme"]["limite"] = { fixe }; }), `fixe ${String(fixe)}`);
    expect(valide(modifie(lister(), (o) => { o["forme"]["limite"] = { fixe: 200 }; o["parametres"] = {}; }))).toBe(true);
    refuse(modifie(lister(), (o) => { o["parametres"]["limite"].max = 201; }), "borne du paramètre 201");
    refuse(modifie(lister(), (o) => { o["parametres"]["limite"].min = 0; }), "borne du paramètre 0");
    refuse(modifie(compter(), (o) => { o["forme"]["limite"] = { fixe: 5 }; }), "limite avec agrégats");
    const schema = schemaParametres(declarer(lister()));
    expect(schema.parse({}).limite).toBe(50);
    for (const l of [0, 201, 1.5, -1, "5", [1, 2], null]) expect(schema.safeParse({ limite: l }).success, String(l)).toBe(false);
    expect(schema.parse({ limite: 7, tenantId: "x" })).toEqual({ limite: 7 });
  });

  it("[B-173] paramètre de type incompatible avec la colonne, inutilisé ou non déclaré : refusé ; liste_uuid de plus de 100 éléments à l'appel : refusée", () => {
    const f = (colonne: string, operateur: string, type: Obj) => modifie(lister(), (o) => { o["parametres"]["p"] = type; o["forme"]["filtres"] = [{ colonne, operateur, parametre: "p" }]; });
    expect(valide(f("nom", "egal", { type: "texte", max: 20 }))).toBe(true);
    expect(valide(f("id", "egal", { type: "uuid" }))).toBe(true);
    expect(valide(f("cree_le", "superieur", { type: "horodatage" }))).toBe(true);
    expect(valide(f("id", "dans", { type: "liste_uuid", max: 100 }))).toBe(true);
    refuse(f("id", "egal", { type: "texte", max: 20 }), "texte sur uuid");
    refuse(f("cree_le", "egal", { type: "entier", min: 1, max: 5 }), "entier sur cree_le");
    refuse(f("nom", "egal", { type: "uuid" }), "uuid sur text");
    refuse(f("nom", "dans", { type: "liste_uuid", max: 5 }), "liste_uuid sur text");
    refuse(f("id", "egal", { type: "liste_uuid", max: 5 }), "liste_uuid sans dans");
    refuse(f("id", "dans", { type: "uuid" }), "dans sans liste");
    refuse(f("id", "dans", { type: "liste_uuid", max: 101 }), "liste de 101");
    refuse(f("nom", "egal", { type: "texte", max: 201 }), "texte de 201");
    refuse(modifie(lister(), (o) => { o["parametres"]["inutile"] = { type: "uuid" }; }), "paramètre déclaré non utilisé");
    refuse(modifie(lister(), (o) => { o["forme"]["limite"] = { parametre: "absent" }; }), "paramètre utilisé non déclaré");
    refuse(modifie(lister(), (o) => { o["forme"]["filtres"] = [{ colonne: "nom", operateur: "egal" }]; }), "egal sans paramètre");
    refuse(modifie(lister(), (o) => { o["forme"]["filtres"] = [{ colonne: "nom", operateur: "est_nul", parametre: "limite" }]; }), "est_nul avec paramètre");
    refuse(modifie(lister(), (o) => { o["parametres"]["limite"].defaut = "x"; }), "défaut d'un autre type");
    const liste = schemaParametres(declarer(f("id", "dans", { type: "liste_uuid", max: 100 })));
    const u = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    expect(liste.safeParse({ p: Array.from({ length: 100 }, (_, i) => u(i)) }).success).toBe(true);
    expect(liste.safeParse({ p: Array.from({ length: 101 }, (_, i) => u(i)) }).success).toBe(false);
    expect(liste.safeParse({ p: ["pas un uuid"] }).success).toBe(false);
  });

  it("[B-173] filtres : plus de 10, sortie vide, plus de 30 colonnes, plus de 3 tris, tri avec agrégats sont refusés ; variantes validées par le même schéma", () => {
    refuse(modifie(compter(), (o) => { o["forme"]["sortie"] = { agregats: [] }; }), "agrégats vides");
    refuse(modifie(lister(), (o) => { o["forme"]["sortie"] = { lignes: [] }; }), "lignes vides");
    refuse(modifie(lister(), (o) => { o["forme"]["sortie"] = { lignes: [{ colonne: "id" }], agregats: [{ fonction: "compter", alias: "n" }] }; }), "les deux sorties");
    refuse(modifie(lister(), (o) => { o["forme"]["tri"] = [1, 2, 3, 4].map(() => ({ colonne: "nom", sens: "asc" })); }), "quatre tris");
    refuse(modifie(compter(), (o) => { o["forme"]["tri"] = [{ colonne: "nom", sens: "asc" }]; }), "tri avec agrégats");
    refuse(modifie(lister(), (o) => { o["forme"]["tri"] = [{ colonne: "nom", sens: "ASC" }]; }), "sens hors liste");
    refuse(modifie(lister(), (o) => { o["forme"]["sortie"]["lignes"][1]["alias"] = "id"; }), "alias répété");
    refuse(modifie(lister(), (o) => { o["variantes"] = [{ depuis: 2, forme: { type: "simple", table: "commun.personnes", sortie: { lignes: [{ colonne: "courriel_chiffre" }] }, limite: { fixe: 5 } } }]; }), "variante avec colonne chiffrée");
    refuse(modifie(lister(), (o) => { o["variantes"] = [{ depuis: 2, sql: "SELECT 1", forme: lister()["forme"] }]; }), "variante avec sql");
    refuse(modifie(lister(), (o) => { o["variantes"] = [{ depuis: 2, forme: { type: "simple", table: "commun.listes_prospects", sortie: { lignes: [{ colonne: "id" }] }, limite: { parametre: "limite" } } }]; }), "variante qui change les colonnes rendues");
    expect(valide(modifie(lister(), (o) => { o["variantes"] = [{ depuis: 2, forme: lister()["forme"] }]; }))).toBe(true);
  });
});
