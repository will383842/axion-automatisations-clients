import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { EXCEPTIONS_UNICITE, TABLES_COMMUNES } from "../../../../../packages/contrats/src/c5/invariants.ts";
import { TABLES_CLIENT, TABLES_COMMUNES_SCHEMA } from "./aides.ts";
import {
  audits, besoins, cellules, demandes, notes, outilsClient, propositions, propositionsAutomatisations, registreTraitements, THEME_AXION, themeEffectif, themesClient,
  typeNote,
} from "./suivi.ts";

// Contrôles sans base de données du schéma et de la migration 0011 (T2-07, ADR 0055) ; les essais contre PostgreSQL sont dans db/suivi.int.test.ts (job socle-integration).
const lire = (chemin: string) => readFileSync(new URL(chemin, import.meta.url), "utf8");
const migration = lire("../../../drizzle/0011_suivi.sql");
const adr = lire("../../../../../docs/adr/0055-suivi-notes-demandes-cellules-theme-registre.md");
const empreintes = JSON.parse(lire("../../../../../scripts/garde-migrations-fonctions.json")) as { fonctions: { nom: string; fichier: string }[] };
type Table = Parameters<typeof getTableConfig>[0];
const colonnes = (t: Table) => getTableConfig(t).columns.map((c) => c.name);
const types = (t: Table) => getTableConfig(t).columns.map((c) => c.getSQLType());
const uniques = (t: Table) => getTableConfig(t).uniqueConstraints.map((u) => u.columns.map((c) => c.name));
const sqlDe = (c: { value: Parameters<PgDialect["sqlToQuery"]>[0] }) => new PgDialect().sqlToQuery(c.value).sql;
// Les colonnes d'un CHECK de schéma sont rendues « "table"."colonne" » : on retire le préfixe pour comparer au texte du SQL.
const verifications = (t: Table) => getTableConfig(t).checks.map((c) => sqlDe(c).replace(/"[a-z_]+"\./g, ""));
const CLIENT = ["notes", "demandes", "themes_client", "outils_client", "audits_client", "besoins", "propositions", "propositions_automatisations"];
const COMMUNES = ["cellules", "registre_traitements"];
const ACTEUR = "NULLIF(current_setting('app.acteur', true), '')";

describe("suivi : entités de la base commune (T2-07)", () => {
  it("[A-132] une note garde auteur, texte, type et date ; le texte est court et borné ; la note ne se modifie ni ne se supprime", () => {
    expect(colonnes(notes)).toEqual(expect.arrayContaining(["organisation_id", "auteur", "texte", "type", "cree_le"]));
    expect(typeNote.enumValues).toEqual(["appel", "demande", "incident"]);
    expect(verifications(notes).some((c) => c.includes('char_length("texte") BETWEEN 1 AND 1000'))).toBe(true);
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE "public"."notes" TO console_app;');
    expect(migration).not.toMatch(/GRANT UPDATE[^;]*ON TABLE "public"\."notes"/);
    expect(migration).toContain(`CREATE POLICY auteur_insertion ON "public"."notes" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (auteur = ${ACTEUR});`);
    // Texte de l'équipe pouvant citer des personnes : pas de copie au journal tant que le mécanisme d'effacement n'est pas choisi (ADR 0044).
    expect(TABLES_CLIENT.find((t) => t.nom === "notes")?.audit).toBe(false);
  });

  it("[A-136] une demande garde organisation, automatisation, canal, catégorie, priorité, statut, responsable", () => {
    expect(colonnes(demandes)).toEqual(expect.arrayContaining(["organisation_id", "automatisation_id", "canal", "categorie", "priorite", "statut", "responsable", "reference_texte"]));
    expect(migration).toContain('CREATE POLICY creation_demande ON "public"."demandes" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (statut = \'nouvelle\');');
    expect(migration).toMatch(/CREATE POLICY transitions_demande ON "public"\."demandes" AS RESTRICTIVE FOR UPDATE TO console_app USING \(tenant_id IS NOT NULL AND statut <> 'close'\)/);
    expect(migration).toContain('GRANT UPDATE ("statut", "priorite", "responsable") ON TABLE "public"."demandes" TO console_app;');
  });

  it("[C-034] la table demandes n'a aucune colonne de texte libre ; le texte n'existe que par sa référence (un pointeur vers la base du client)", () => {
    expect(types(demandes).filter((t) => /json|bytea|\[\]/.test(t))).toEqual([]);
    const textes = getTableConfig(demandes).columns.filter((c) => c.getSQLType() === "text").map((c) => c.name).sort();
    expect(textes).toEqual(["categorie", "reference_texte", "responsable"]);
    const format = verifications(demandes).find((c) => c.includes('"reference_texte"'));
    expect(format).toContain("demande:");
    expect(format).toContain("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    expect(colonnes(demandes)).not.toEqual(expect.arrayContaining(["texte"]));
    expect(colonnes(demandes).filter((n) => /(texte|corps|contenu|message|description|objet|sujet)$/.test(n) && n !== "reference_texte")).toEqual([]);
    expect(uniques(demandes)).toContainEqual(["tenant_id", "reference_texte"]);
  });

  it("[A-134] une cellule garde adresse, mode, capacité, nombre d'instances, version d'image, dernier signal de vie et état ; table commune fermée à l'application", () => {
    expect(colonnes(cellules)).toEqual(expect.arrayContaining(["adresse_interne", "mode", "capacite", "nombre_instances", "version_image", "dernier_signal_le", "etat"]));
    expect(colonnes(cellules)).not.toContain("tenant_id");
    expect(TABLES_COMMUNES_SCHEMA.map((t) => t.nom)).toEqual(expect.arrayContaining(COMMUNES));
    expect(TABLES_COMMUNES).toEqual(expect.arrayContaining(["public.cellules", "public.registre_traitements"]));
    // Adresse interne d'une cellule : jamais lisible par l'application des clients.
    expect(migration).not.toMatch(/GRANT [^;]*ON TABLE "public"\."cellules" TO [^;]*console_app/);
    expect(migration).toContain('GRANT SELECT, INSERT ON TABLE "public"."cellules" TO console_equipe;');
    expect(migration).toContain("CREATE TRIGGER cellules_audit AFTER INSERT OR UPDATE OR DELETE ON \"public\".\"cellules\" FOR EACH ROW EXECUTE FUNCTION public.audit_ecrire_equipe();");
  });

  it("[A-138] un client sans thème actif a le thème AXION par défaut ; un seul thème actif par client", () => {
    expect(themeEffectif([])).toEqual(THEME_AXION);
    expect(themeEffectif([{ actif: false, ton: "formel" }])).toEqual(THEME_AXION);
    expect(themeEffectif([{ actif: false, ton: "formel" }, { actif: true, ton: "chaleureux" }]).ton).toBe("chaleureux");
    expect(colonnes(themesClient)).toEqual(expect.arrayContaining(["logo_ref", "couleur_principale", "couleur_accent", "police", "ton", "signature", "mentions_legales", "actif"]));
    expect(migration).toMatch(/CREATE UNIQUE INDEX "themes_client_un_actif" ON "themes_client" USING btree \("tenant_id"\) WHERE .*"actif"/);
    // Aucune couleur en dur : des jetons de design (noms), jamais un code hexadécimal.
    expect(verifications(themesClient).filter((c) => c.includes("couleur_")).length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(THEME_AXION)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("[A-140] un outil du client dit si un connecteur existe", () => {
    expect(colonnes(outilsClient)).toEqual(expect.arrayContaining(["organisation_id", "famille", "outil", "connecteur_disponible"]));
    expect(getTableConfig(outilsClient).columns.find((c) => c.name === "connecteur_disponible")?.notNull).toBe(true);
    expect(uniques(outilsClient)).toContainEqual(["tenant_id", "organisation_id", "outil"]);
  });

  it("[A-151] un audit garde type, date et identifiant axion-ia.com (aucun compte rendu en texte : une référence)", () => {
    expect(colonnes(audits)).toEqual(expect.arrayContaining(["organisation_id", "type", "date_audit", "identifiant_hub", "compte_rendu_ref"]));
    expect(uniques(audits)).toContainEqual(["tenant_id", "identifiant_hub"]);
    expect(types(audits).filter((t) => /json|bytea|\[\]/.test(t))).toEqual([]);
  });

  it("[A-152] un besoin garde priorité et temps perdu estimé en minutes ; l'automatisation rapprochée est facultative", () => {
    expect(colonnes(besoins)).toEqual(expect.arrayContaining(["audit_id", "categorie", "priorite", "minutes_perdues_estimees", "automatisation_id"]));
    expect(getTableConfig(besoins).columns.find((c) => c.name === "automatisation_id")?.notNull).toBe(false);
    expect(getTableConfig(besoins).columns.find((c) => c.name === "minutes_perdues_estimees")?.getSQLType()).toBe("integer");
    expect(verifications(besoins).some((c) => c.includes('"minutes_perdues_estimees" BETWEEN 0 AND'))).toBe(true);
  });

  it("[A-153] une proposition garde automatisations, paliers et statut ; aucun prix (le Hub fait foi)", () => {
    expect(colonnes(propositions)).toEqual(expect.arrayContaining(["organisation_id", "statut", "identifiant_hub", "nombre_paliers"]));
    expect(colonnes(propositionsAutomatisations)).toEqual(expect.arrayContaining(["proposition_id", "automatisation_id", "palier"]));
    expect(uniques(propositionsAutomatisations)).toContainEqual(["tenant_id", "proposition_id", "automatisation_id"]);
    for (const t of [propositions, propositionsAutomatisations, audits, besoins, themesClient, outilsClient, notes, demandes]) {
      expect(colonnes(t).filter((n) => /(prix|montant|tarif|tva|cout|centimes|remise)/.test(n)), getTableConfig(t).name).toEqual([]);
    }
  });

  it("[A-200] le registre des traitements existe dans la base console : finalité, base légale, catégories de données, destinataires, durée, mesures de sécurité", () => {
    expect(colonnes(registreTraitements)).toEqual(expect.arrayContaining(["finalite", "base_legale", "categories_donnees", "destinataires", "duree_conservation", "mesures_securite"]));
    expect(colonnes(registreTraitements)).not.toContain("tenant_id");
    expect(migration).toContain('ALTER TABLE "public"."registre_traitements" FORCE ROW LEVEL SECURITY;');
    expect(migration).not.toMatch(/GRANT [^;]*ON TABLE "public"\."registre_traitements" TO [^;]*console_app/);
  });

  it("[A-119] RLS activée et forcée sur chaque table, isolation par client, acteur obligatoire sans repli sur « systeme », aucun DELETE ni TRUNCATE accordé, aucun DROP", () => {
    expect(TABLES_CLIENT.map((t) => t.nom)).toEqual(expect.arrayContaining(CLIENT));
    for (const t of [...CLIENT, ...COMMUNES]) {
      expect(migration, t).toContain(`ALTER TABLE "public"."${t}" ENABLE ROW LEVEL SECURITY;`);
      expect(migration, t).toContain(`ALTER TABLE "public"."${t}" FORCE ROW LEVEL SECURITY;`);
      expect(migration, t).toContain(`REVOKE ALL ON TABLE "public"."${t}" FROM PUBLIC;`);
    }
    for (const t of CLIENT) {
      expect(migration, t).toContain(`CREATE POLICY isolation_client ON "public"."${t}" FOR ALL TO console_app USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`);
      expect(migration, t).toContain(`CREATE POLICY acteur_obligatoire_insert ON "public"."${t}" AS RESTRICTIVE FOR INSERT TO console_app WITH CHECK (${ACTEUR} IS NOT NULL);`);
    }
    expect(migration).not.toMatch(/GRANT [^;]*\b(DELETE|TRUNCATE)\b/);
    expect(migration).not.toMatch(/\bDROP\b/);
    expect(migration).not.toMatch(/coalesce\([^)]*'systeme'/i);
    expect(migration).not.toMatch(/GRANT [^;]*\bALL\b/);
    expect(migration).not.toMatch(/SELECT \*|RETURNING \*/);
  });

  it("[A-119] toute unicité commence par tenant_id ; EXCEPTIONS_UNICITE reste vide ; les clés étrangères sont composées (tenant_id, x)", () => {
    expect(EXCEPTIONS_UNICITE).toEqual([]);
    for (const t of [notes, demandes, themesClient, outilsClient, audits, besoins, propositions, propositionsAutomatisations]) {
      for (const u of uniques(t)) expect(u[0], getTableConfig(t).name).toBe("tenant_id");
      for (const fk of getTableConfig(t).foreignKeys) {
        const cible = fk.reference().foreignTable;
        const nom = getTableConfig(cible).name;
        if (["automatisations"].includes(nom)) continue; // catalogue commun : sans tenant_id (ADR 0051)
        expect(fk.reference().columns.map((c) => c.name)[0], `${getTableConfig(t).name} -> ${nom}`).toBe("tenant_id");
      }
    }
    expect(migration).toMatch(/CREATE UNIQUE INDEX "themes_client_un_actif" ON "themes_client" USING btree \("tenant_id"\)/);
  });

  it("[A-119] bornes : les entiers lus en mode nombre sont bornés (2^53-1 ou plus strict) ; aucun bigint dans les nouvelles tables", () => {
    for (const t of [notes, demandes, themesClient, outilsClient, audits, besoins, propositions, propositionsAutomatisations, cellules, registreTraitements]) {
      expect(types(t).filter((x) => x === "bigint"), getTableConfig(t).name).toEqual([]);
    }
    expect(verifications(cellules).some((c) => c.includes('"capacite" BETWEEN 1 AND'))).toBe(true);
    expect(verifications(cellules).some((c) => c.includes('"nombre_instances" BETWEEN 0 AND'))).toBe(true);
  });

  it("[A-119] le code de la migration n'écrit ni adresse IP, ni nom d'hôte, ni prix, ni couleur en dur, ni nom de client", () => {
    const sansCommentaires = migration.replace(/^--.*$/gm, "");
    expect(sansCommentaires).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(sansCommentaires).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(sansCommentaires).not.toMatch(/\b(prix|tarif)\b/i);
  });

  it("[A-119] aucune fonction nouvelle : la migration n'ajoute aucun CREATE FUNCTION (donc aucune empreinte à déclarer)", () => {
    expect(migration).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
    expect(empreintes.fonctions.filter((f) => f.fichier === "0011_suivi.sql")).toEqual([]);
  });

  it("[A-119] l'ADR 0055 écrit le choix des tables, le Hub qui fait foi (aucun prix), la TVA jamais en exonération et les dettes", () => {
    expect(adr).toMatch(/Le Hub fait foi/);
    expect(adr).toMatch(/## Dettes/);
    expect(adr).toMatch(/executions\.auteur[^\n]*executions\.termine_par[^\n]*alertes\.assignee_a/);
    expect(adr).toMatch(/aucun prix/i);
    expect(adr).toMatch(/chaîne des migrations/);
    expect(migration).not.toMatch(/exon[ée]r/i);
  });
});

describe("suivi : instantané et journal Drizzle de la migration 0011", () => {
  type Snapshot = { id: string; prevId: string; tables: Record<string, unknown>; enums: Record<string, unknown> } & Record<string, unknown>;
  const snapshot = (n: string) => JSON.parse(lire(`../../../drizzle/meta/${n}_snapshot.json`)) as Snapshot;
  it("[A-119] l'instantané 0011 ne diffère de 0010 que par les 10 tables et les énumérations nouvelles : aucune table existante ne change (prevId = id de 0010)", () => {
    const [s10, s11] = [snapshot("0010"), snapshot("0011")];
    expect(s11.prevId).toBe(s10.id);
    for (const [nom, table] of Object.entries(s10.tables)) expect(s11.tables[nom], `table ${nom} de 0010 changée dans 0011`).toEqual(table);
    for (const [nom, e] of Object.entries(s10.enums)) expect(s11.enums[nom], `énumération ${nom} de 0010 changée dans 0011`).toEqual(e);
    expect(Object.keys(s11.tables).filter((t) => !(t in s10.tables)).sort()).toEqual([...CLIENT, ...COMMUNES].map((t) => `public.${t}`).sort());
    expect(Object.keys(s11.enums).filter((e) => !(e in s10.enums)).sort()).toEqual(
      ["base_legale", "canal_demande", "etat_cellule", "mode_cellule", "niveau_priorite", "statut_demande", "statut_proposition", "ton_theme", "type_audit", "type_note"].map((e) => `public.${e}`),
    );
    for (const cle of Object.keys(s10).filter((k) => !["id", "prevId", "tables", "enums"].includes(k))) expect(s11[cle], cle).toEqual(s10[cle]);
  });

  it("[A-119] le journal Drizzle est complet : douze entrées de 0000 à 0011, la dernière est 0011_suivi", () => {
    const journal = JSON.parse(lire("../../../drizzle/meta/_journal.json")) as { entries: { idx: number; tag: string; when: number }[] };
    expect(journal.entries.map((e) => e.idx)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(journal.entries.at(-1)?.tag).toBe("0011_suivi");
    const quand = journal.entries.map((e) => e.when);
    expect(quand).toEqual([...quand].sort((a, b) => a - b));
  });
});
