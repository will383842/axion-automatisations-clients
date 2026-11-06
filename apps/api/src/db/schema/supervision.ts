import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, pgEnum, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tableClient, tableCommune } from "./aides.ts";
import { gravite } from "./canaux.ts";
import { instances, organisations } from "./clients.ts";
import { alertes } from "./exploitation.ts";

// Tables de la supervision (C5, lot 5, T5-01a et T5-01b, ADR 0116) : métadonnées seulement, aucun contenu d'e-mail, aucun texte de demande, aucun secret.
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
      // T5-01b (dette M3 de l'audit de la 0022) : chaque attribut est un code court (la migration 0023 pose cette contrainte NOT VALID, en ajout seul).
      check("liens_retour_attributs_codes", sql`array_to_string(${t["attributsTrouves"]}, ',') ~ '^([a-z][a-z0-9_.-]{0,63}(,[a-z][a-z0-9_.-]{0,63})*)?$'`),
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

// ===== T5-01b (migration 0023, ADR 0116) : tables communes de la supervision, sans tenant_id ni nom de client. Écrites par console_equipe seul. =====
export const graviteIncident = pgEnum("gravite_incident", ["mineure", "majeure", "critique"]);
export const etatIncident = pgEnum("etat_incident", ["ouvert", "pris_en_charge", "resolu", "clos"]);
// Périmètre d'un disjoncteur, d'un incident ou d'une maintenance : un vocabulaire fermé, jamais un nom.
export const porteeDisjoncteur = pgEnum("portee_disjoncteur", ["automatisation", "version", "connecteur", "cellule", "envois_instance", "envois_plateforme"]);
export const typeCibleCapacite = pgEnum("type_cible_capacite", ["serveur", "cellule"]);
export const etatAvis = pgEnum("etat_avis", ["a_lire", "planifie", "traite"]);

const CODE = "^[a-z][a-z0-9_.-]{0,63}$";
const code = (c: unknown) => sql`${c} ~ ${sql.raw(`'${CODE}'`)}`;
const acteur = (c: unknown) => sql`${nonVide(c)} AND ${borne(c, 200)}`;

// Incident de plateforme : touche souvent plusieurs clients ; QUELS clients est dit par incidents_instances, sous RLS. Cause = code, périmètre = vocabulaire fermé.
export const incidents = tableCommune(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cause: text("cause").notNull(),
    gravite: graviteIncident("gravite").notNull(),
    etat: etatIncident("etat").notNull().default("ouvert"),
    debut: timestamp("debut", { withTimezone: true }).notNull(),
    detecteLe: timestamp("detecte_le", { withTimezone: true }).notNull(),
    prisEnChargeLe: timestamp("pris_en_charge_le", { withTimezone: true }),
    resoluLe: timestamp("resolu_le", { withTimezone: true }),
    perimetre: porteeDisjoncteur("perimetre").array().notNull().default(sql`'{}'`),
  },
  (t) => [
    check("incidents_cause_code", code(t["cause"])),
    check(
      "incidents_chronologie",
      sql`${t["detecteLe"]} >= ${t["debut"]} AND (${t["prisEnChargeLe"]} IS NULL OR ${t["prisEnChargeLe"]} >= ${t["detecteLe"]}) AND (${t["resoluLe"]} IS NULL OR ${t["resoluLe"]} >= ${t["debut"]})`,
    ),
    check("incidents_perimetre_borne", sql`cardinality(${t["perimetre"]}) <= 6`),
  ],
);

// Règle d'alerte : un code, une gravité, un seuil et une fenêtre. Les valeurs de seuil sont posées plus tard (lot 8) ; la table ne les fixe pas.
export const reglesAlertes = tableCommune(
  "regles_alertes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    gravite: gravite("gravite").notNull(),
    seuil: integer("seuil").notNull(),
    fenetreS: integer("fenetre_s").notNull(),
    active: boolean("active").notNull().default(true),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("regles_alertes_code_unique").on(t["code"] as never),
    check("regles_alertes_code_forme", code(t["code"])),
    check("regles_alertes_valeurs", sql`${t["seuil"]} >= 0 AND ${t["fenetreS"]} > 0`),
  ],
);

// Disjoncteur : coupe un périmètre. Équipe SEULE (aucun droit pour console_app, pas même SELECT). La cible est un identifiant, nulle seulement pour les envois de toute la plateforme.
// Un seul disjoncteur non levé par (portée, cible).
export const disjoncteurs = tableCommune(
  "disjoncteurs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portee: porteeDisjoncteur("portee").notNull(),
    cible: uuid("cible"),
    motifCode: text("motif_code").notNull(),
    posePar: text("pose_par").notNull(),
    poseLe: timestamp("pose_le", { withTimezone: true }).notNull().defaultNow(),
    levePar: text("leve_par"),
    leveLe: timestamp("leve_le", { withTimezone: true }),
    rappelLe: timestamp("rappel_le", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("disjoncteurs_un_actif_par_cible").on(t["portee"] as never, t["cible"] as never).where(sql`${t["leveLe"]} IS NULL AND ${t["cible"]} IS NOT NULL`),
    uniqueIndex("disjoncteurs_un_actif_plateforme").on(t["portee"] as never).where(sql`${t["leveLe"]} IS NULL AND ${t["cible"]} IS NULL`),
    check("disjoncteurs_cible_selon_portee", sql`(${t["portee"]} = 'envois_plateforme') = (${t["cible"]} IS NULL)`),
    check("disjoncteurs_motif_code", code(t["motifCode"])),
    check("disjoncteurs_pose_par_borne", acteur(t["posePar"])),
    check("disjoncteurs_levee_coherente", sql`(${t["leveLe"]} IS NULL) = (${t["levePar"]} IS NULL) AND (${t["levePar"]} IS NULL OR ${acteur(t["levePar"])})`),
    check("disjoncteurs_chronologie", sql`${t["leveLe"]} IS NULL OR ${t["leveLe"]} >= ${t["poseLe"]}`),
  ],
);

// Réveil de nuit : heure, cause en code, durée, justification courte. Équipe SEULE, ajout seul.
export const reveils = tableCommune(
  "reveils",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    heure: timestamp("heure", { withTimezone: true }).notNull(),
    cause: text("cause").notNull(),
    dureeS: integer("duree_s").notNull(),
    justification: text("justification").notNull(),
    auteur: text("auteur").notNull(),
  },
  (t) => [
    check("reveils_cause_code", code(t["cause"])),
    check("reveils_duree_positive", sql`${t["dureeS"]} >= 0`),
    check("reveils_justification_borne", sql`${nonVide(t["justification"])} AND ${borne(t["justification"], 500)}`),
    check("reveils_auteur_borne", acteur(t["auteur"])),
  ],
);

// Relevé de capacité d'un serveur ou d'une cellule (code, jamais une adresse), daté par `debut`. NON partitionnée dans la 0023 : le contrôle C5 refuse les partitions d'une table commune
// (tenant_id_absent, politique_ouverte, index_tenant_absent : une partition n'a pas le nom listé dans TABLES_COMMUNES). ESCALADE à l'architecte, voir l'ADR 0116 ; la purge par ancienneté est portée par T5-15.
export const mesuresCapacite = tableCommune(
  "mesures_capacite",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    debut: timestamp("debut", { withTimezone: true }).notNull(),
    cibleType: typeCibleCapacite("cible_type").notNull(),
    cibleCode: text("cible_code").notNull(),
    cpuBps: integer("cpu_bps").notNull(),
    memoireOctets: bigint("memoire_octets", { mode: "number" }).notNull(),
    disqueOctets: bigint("disque_octets", { mode: "number" }).notNull(),
  },
  (t) => [
    index("mesures_capacite_cible_debut_idx").on(t["cibleCode"] as never, t["debut"] as never),
    check("mesures_capacite_cible_code", code(t["cibleCode"])),
    check("mesures_capacite_valeurs", sql`${t["cpuBps"]} BETWEEN 0 AND 10000 AND ${t["memoireOctets"]} >= 0 AND ${t["disqueOctets"]} >= 0`),
  ],
);

// Modèle de message : clé, version, texte avec variables ({prenom}). Ajout seul : une correction est une nouvelle version.
export const modelesMessages = tableCommune(
  "modeles_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cle: text("cle").notNull(),
    version: integer("version").notNull(),
    texte: text("texte").notNull(),
    creePar: text("cree_par").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("modeles_messages_cle_version_unique").on(t["cle"] as never, t["version"] as never),
    check("modeles_messages_cle_code", code(t["cle"])),
    check("modeles_messages_version_positive", sql`${t["version"]} >= 1`),
    check("modeles_messages_texte_borne", sql`${nonVide(t["texte"])} AND ${borne(t["texte"], 4000)}`),
    check("modeles_messages_cree_par_borne", acteur(t["creePar"])),
  ],
);

// Bilan d'incident : une référence de document par incident (jamais le texte), ajout seul.
export const bilansIncident = tableCommune(
  "bilans_incident",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id").notNull().references(() => incidents.id, { onDelete: "restrict" }),
    referenceDocument: text("reference_document").notNull(),
    redigePar: text("redige_par").notNull(),
    redigeLe: timestamp("redige_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("bilans_incident_incident_unique").on(t["incidentId"] as never),
    check("bilans_incident_reference_forme", sql`${t["referenceDocument"]} ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$' AND ${t["referenceDocument"]} !~ '\\.\\.'`),
    check("bilans_incident_redige_par_borne", acteur(t["redigePar"])),
  ],
);

// Fenêtre de maintenance annoncée : période, portée (vocabulaire fermé) et cible en code.
export const fenetresMaintenance = tableCommune(
  "fenetres_maintenance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    debut: timestamp("debut", { withTimezone: true }).notNull(),
    fin: timestamp("fin", { withTimezone: true }).notNull(),
    portee: porteeDisjoncteur("portee").notNull(),
    cibleCode: text("cible_code"),
    annonceeLe: timestamp("annoncee_le", { withTimezone: true }),
    auteur: text("auteur").notNull(),
  },
  (t) => [
    check("fenetres_maintenance_periode", sql`${t["fin"]} > ${t["debut"]}`),
    check("fenetres_maintenance_cible_code", sql`${t["cibleCode"]} IS NULL OR ${code(t["cibleCode"])}`),
    check("fenetres_maintenance_auteur_borne", acteur(t["auteur"])),
  ],
);

// Avis de dépréciation d'un fournisseur ou d'une dépendance : codes et échéance, rien de libre.
export const avisDepreciation = tableCommune(
  "avis_depreciation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fournisseur: text("fournisseur").notNull(),
    sujet: text("sujet").notNull(),
    echeance: date("echeance").notNull(),
    etat: etatAvis("etat").notNull().default("a_lire"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("avis_depreciation_unique").on(t["fournisseur"] as never, t["sujet"] as never, t["echeance"] as never),
    check("avis_depreciation_fournisseur_code", code(t["fournisseur"])),
    check("avis_depreciation_sujet_code", code(t["sujet"])),
  ],
);

// ===== Deux tables PAR CLIENT de la 0023 : elles citent une table commune (incidents) ou une table par client (alertes), donc portent un tenant_id et suivent la RLS. =====
// Lien incident → instance : c'est ELLE qui dit quels clients sont touchés (la table commune `incidents` ne le dit pas). Clés étrangères composées : l'instance d'un autre client répond comme une instance inexistante.
export const incidentsInstances = tableClient(
  "incidents_instances",
  {
    id: uuid("id").notNull(),
    incidentId: uuid("incident_id").notNull().references(() => incidents.id, { onDelete: "restrict" }),
    instanceId: uuid("instance_id").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      instanceFk("incidents_instances")(t),
      unique("incidents_instances_lien_unique").on(t["tenantId"] as never, t["incidentId"] as never, t["instanceId"] as never),
    ],
  },
);

// Commentaire d'équipe sur une alerte : ajout seul, auteur = l'appelant, 500 caractères au plus.
export const commentairesAlertes = tableClient(
  "commentaires_alertes",
  {
    id: uuid("id").notNull(),
    alerteId: uuid("alerte_id").notNull(),
    auteur: text("auteur").notNull(),
    texte: text("texte").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      foreignKey({ name: "commentaires_alertes_alerte_fk", columns: [t["tenantId"] as never, t["alerteId"] as never], foreignColumns: [alertes.tenantId, alertes.id] }),
      check("commentaires_alertes_auteur_borne", acteur(t["auteur"])),
      check("commentaires_alertes_texte_borne", sql`${nonVide(t["texte"])} AND ${borne(t["texte"], 500)}`),
    ],
  },
);
