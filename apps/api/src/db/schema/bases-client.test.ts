import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { TABLES_CLIENT } from "./aides.ts";
import { basesClient, decisionsEffacement, etatBaseClient, etatProposition, finsDeContrat, gelsLitige, propositionsSuppression, reglagesFinDeContrat, resultatVersion, versionsStructure, visibiliteAcces } from "./bases-client.ts";

// Contrôles sans base de données du schéma et de la migration 0005 ; les essais contre PostgreSQL sont dans db/bases-client.int.test.ts (job socle-integration).
const migration = readFileSync(new URL("../../../drizzle/0005_bases_client.sql", import.meta.url), "utf8");
const colonnes = (t: Parameters<typeof getTableConfig>[0]) => getTableConfig(t).columns.map((c) => c.name);
const contraintes = (t: Parameters<typeof getTableConfig>[0]) => getTableConfig(t).checks.map((c) => c.name);
const TABLES = ["bases_client", "versions_structure", "fins_de_contrat", "confirmations_mise_a_l_ecart", "demandes_effacement", "decisions_effacement", "propositions_suppression", "reglages_fin_de_contrat", "attestations_fin_de_contrat", "gels_litige", "visibilite_acces"];
const droits = (table: string) => [...migration.matchAll(new RegExp(`GRANT ([A-Z, ]+) ON TABLE "public"\\."${table}" TO console_app`, "g"))].map((m) => m[1]);

describe("registre des bases des clients : schéma et migration 0005", () => {
  it("[A-135] une base client garde grappe, nom, version, taille, quotas, sauvegardes, état et étape de provisionnement", () => {
    expect(colonnes(basesClient)).toEqual(expect.arrayContaining(["tenant_id", "grappe", "nom_base", "version_structure", "taille_octets", "quota_base_octets", "quota_fichiers_octets", "quota_personnes", "derniere_sauvegarde", "dernier_test_restauration", "etat", "etape_provisionnement", "derniere_erreur"]));
    expect(etatBaseClient.enumValues).toEqual(["en_creation", "active", "gelee", "exportee", "a_l_ecart", "effacee"]);
    expect(getTableConfig(basesClient).columns.find((c) => c.name === "etat")?.default).toBe("en_creation");
  });

  it("[A-135] le nom de base est dérivé de tenant_id par CHECK, unique avec tenant_id, jamais seul", () => {
    expect(contraintes(basesClient)).toContain("bases_client_nom_base_derive");
    expect(migration).toContain(`CHECK ("bases_client"."nom_base" = 'cli_' || replace("bases_client"."tenant_id"::text, '-', ''))`);
    expect(getTableConfig(basesClient).uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toContainEqual(["tenant_id", "nom_base"]);
    expect(migration).not.toMatch(/UNIQUE\s*\(\s*"nom_base"\s*\)|UNIQUE INDEX[^;]*\("nom_base"\)/i);
  });

  it("[A-225] une version de structure garde la base, la version, la date, le résultat et la vague", () => {
    expect(colonnes(versionsStructure)).toEqual(expect.arrayContaining(["base_id", "version", "appliquee_le", "resultat", "vague"]));
    expect(resultatVersion.enumValues).toEqual(["ok", "echec", "quarantaine"]);
  });

  it("[C-609] un gel garde motif, pose, auteur, levée et auteur de la levée ; aucun droit de suppression", () => {
    expect(colonnes(gelsLitige)).toEqual(expect.arrayContaining(["motif_litige", "posee_le", "posee_par", "levee_le", "leve_par"]));
    expect(droits("gels_litige").join()).not.toMatch(/DELETE|UPDATE/);
    expect(migration).toContain('GRANT UPDATE ("levee_le", "leve_par") ON TABLE "public"."gels_litige" TO console_app');
  });

  it("[A-158] la visibilité garde lien retour, page de référence, accords écrits datés et accès d'intervention", () => {
    expect(colonnes(visibiliteAcces)).toEqual(expect.arrayContaining(["lien_retour", "page_reference", "accords_ecrits_le", "intervention_perimetre", "intervention_debut", "intervention_fin"]));
  });

  it("[A-119] chaque table du registre a ENABLE, FORCE, ses deux politiques, le déclencheur d'audit et aucun DELETE ni TRUNCATE", () => {
    expect(TABLES_CLIENT.map((t) => t.nom)).toEqual(expect.arrayContaining(TABLES));
    for (const t of TABLES) {
      expect(migration, t).toContain(`ALTER TABLE "public"."${t}" ENABLE ROW LEVEL SECURITY`);
      expect(migration, t).toContain(`ALTER TABLE "public"."${t}" FORCE ROW LEVEL SECURITY`);
      expect(migration, t).toContain(`CREATE POLICY isolation_client ON "public"."${t}" FOR ALL TO console_app`);
      expect(migration, t).toContain(`CREATE POLICY lecture_equipe ON "public"."${t}" FOR SELECT TO console_equipe`);
      expect(migration, t).toContain(`CREATE TRIGGER ${t}_audit AFTER INSERT OR UPDATE OR DELETE ON "public"."${t}"`);
      expect(droits(t).join(), t).not.toMatch(/DELETE|TRUNCATE/);
    }
  });

  it("[C-715] les cinq tables de la fin de vie ne sont accordées qu'à console_app et console_equipe, sans suppression ; aucun droit pour le portail", () => {
    expect(migration).not.toMatch(/portail_app|equipe-export/);
    expect(migration).not.toMatch(/TO PUBLIC/i);
    for (const t of ["reglages_fin_de_contrat", "decisions_effacement", "confirmations_mise_a_l_ecart"]) expect(droits(t).join(), t).toBe("SELECT, INSERT");
    // La mise à jour se limite à des colonnes : jamais d'UPDATE sur toute la table.
    for (const t of ["propositions_suppression", "demandes_effacement"]) expect(droits(t).join(), t).toBe("SELECT, INSERT");
    expect(migration).toContain('GRANT UPDATE ("etat") ON TABLE "public"."demandes_effacement" TO console_app');
    expect(migration).not.toMatch(/GRANT UPDATE ON TABLE "public"."(demandes_effacement|propositions_suppression)"/);
    expect(migration).not.toMatch(/GRANT[^;]*\b(TRUNCATE|REFERENCES|TRIGGER|ALL|DELETE)\b[^;]*TO console_(app|equipe)/i);
  });

  it("[C-715] le délai de proposition est au moins 2 mois, et la base le porte (jamais une variable d'environnement)", () => {
    expect(contraintes(reglagesFinDeContrat)).toContain("reglages_delai_minimal");
    expect(migration).toContain(`CHECK ("reglages_fin_de_contrat"."delai_proposition_suppression_mois" >= 2)`);
  });

  it("[C-715] une proposition est unique par (tenant_id, fin_de_contrat_id, echeance) et ses transitions sont les quatre de la fiche", () => {
    expect(getTableConfig(propositionsSuppression).uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toContainEqual(["tenant_id", "fin_de_contrat_id", "echeance"]);
    expect(etatProposition.enumValues).toEqual(["en_attente", "acceptee", "ecartee", "reexamen", "executee"]);
    const fonction = migration.slice(migration.indexOf("FUNCTION public.propositions_transition"), migration.indexOf("CREATE TRIGGER propositions_transition"));
    const paires = [...fonction.matchAll(/\('(\w+)', '(\w+)'\)/g)].map((m) => `${m[1]}>${m[2]}`);
    expect(paires).toEqual(["en_attente>acceptee", "en_attente>ecartee", "ecartee>reexamen", "acceptee>executee"]);
    expect(migration).toContain("CREATE TRIGGER propositions_transition BEFORE UPDATE");
  });

  it("[C-715] une décision d'effacement exige une seule cible, un motif, une cause cohérente, un gel pour litige et un texte pour obligation légale", () => {
    expect(contraintes(decisionsEffacement)).toEqual(expect.arrayContaining(["decisions_une_seule_cible", "decisions_motif_non_vide", "decisions_cause_selon_decision", "decisions_decision_de_will_ecarter", "decisions_gel_si_litige", "decisions_texte_si_obligation"]));
    expect(migration).toContain("CREATE TRIGGER decisions_controle_gel BEFORE INSERT");
  });

  it("[A-163] aucune colonne de date d'effacement : la fin de contrat ne programme rien", () => {
    for (const t of [finsDeContrat, propositionsSuppression, decisionsEffacement]) expect(colonnes(t).join()).not.toMatch(/suppression_le|efface_le|date_effacement|date_suppression/);
  });
});
