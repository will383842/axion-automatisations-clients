import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { TABLES_COMMUNES } from "../../../../../packages/contrats/src/c5/invariants.ts";
import { TABLES_COMMUNES_SCHEMA } from "./aides.ts";
import { automatisationMetiers, automatisationPostes, automatisations, connecteurs, familleConnecteur, grillesPrix, metiers, natureVersion, niveauRisqueIa, origineAutomatisation, packs, packsAutomatisations, postes, prereglagesMetier, statutAutomatisation, statutPrereglage, statutVersion, synonymesCatalogue, versionsAutomatisation, visibiliteAutomatisation } from "./catalogue.ts";
import { conditionsParDefaut } from "./canaux.ts";
import { COLONNES_INSTANCES_APP, instances } from "./clients.ts";

// Contrôles sans base de données du schéma et de la migration 0007 ; les essais contre PostgreSQL sont dans db/catalogue.int.test.ts (job socle-integration).
const migration = readFileSync(new URL("../../../drizzle/0007_catalogue.sql", import.meta.url), "utf8");
type Table = Parameters<typeof getTableConfig>[0];
const colonnes = (t: Table) => getTableConfig(t).columns.map((c) => c.name);
const contraintes = (t: Table) => getTableConfig(t).checks.map((c) => c.name);
const uniques = (t: Table) => getTableConfig(t).uniqueConstraints.map((u) => u.columns.map((c) => c.name));
const droitsDe = (table: string, role: string) => [...migration.matchAll(new RegExp(`GRANT ([A-Z, ]+(?:\\([^)]*\\))?) ON TABLE "public"\\."${table}" TO ${role}`, "g"))].map((m) => m[1] ?? "");
const COMMUNES = ["metiers", "postes", "automatisations", "automatisation_metiers", "automatisation_postes", "versions_automatisation", "prereglages_metier", "synonymes_catalogue", "packs", "packs_automatisations", "connecteurs", "grilles_prix"];

const HORS_CATALOGUE = ["cellules", "registre_traitements", "membres_equipe", "absences", "vues_enregistrees", "sous_traitants_ulterieurs", "signatures_fiches", "historique_grilles_prix", "incidents", "regles_alertes", "disjoncteurs", "reveils", "mesures_capacite", "modeles_messages", "bilans_incident", "fenetres_maintenance", "avis_depreciation", "preuves_procedure", "passages_version"];

describe("catalogue commun : liste fermée et règle C5 (migration 0007)", () => {
  it("[A-119] les douze tables du catalogue sont dans la liste fermée TABLES_COMMUNES, gelée, sans tenant_id", () => {
    for (const t of COMMUNES) expect(TABLES_COMMUNES, t).toContain(`public.${t}`);
    expect(TABLES_COMMUNES).toContain("public.exclusions_plateforme");
    // T2-07 (ADR 0055) ajoute deux tables communes hors catalogue, T3-05a (ADR 0115) trois, T3-05b (ADR 0115) trois autres, T5-01b (ADR 0116) neuf de la supervision, T4-27a (ADR 0122) deux du cycle de vie : la liste du catalogue reste exacte, les ajouts ultérieurs sont nommés ici.
    expect(TABLES_COMMUNES.filter((t) => !HORS_CATALOGUE.map((n) => `public.${n}`).includes(t))).toHaveLength(COMMUNES.length + 1);
    expect(Object.isFrozen(TABLES_COMMUNES)).toBe(true);
    // clients.ts importe suivi.ts (clé étrangère instances → cellules, T4-21) : les deux tables communes de T2-07 sont chargées avec lui.
    expect(TABLES_COMMUNES_SCHEMA.map((t) => t.nom).filter((n) => !HORS_CATALOGUE.includes(n)).sort()).toEqual([...COMMUNES].sort());
    for (const t of [metiers, postes, automatisations, automatisationMetiers, automatisationPostes, versionsAutomatisation, prereglagesMetier, synonymesCatalogue, packs, packsAutomatisations, connecteurs, grillesPrix]) {
      expect(colonnes(t)).not.toContain("tenant_id");
    }
  });

  it("[A-119] @isolation console_app ne reçoit que SELECT sur chaque table commune ; console_equipe n'a jamais TRUNCATE, REFERENCES, TRIGGER ni ALL ; aucun droit pour PUBLIC ni le portail", () => {
    for (const t of COMMUNES) {
      expect(droitsDe(t, "console_app"), t).toEqual(["SELECT"]);
      expect(droitsDe(t, "console_equipe").join(), t).toMatch(/SELECT/);
      expect(droitsDe(t, "console_equipe").join(), t).not.toMatch(/TRUNCATE|REFERENCES|TRIGGER|\bALL\b/);
      expect(migration, t).toContain(`ALTER TABLE "public"."${t}" ENABLE ROW LEVEL SECURITY`);
      expect(migration, t).toContain(`ALTER TABLE "public"."${t}" FORCE ROW LEVEL SECURITY`);
      expect(migration, t).toContain(`REVOKE ALL ON TABLE "public"."${t}" FROM PUBLIC`);
    }
    expect(migration).not.toMatch(/portail_app|TO PUBLIC/i);
  });

  it("[A-119] un seul rôle écrit dans le catalogue : console_equipe ; aucun DELETE sur les tables aux identités figées", () => {
    for (const t of ["metiers", "postes", "automatisations", "versions_automatisation", "prereglages_metier", "packs", "connecteurs", "grilles_prix"]) {
      expect(droitsDe(t, "console_equipe").join(), t).not.toMatch(/DELETE/);
    }
  });
});

describe("catalogue : automatisations, versions, préréglages (migration 0007)", () => {
  it("[A-122] une automatisation se crée avec code, nom, fonction, description, visibilité, priorité, origine ; le code est unique et lisible", () => {
    expect(colonnes(automatisations)).toEqual(expect.arrayContaining(["id", "code", "nom", "fonction", "description", "visibilite", "priorite", "minutes_gagnees", "origine", "niveau_risque_ia", "statut"]));
    expect(colonnes(automatisations)).not.toContain("metiers_vises");
    expect(colonnes(automatisations)).not.toContain("etape_construction");
    expect(uniques(automatisations)).toContainEqual(["code"]);
    expect(contraintes(automatisations)).toEqual(expect.arrayContaining(["automatisations_code_format", "automatisations_minutes_gagnees_positives"]));
    expect(visibiliteAutomatisation.enumValues).toEqual(["interne", "visible_clients"]);
    expect(getTableConfig(automatisations).columns.find((c) => c.name === "visibilite")?.default).toBe("interne");
    expect(origineAutomatisation.enumValues).toEqual(["axion", "client", "partenaire"]);
  });

  it("[A-159] le niveau de risque IA est une énumération fermée qui accepte « sans IA » et le nul", () => {
    expect(niveauRisqueIa.enumValues).toEqual(["sans_ia", "minimal", "limite", "eleve", "inacceptable"]);
    expect(getTableConfig(automatisations).columns.find((c) => c.name === "niveau_risque_ia")?.notNull).toBe(false);
    expect(migration).not.toMatch(/utilise_ia/);
  });

  it("[C-672] le statut de l'automatisation (4 mots) est un champ distinct du statut de version (6 états de A-305)", () => {
    expect(statutAutomatisation.enumValues).toEqual(["idee", "en_construction", "au_catalogue", "archivee"]);
    expect(statutVersion.enumValues).toEqual(["brouillon", "recette", "pilote", "publiee", "depreciee", "retiree"]);
    expect(colonnes(automatisations)).toContain("statut");
    expect(colonnes(versionsAutomatisation)).toContain("statut");
    expect(statutAutomatisation.enumName).not.toBe(statutVersion.enumName);
  });

  it("[A-123] une version garde semver, apiMoteur, artefact, empreinte SHA-256, signature, SBOM, nature, schéma de configuration, migration, notes, statut", () => {
    expect(colonnes(versionsAutomatisation)).toEqual(expect.arrayContaining(["automatisation_id", "semver", "api_moteur", "artefact_ref", "empreinte_sha256", "signature_ed25519", "sbom_ref", "nature", "schema_configuration", "manifeste", "migration", "notes", "statut"]));
    expect(natureVersion.enumValues.length).toBeGreaterThan(0);
    expect(contraintes(versionsAutomatisation)).toEqual(expect.arrayContaining(["versions_automatisation_empreinte_format", "versions_automatisation_semver_format"]));
    expect(getTableConfig(versionsAutomatisation).columns.find((c) => c.name === "statut")?.default).toBe("brouillon");
  });

  it("[A-124] une même empreinte ne se range pas deux fois, un même semver non plus pour une automatisation", () => {
    expect(uniques(versionsAutomatisation)).toContainEqual(["empreinte_sha256"]);
    expect(uniques(versionsAutomatisation)).toContainEqual(["automatisation_id", "semver"]);
  });

  it("[A-124] @isolation le déclencheur d'immuabilité compare TOUTES les colonnes sauf statut, n'accepte que publiee → depreciee → retiree et refuse tout DELETE", () => {
    expect(migration).toMatch(/CREATE TRIGGER versions_automatisation_immuable BEFORE UPDATE OR DELETE ON "public"\."versions_automatisation"/);
    expect(migration).toContain("to_jsonb(NEW) - 'statut'");
    expect(migration).toContain("to_jsonb(OLD) - 'statut'");
    for (const e of ["brouillon", "recette", "pilote", "publiee", "depreciee", "retiree"]) expect(migration).toContain(`'${e}'`);
    // Pas de raccourci publiee → retiree dans la table des transitions.
    expect(migration).not.toMatch(/OLD\.statut = 'publiee' AND NEW\.statut = 'retiree'/);
    expect(migration).toMatch(/TG_OP = 'DELETE'/);
    // Une version naît en brouillon : aucune insertion directe en publiee, depreciee ou retiree.
    expect(migration).toMatch(/CREATE TRIGGER versions_automatisation_naissance BEFORE INSERT ON "public"\."versions_automatisation"/);
  });

  it("[C-670] métiers et postes sont deux TABLES (pas d'énumération), amorcées par la migration, jamais supprimées", () => {
    for (const t of [metiers, postes]) {
      expect(colonnes(t)).toEqual(expect.arrayContaining(["code", "nom", "groupe", "ordre", "actif"]));
      expect(uniques(t)).toContainEqual(["code"]);
    }
    expect(migration).toContain('INSERT INTO "public"."metiers"');
    expect(migration).toContain('INSERT INTO "public"."postes"');
    expect((migration.match(/\('btp_artisans'|\('cabinets_comptables'|\('avocats_conseils'|\('agences_immobilieres'|\('commerce_ecommerce'|\('industrie_services_b2b'|\('transport_logistique'/g) ?? []).length).toBe(7);
    for (const p of ["direction", "commercial", "comptabilite", "rh", "dsi", "achats", "production", "service_client"]) expect(migration).toContain(`('${p}'`);
    expect(migration).toMatch(/CREATE TRIGGER (metiers|postes|automatisations)_sans_suppression BEFORE DELETE/);
    expect(migration).toContain("sans_accent");
    expect(migration).toMatch(/CREATE UNIQUE INDEX "metiers_nom_sans_casse_ni_accent"/);
    expect(migration).toMatch(/CREATE UNIQUE INDEX "postes_nom_sans_casse_ni_accent"/);
    // Les amorces sont posées AVANT FORCE ROW LEVEL SECURITY (la migration n'a pas de politique d'écriture).
    expect(migration.indexOf('INSERT INTO "public"."metiers"')).toBeLessThan(migration.indexOf('ALTER TABLE "public"."metiers" FORCE ROW LEVEL SECURITY'));
  });

  it("[C-671] les étiquettes se posent par tables de liaison, une seule fois chacune ; l'étiquette outil est une vue calculée, jamais saisie", () => {
    expect(colonnes(automatisationMetiers)).toEqual(["automatisation_id", "metier_id"]);
    expect(colonnes(automatisationPostes)).toEqual(["automatisation_id", "poste_id"]);
    expect(migration).toMatch(/"automatisation_metiers_automatisation_id_metier_id_pk" PRIMARY KEY\("automatisation_id","metier_id"\)/);
    expect(migration).toMatch(/CREATE INDEX "automatisation_metiers_metier_automatisation_idx"/);
    expect(migration).toMatch(/CREATE INDEX "automatisation_postes_poste_automatisation_idx"/);
    expect(migration).toMatch(/CREATE VIEW "public"\."automatisation_outils" WITH \(security_invoker = true\)/);
    expect(migration).not.toMatch(/"outil"\s+text[^;]*automatisations/);
    expect(colonnes(automatisations)).not.toContain("outils");
    expect(migration).not.toMatch(/ON DELETE (CASCADE|SET NULL|SET DEFAULT)/);
  });

  it("[C-673] un préréglage garde statut (brouillon, publie, retire), auteur, justification, version précédente et plage de versions du module ; il naît en brouillon", () => {
    expect(statutPrereglage.enumValues).toEqual(["brouillon", "publie", "retire"]);
    expect(colonnes(prereglagesMetier)).toEqual(expect.arrayContaining(["automatisation_id", "metier_id", "donnees", "version", "statut", "auteur", "justification", "cree_le", "version_precedente_id", "module_version_min", "module_version_max"]));
    expect(getTableConfig(prereglagesMetier).columns.find((c) => c.name === "statut")?.default).toBe("brouillon");
    expect(uniques(prereglagesMetier)).toContainEqual(["automatisation_id", "metier_id", "version"]);
    expect(migration).toMatch(/CREATE TRIGGER prereglages_metier_naissance BEFORE INSERT/);
  });

  it("[A-137] un préréglage se lie à une automatisation et à un métier par clés étrangères RESTRICT, et refuse les données d'un client (clé tenant, e-mail, SIREN)", () => {
    expect(migration).toMatch(/"prereglages_metier_metier_id_metiers_id_fk" FOREIGN KEY \("metier_id"\) REFERENCES "public"\."metiers"\("id"\) ON DELETE restrict/);
    expect(contraintes(prereglagesMetier)).toContain("prereglages_metier_donnees_sans_client");
    expect(migration).toMatch(/\(tenant\|client\|organisation\|instance\|mail\|courriel/);
    expect(migration).toMatch(/\(\[0-9\]\{9\}\|\[0-9\]\{14\}\)/);
  });

  it("[C-676] l'instance garde le préréglage et la version de départ, l'instance source d'une copie, la date et l'auteur ; console_app ne les lit pas", () => {
    expect(colonnes(instances)).toEqual(expect.arrayContaining(["version_courante_id", "automatisation_id", "prereglage_depart_id", "version_prereglage_depart", "instance_source_copie", "copie_le", "copie_par"]));
    expect(colonnes(instances)).toContain("code_automatisation"); // l'ancienne colonne reste jusqu'à la version suivante
    expect(contraintes(instances)).toContain("instances_copie_complete");
    // Lecture refusée à console_app sur les trois colonnes qui nomment un autre client.
    expect(migration).toMatch(/REVOKE SELECT ON TABLE "public"\."instances" FROM console_app/);
    const regrant = /GRANT SELECT \(([^)]*)\) ON TABLE "public"\."instances" TO console_app/.exec(migration)?.[1] ?? "";
    expect(regrant).toContain('"version_courante_id"');
    expect(Object.keys(COLONNES_INSTANCES_APP).length).toBe(regrant.split(",").length);
    // Le journal d'audit ne recopie pas non plus ces colonnes (redéfinition de audit_ecrire).
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.audit_ecrire\(\)[\s\S]*TG_TABLE_NAME = 'instances'[\s\S]*_omis/);
    for (const interdite of ["instance_source_copie", "copie_le", "copie_par"]) expect(regrant).not.toContain(interdite);
  });
});

describe("catalogue : packs, connecteurs, grilles de prix, synonymes, recherche (migration 0007)", () => {
  it("[A-139] un pack porte son métier, ses automatisations et un prix en centimes entiers, non négatif", () => {
    expect(colonnes(packs)).toEqual(expect.arrayContaining(["nom", "metier_id", "prix_centimes", "actif", "auteur"]));
    expect(getTableConfig(packs).columns.find((c) => c.name === "auteur")?.notNull).toBe(true);
    expect(contraintes(packs)).toContain("packs_auteur_non_vide");
    // La composition d'un pack est fixée dans la transaction qui le crée.
    expect(migration).toMatch(/CREATE TRIGGER packs_automatisations_composition BEFORE INSERT/);
    expect(getTableConfig(packs).columns.find((c) => c.name === "prix_centimes")?.columnType).toMatch(/BigInt/);
    expect(colonnes(packsAutomatisations)).toEqual(["pack_id", "automatisation_id"]);
    expect(contraintes(packs)).toContain("packs_prix_positif");
    // Un prix se corrige par un nouveau pack : console_equipe ne modifie que « actif ».
    expect(droitsDe("packs", "console_equipe").join(" ")).toContain('UPDATE ("actif")');
  });

  it("[A-141] un connecteur garde famille (énumération), outil, version, capacités ; l'identité ne change pas", () => {
    expect(colonnes(connecteurs)).toEqual(expect.arrayContaining(["famille", "outil", "version", "capacites"]));
    expect(familleConnecteur.enumValues.length).toBeGreaterThan(0);
    expect(uniques(connecteurs)).toContainEqual(["famille", "outil", "version"]);
    expect(droitsDe("connecteurs", "console_equipe").join()).not.toMatch(/UPDATE/);
  });

  it("[A-142] une grille de prix garde formules actives, montants en centimes entiers, maintenance incluse en mois et prix de la maintenance ensuite ; ajout seul", () => {
    expect(colonnes(grillesPrix)).toEqual(expect.arrayContaining(["automatisation_id", "formules_actives", "montant_installation_centimes", "montant_mensuel_centimes", "maintenance_incluse_mois", "maintenance_ensuite_centimes", "auteur", "cree_le"]));
    for (const c of ["montant_installation_centimes", "montant_mensuel_centimes", "maintenance_ensuite_centimes"]) {
      expect(getTableConfig(grillesPrix).columns.find((x) => x.name === c)?.columnType, c).toMatch(/BigInt/);
    }
    expect(contraintes(grillesPrix)).toEqual(expect.arrayContaining(["grilles_prix_montants_positifs", "grilles_prix_maintenance_mois_positifs", "grilles_prix_auteur_non_vide"]));
    expect(droitsDe("grilles_prix", "console_equipe")).toEqual(["SELECT", expect.stringMatching(/^INSERT \(/)]);
    // Pas de droit sur cree_le : la ligne en vigueur est la plus récente, on ne l'antidate pas.
    expect(droitsDe("grilles_prix", "console_equipe").join()).not.toContain("cree_le");
    expect(droitsDe("packs", "console_equipe").join()).not.toContain("cree_le");
    expect(migration).not.toMatch(/numeric|double precision|\breal\b/i);
  });

  it("[B-533] la recherche sans accent s'appuie sur unaccent, pg_trgm et un index GIN trigramme ; les synonymes sont une table commune", () => {
    expect(migration).toContain("CREATE EXTENSION IF NOT EXISTS unaccent");
    expect(migration).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    expect(migration).toMatch(/CREATE INDEX "automatisations_recherche_trgm_idx" ON "public"\."automatisations" USING gin \(.*gin_trgm_ops\)/);
    expect(colonnes(synonymesCatalogue)).toEqual(expect.arrayContaining(["mot", "equivalent"]));
    expect(uniques(synonymesCatalogue)).toContainEqual(["mot", "equivalent"]);
  });

  it("[C-686] les colonnes de filtre et de tri du catalogue sont indexées (statut, visibilité, nom, étiquettes inverses, préréglages)", () => {
    for (const idx of ["automatisations_statut_idx", "automatisations_visibilite_idx", "automatisations_nom_idx", "versions_automatisation_automatisation_idx", "prereglages_metier_metier_idx"]) {
      expect(migration, idx).toContain(`"${idx}"`);
    }
  });

  it("[C-685] aucune suppression d'une automatisation, d'un métier ou d'un poste, même par console_equipe ; le code est figé", () => {
    expect(droitsDe("automatisations", "console_equipe").join()).not.toMatch(/DELETE/);
    for (const t of ["automatisations", "metiers", "postes"]) expect(migration).toContain(`CREATE TRIGGER ${t}_sans_suppression BEFORE DELETE ON "public"."${t}"`);
    expect(migration).toMatch(/CREATE TRIGGER automatisations_code_fige BEFORE UPDATE/);
    expect(droitsDe("automatisations", "console_equipe").join()).not.toMatch(/"code"/);
  });
});

describe("tables de la plateforme : auteur et journal d'audit (relecture de T2-02, ADR 0050 §5 et 6 bis)", () => {
  it("[A-146] conditions_par_defaut porte un auteur NOT NULL non vide et son journal d'audit", () => {
    expect(colonnes(conditionsParDefaut)).toContain("auteur");
    expect(getTableConfig(conditionsParDefaut).columns.find((c) => c.name === "auteur")?.notNull).toBe(true);
    expect(contraintes(conditionsParDefaut)).toContain("conditions_par_defaut_auteur_non_vide");
    expect(migration).toMatch(/ALTER TABLE "public"\."conditions_par_defaut" ALTER COLUMN "auteur" SET NOT NULL/);
    expect(migration).toMatch(/CREATE TRIGGER conditions_par_defaut_audit AFTER INSERT OR UPDATE OR DELETE ON "public"\."conditions_par_defaut" FOR EACH ROW EXECUTE FUNCTION public\.audit_ecrire_equipe\(\)/);
  });

  it("[A-119] le journal des écritures de l'équipe passe par une fonction SECURITY DEFINER à chemin de recherche fermé, fermée à PUBLIC ; elle sert aussi au catalogue", () => {
    expect(migration).toMatch(/CREATE FUNCTION public\.audit_ecrire_equipe\(\)[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, pg_temp/);
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.audit_ecrire_equipe() FROM PUBLIC");
    for (const t of COMMUNES) expect(migration, t).toMatch(new RegExp(`CREATE TRIGGER ${t}_audit AFTER INSERT OR UPDATE OR DELETE ON "public"\\."${t}"`));
    // Le motif LIKE de l'identifiant d'entité garde UN SEUL antislash (standard_conforming_strings = on : deux antislashs ne trouveraient aucune clé).
    expect(migration).toContain("e.key LIKE '%\\_id'");
    expect(migration).not.toContain("LIKE '%\\\\_id'");
    // Une écriture qui porte de l'argent exige un acteur au journal (pas de repli sur « systeme »).
    expect(migration).toMatch(/acteur obligatoire pour une écriture qui porte de l'+argent/);
  });

  it("[A-126] la cohérence des colonnes de instances est gardée par un déclencheur (version publiée de la même automatisation, préréglage et sa version)", () => {
    expect(migration).toMatch(/CREATE TRIGGER instances_coherence BEFORE INSERT OR UPDATE ON "public"\."instances" FOR EACH ROW EXECUTE FUNCTION public\.instances_garde\(\)/);
  });

  it("[A-139] la composition d'un pack se fixe dans la transaction de sa création (cree_le = now()), pas après", () => {
    expect(migration).toMatch(/p\.cree_le = now\(\)/);
    expect(migration).not.toMatch(/interval '1 hour'/);
  });
});
