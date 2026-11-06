import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, pgEnum, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { tableClient } from "./aides.ts";
import { instances, organisations } from "./clients.ts";

// Tables de la supervision par client (C5, lot 5, T5-01a, ADR 0116) : métadonnées seulement, aucun contenu d'e-mail, aucun texte de demande, aucun secret.
// Chaque colonne de texte est bornée par un CHECK (code, adresse de forme fermée, référence d'objet, acteur). Vocabulaires additifs, jamais renommés.
export const etatSante = pgEnum("etat_sante", ["saine", "degradee", "en_panne", "inconnue"]);
export const etapeSuspension = pgEnum("etape_suspension", ["avertissement", "limitation", "suspension"]);
export const motifSuspension = pgEnum("motif_suspension", ["envois_excessifs", "plaintes", "usage_interdit", "autre"]);
export const etatRapport = pgEnum("etat_rapport", ["prepare", "envoye"]);

const nonVide = (c: unknown) => sql`length(btrim(${c})) > 0`;
const borne = (c: unknown, max: number) => sql`char_length(${c}) <= ${sql.raw(String(max))}`;
const instanceFk = (nom: string) => (t: Record<string, unknown>) =>
  foreignKey({ name: `${nom}_instance_fk`, columns: [t["tenantId"] as never, t["instanceId"] as never], foreignColumns: [instances.tenantId, instances.id] });
const organisationFk = (nom: string) => (t: Record<string, unknown>) =>
  foreignKey({ name: `${nom}_organisation_fk`, columns: [t["tenantId"] as never, t["organisationId"] as never], foreignColumns: [organisations.tenantId, organisations.id] });

// Santé d'une instance (état, raisons en codes, depuis quand, dernière réussite, prochaine attendue). Une ligne par instance.
export const santeInstances = tableClient(
  "sante_instances",
  {
    id: uuid("id").notNull(),
    instanceId: uuid("instance_id").notNull(),
    etat: etatSante("etat").notNull().default("inconnue"),
    raisons: text("raisons").array().notNull().default(sql`'{}'`),
    depuis: timestamp("depuis", { withTimezone: true }).notNull().defaultNow(),
    derniereReussiteLe: timestamp("derniere_reussite_le", { withTimezone: true }),
    prochaineAttendueLe: timestamp("prochaine_attendue_le", { withTimezone: true }),
  },
  {
    contraintes: (t) => [
      instanceFk("sante_instances")(t),
      unique("sante_instances_instance_unique").on(t["tenantId"] as never, t["instanceId"] as never),
      check("sante_instances_raisons_codes", sql`cardinality(${t["raisons"]}) <= 16 AND array_to_string(${t["raisons"]}, ',') ~ '^([a-z][a-z0-9_.-]{0,63}(,[a-z][a-z0-9_.-]{0,63})*)?$'`),
    ],
  },
);

// Lien de retour d'une organisation : adresse https de forme fermée, vérifiée ou non, attributs trouvés lors du dernier contrôle.
export const liensRetour = tableClient(
  "liens_retour",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    adresse: text("adresse").notNull(),
    verifiee: boolean("verifiee").notNull().default(false),
    dernierControleLe: timestamp("dernier_controle_le", { withTimezone: true }),
    attributsTrouves: text("attributs_trouves").array().notNull().default(sql`'{}'`),
  },
  {
    contraintes: (t) => [
      organisationFk("liens_retour")(t),
      unique("liens_retour_adresse_unique").on(t["tenantId"] as never, t["organisationId"] as never, t["adresse"] as never),
      check("liens_retour_adresse_forme", sql`${t["adresse"]} ~ '^https://[A-Za-z0-9.-]{1,253}(/[A-Za-z0-9._~/%-]{0,500})?$' AND ${borne(t["adresse"], 800)}`),
      check("liens_retour_attributs_bornes", sql`cardinality(${t["attributsTrouves"]}) <= 32`),
    ],
  },
);

// Suspension pour abus : écrite par l'équipe seule (E4, comme alertes_plateforme) ; la levée est la seule modification. Motif en énumération, jamais un texte libre.
export const suspensionsAbus = tableClient(
  "suspensions_abus",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    etape: etapeSuspension("etape").notNull(),
    motif: motifSuspension("motif").notNull(),
    poseePar: text("posee_par").notNull(),
    poseeLe: timestamp("posee_le", { withTimezone: true }).notNull().defaultNow(),
    leveePar: text("levee_par"),
    leveeLe: timestamp("levee_le", { withTimezone: true }),
  },
  {
    contraintes: (t) => [
      organisationFk("suspensions_abus")(t),
      check("suspensions_abus_posee_par_borne", sql`${nonVide(t["poseePar"])} AND ${borne(t["poseePar"], 200)}`),
      check("suspensions_abus_levee_coherente", sql`(${t["leveeLe"]} IS NULL) = (${t["leveePar"]} IS NULL) AND (${t["leveePar"]} IS NULL OR ${borne(t["leveePar"], 200)})`),
    ],
  },
);

// Rapport mensuel : référence de l'objet PDF (jamais le PDF), état préparé ou envoyé ; un seul par organisation et par mois (premier jour du mois).
export const rapportsMensuels = tableClient(
  "rapports_mensuels",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    mois: date("mois").notNull(),
    objetPdfRef: text("objet_pdf_ref").notNull(),
    etat: etatRapport("etat").notNull().default("prepare"),
    envoyePar: text("envoye_par"),
    envoyeLe: timestamp("envoye_le", { withTimezone: true }),
  },
  {
    contraintes: (t) => [
      organisationFk("rapports_mensuels")(t),
      unique("rapports_mensuels_mois_unique").on(t["tenantId"] as never, t["organisationId"] as never, t["mois"] as never),
      check("rapports_mensuels_premier_du_mois", sql`extract(day from ${t["mois"]}) = 1`),
      check("rapports_mensuels_objet_forme", sql`${t["objetPdfRef"]} ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$' AND ${t["objetPdfRef"]} !~ '\\.\\.'`),
      check("rapports_mensuels_envoi_coherent", sql`(${t["etat"]} = 'envoye') = (${t["envoyeLe"]} IS NOT NULL) AND (${t["envoyeLe"]} IS NULL) = (${t["envoyePar"]} IS NULL) AND (${t["envoyePar"]} IS NULL OR ${borne(t["envoyePar"], 200)})`),
    ],
  },
);

// Relevé d'une base de client (cli_<id>), daté par `debut` ; partitionnée par mois (pg_partman), clé (tenant_id, id, debut) : la partition est écrite à la main dans la migration.
export const mesuresBases = tableClient(
  "mesures_bases",
  {
    id: uuid("id").notNull(),
    debut: timestamp("debut", { withTimezone: true }).notNull(),
    base: text("base").notNull(),
    tailleOctets: bigint("taille_octets", { mode: "number" }).notNull(),
    quotaOctets: bigint("quota_octets", { mode: "number" }),
    connexions: integer("connexions").notNull(),
    requetesLentes: integer("requetes_lentes").notNull(),
    lignesMortes: bigint("lignes_mortes", { mode: "number" }).notNull(),
    versionStructure: text("version_structure").notNull(),
    ageSauvegardeS: integer("age_sauvegarde_s"),
    ageTestRestaurationS: integer("age_test_restauration_s"),
  },
  {
    partitionnee: true,
    contraintes: (t) => [
      index("mesures_bases_tenant_debut_idx").on(t["tenantId"] as never, t["debut"] as never),
      check("mesures_bases_base_forme", sql`${t["base"]} ~ '^cli_[a-z0-9_]{1,59}$'`),
      check("mesures_bases_version_code", sql`${t["versionStructure"]} ~ '^[a-z0-9][a-z0-9_.-]{0,31}$'`),
      check(
        "mesures_bases_valeurs_positives",
        sql`${t["tailleOctets"]} >= 0 AND (${t["quotaOctets"]} IS NULL OR ${t["quotaOctets"]} > 0) AND ${t["connexions"]} >= 0 AND ${t["requetesLentes"]} >= 0 AND ${t["lignesMortes"]} >= 0 AND coalesce(${t["ageSauvegardeS"]}, 0) >= 0 AND coalesce(${t["ageTestRestaurationS"]}, 0) >= 0`,
      ),
    ],
  },
);
