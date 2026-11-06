import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, pgEnum, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tableClient, tableCommune } from "./aides.ts";
import { automatisations, grillesPrix } from "./catalogue.ts";
import { organisations } from "./clients.ts";
import { demandes, registreTraitements } from "./suivi.ts";

// Conformité : registre par client, sous-traitants ultérieurs, signatures de fiches, demandes de droits, violations, AIPD, historique des grilles (T3-05b, ADR 0115, migration 0021).
// AJOUT SEUL. C-034 : demandes_droits, incidents_violations et aipd n'ont ni texte libre ni texte de personne, seulement des dates, des énumérations et des références de forme fermée.
// Les trois tables communes sont écrites par console_equipe SEUL, en ajout seul : une correction est une nouvelle ligne.
// `automatisations.lit_contenu` (C-616) n'est PAS ajoutée ici : catalogue.ts est hors des fichiers autorisés (ESCALADE E1 du plan, dette T3-05b-dette-lit-contenu).
export const natureDemandeDroits = pgEnum("nature_demande_droits", ["acces", "rectification", "effacement", "limitation", "portabilite", "opposition"]);
export const statutDemandeDroits = pgEnum("statut_demande_droits", ["recue", "en_cours", "repondue", "refusee"]);
export const niveauViolation = pgEnum("niveau_violation", ["faible", "moyen", "eleve"]);
export const statutViolation = pgEnum("statut_violation", ["ouverte", "notifiee", "close"]);
export const statutAipd = pgEnum("statut_aipd", ["a_faire", "en_cours", "validee", "a_revoir"]);
export const champGrillePrix = pgEnum("champ_grille_prix", ["installation", "mensuel", "maintenance_ensuite", "maintenance_incluse_mois"]);

const nonVide = (c: unknown) => sql`length(btrim(${c})) > 0`;
const borne = (c: unknown, max: number) => sql`char_length(${c}) <= ${sql.raw(String(max))}`;
const CODE = "^[a-z][a-z0-9_.-]{0,63}$";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REFERENCE = "^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$";
const organisationFk = (nom: string) => (t: Record<string, unknown>) =>
  foreignKey({ name: `${nom}_organisation_fk`, columns: [t["tenantId"] as never, t["organisationId"] as never], foreignColumns: [organisations.tenantId, organisations.id] });
const demandeFk = (nom: string) => (t: Record<string, unknown>) =>
  foreignKey({ name: `${nom}_demande_fk`, columns: [t["tenantId"] as never, t["demandeId"] as never], foreignColumns: [demandes.tenantId, demandes.id] });

// Registre par client : renvoie à un traitement commun (T2-07). Le fournisseur d'IA du client est noté comme son propre sous-traitant. Refus de tout transfert hors UE : vrai par défaut (prudent).
export const registreClient = tableClient(
  "registre_client",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    traitementId: uuid("traitement_id").notNull().references(() => registreTraitements.id, { onDelete: "restrict" }),
    fournisseurIaCode: text("fournisseur_ia_code"),
    fournisseurIaDuClient: boolean("fournisseur_ia_du_client").notNull().default(false),
    refusTransfertHorsUe: boolean("refus_transfert_hors_ue").notNull().default(true),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      organisationFk("registre_client")(t),
      unique("registre_client_traitement_unique").on(t["tenantId"] as never, t["organisationId"] as never, t["traitementId"] as never),
      check("registre_client_fournisseur_code", sql`${t["fournisseurIaCode"]} IS NULL OR ${t["fournisseurIaCode"]} ~ '${sql.raw(CODE)}'`),
      check("registre_client_fournisseur_coherent", sql`NOT ${t["fournisseurIaDuClient"]} OR ${t["fournisseurIaCode"]} IS NOT NULL`),
    ],
  },
);

// Sous-traitants ultérieurs (COMMUNE) : l'effet est au plus tôt 30 jours après l'annonce. Pays : code à deux lettres.
export const sousTraitantsUlterieurs = tableCommune(
  "sous_traitants_ulterieurs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nom: text("nom").notNull(),
    service: text("service").notNull(),
    pays: text("pays").notNull(),
    annonceLe: date("annonce_le").notNull(),
    dateEffet: date("date_effet").notNull(),
    ajoutePar: text("ajoute_par").notNull(),
    ajouteLe: timestamp("ajoute_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("sous_traitants_ulterieurs_nom_service_unique").on(t["nom"] as never, t["service"] as never),
    check("sous_traitants_ulterieurs_nom_borne", sql`${nonVide(t["nom"])} AND ${borne(t["nom"], 200)}`),
    check("sous_traitants_ulterieurs_service_borne", sql`${nonVide(t["service"])} AND ${borne(t["service"], 200)}`),
    check("sous_traitants_ulterieurs_pays_iso", sql`${t["pays"]} ~ '^[A-Z]{2}$'`),
    check("sous_traitants_ulterieurs_effet_30_jours", sql`${t["dateEffet"]} >= ${t["annonceLe"]} + 30`),
    check("sous_traitants_ulterieurs_ajoute_par_borne", sql`${nonVide(t["ajoutePar"])} AND ${borne(t["ajoutePar"], 200)}`),
  ],
);

// Signature d'une version de fiche (COMMUNE) : empreinte SHA-256 en hexadécimal minuscule.
export const signaturesFiches = tableCommune(
  "signatures_fiches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fiche: text("fiche").notNull(),
    version: integer("version").notNull(),
    empreinteSha256: text("empreinte_sha256").notNull(),
    signeePar: text("signee_par").notNull(),
    signeeLe: timestamp("signee_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("signatures_fiches_fiche_version_unique").on(t["fiche"] as never, t["version"] as never),
    check("signatures_fiches_fiche_code", sql`${t["fiche"]} ~ '${sql.raw(CODE)}'`),
    check("signatures_fiches_version_positive", sql`${t["version"]} >= 1`),
    check("signatures_fiches_empreinte_forme", sql`${t["empreinteSha256"]} ~ '^[0-9a-f]{64}$'`),
    check("signatures_fiches_signee_par_borne", sql`${nonVide(t["signeePar"])} AND ${borne(t["signeePar"], 200)}`),
  ],
);

// Demande d'exercice de droits (PAR CLIENT) : référence de forme fermée, échéance calculée par l'API et rangée en date. Jamais de texte libre (C-034).
export const demandesDroits = tableClient(
  "demandes_droits",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    reference: text("reference").notNull(),
    nature: natureDemandeDroits("nature").notNull(),
    statut: statutDemandeDroits("statut").notNull().default("recue"),
    demandeId: uuid("demande_id"),
    recueLe: timestamp("recue_le", { withTimezone: true }).notNull(),
    echeanceLe: date("echeance_le").notNull(),
    repondueLe: timestamp("repondue_le", { withTimezone: true }),
    referenceReponse: text("reference_reponse"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      organisationFk("demandes_droits")(t),
      demandeFk("demandes_droits")(t),
      unique("demandes_droits_reference_unique").on(t["tenantId"] as never, t["reference"] as never),
      check("demandes_droits_reference_forme", sql`${t["reference"]} ~ '^droits:${sql.raw(UUID)}$'`),
      check("demandes_droits_reference_longueur", borne(t["reference"], 64)),
      check("demandes_droits_reponse_forme", sql`${t["referenceReponse"]} IS NULL OR ${t["referenceReponse"]} ~ '${sql.raw(REFERENCE)}'`),
      check("demandes_droits_echeance_apres_reception", sql`${t["echeanceLe"]} >= (${t["recueLe"]} AT TIME ZONE 'Europe/Paris')::date`),
      check("demandes_droits_reponse_coherente", sql`(${t["repondueLe"]} IS NULL) = (${t["statut"]} IN ('recue', 'en_cours'))`),
      index("demandes_droits_echeance_idx").on(t["tenantId"] as never, t["echeanceLe"] as never).where(sql`${t["repondueLe"]} IS NULL`),
    ],
  },
);

// Violation de données (PAR CLIENT) : dates, niveau, références. L'échéance de notification n'est pas modifiable (on ne la repousse pas).
export const incidentsViolations = tableClient(
  "incidents_violations",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    reference: text("reference").notNull(),
    niveau: niveauViolation("niveau").notNull(),
    statut: statutViolation("statut").notNull().default("ouverte"),
    demandeId: uuid("demande_id"),
    detecteLe: timestamp("detecte_le", { withTimezone: true }).notNull(),
    echeanceNotificationLe: timestamp("echeance_notification_le", { withTimezone: true }).notNull(),
    notifieAutoriteLe: timestamp("notifie_autorite_le", { withTimezone: true }),
    notifiePersonnesLe: timestamp("notifie_personnes_le", { withTimezone: true }),
    referenceDossier: text("reference_dossier"),
    closeLe: timestamp("close_le", { withTimezone: true }),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      organisationFk("incidents_violations")(t),
      demandeFk("incidents_violations")(t),
      unique("incidents_violations_reference_unique").on(t["tenantId"] as never, t["reference"] as never),
      check("incidents_violations_reference_forme", sql`${t["reference"]} ~ '^violation:${sql.raw(UUID)}$'`),
      check("incidents_violations_reference_longueur", borne(t["reference"], 64)),
      check("incidents_violations_dossier_forme", sql`${t["referenceDossier"]} IS NULL OR ${t["referenceDossier"]} ~ '${sql.raw(REFERENCE)}'`),
      check("incidents_violations_echeance_apres_detection", sql`${t["echeanceNotificationLe"]} > ${t["detecteLe"]}`),
      check("incidents_violations_cloture", sql`(${t["closeLe"]} IS NULL) = (${t["statut"]} <> 'close')`),
      index("incidents_violations_echeance_idx").on(t["tenantId"] as never, t["echeanceNotificationLe"] as never).where(sql`${t["notifieAutoriteLe"]} IS NULL`),
    ],
  },
);

// Analyse d'impact (PAR CLIENT) : une seule AIPD non validée par (client, organisation, automatisation). Le document est cité par sa référence, jamais recopié.
export const aipd = tableClient(
  "aipd",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    automatisationId: uuid("automatisation_id").notNull().references(() => automatisations.id, { onDelete: "restrict" }),
    statut: statutAipd("statut").notNull().default("a_faire"),
    ouverteLe: timestamp("ouverte_le", { withTimezone: true }).notNull().defaultNow(),
    echeanceLe: date("echeance_le").notNull(),
    valideeLe: timestamp("validee_le", { withTimezone: true }),
    revueLe: date("revue_le"),
    referenceDocument: text("reference_document"),
  },
  {
    contraintes: (t) => [
      organisationFk("aipd")(t),
      check("aipd_document_forme", sql`${t["referenceDocument"]} IS NULL OR (${t["referenceDocument"]} ~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$' AND ${t["referenceDocument"]} !~ '\\.\\.')`),
      check("aipd_validation_coherente", sql`(${t["valideeLe"]} IS NULL) = (${t["statut"]} <> 'validee')`),
      uniqueIndex("aipd_une_ouverte").on(t["tenantId"] as never, t["organisationId"] as never, t["automatisationId"] as never).where(sql`${t["statut"]} <> 'validee'`),
    ],
  },
);

// Historique des grilles de prix (COMMUNE, ajout seul) : montants en centimes entiers, auteur = acteur. `raison` (et non « motif », réservé aux énumérations, invariant 5).
export const historiqueGrillesPrix = tableCommune(
  "historique_grilles_prix",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grilleId: uuid("grille_id").notNull().references(() => grillesPrix.id, { onDelete: "restrict" }),
    grillePrecedenteId: uuid("grille_precedente_id").references(() => grillesPrix.id, { onDelete: "restrict" }),
    champ: champGrillePrix("champ").notNull(),
    ancienneValeurCentimes: bigint("ancienne_valeur_centimes", { mode: "number" }),
    nouvelleValeurCentimes: bigint("nouvelle_valeur_centimes", { mode: "number" }).notNull(),
    auteur: text("auteur").notNull(),
    raison: text("raison").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("historique_grilles_prix_champ_unique").on(t["grilleId"] as never, t["champ"] as never),
    check("historique_grilles_prix_valeurs_positives", sql`(${t["ancienneValeurCentimes"]} IS NULL OR ${t["ancienneValeurCentimes"]} >= 0) AND ${t["nouvelleValeurCentimes"]} >= 0`),
    check("historique_grilles_prix_precedente_distincte", sql`${t["grillePrecedenteId"]} IS NULL OR ${t["grillePrecedenteId"]} <> ${t["grilleId"]}`),
    check("historique_grilles_prix_auteur_borne", sql`${nonVide(t["auteur"])} AND ${borne(t["auteur"], 200)}`),
    check("historique_grilles_prix_raison_borne", sql`${nonVide(t["raison"])} AND ${borne(t["raison"], 500)}`),
    index("historique_grilles_prix_grille_idx").on(t["grilleId"] as never, t["creeLe"] as never),
  ],
);
