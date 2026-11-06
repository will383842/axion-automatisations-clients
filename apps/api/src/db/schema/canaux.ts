import { bigint, check, date, foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tableClient } from "./aides.ts";
import { organisations } from "./clients.ts";

// Tables des canaux (C5, lot 2) : boîte d'envoi, faits reçus, lien CRM, file « à trancher », exclusions (ADR 0050).
// Aucune logique d'envoi ici (T2-14). Vocabulaires provisoires : une valeur s'ajoute plus tard (additif), jamais ne se renomme.
export const destinationEnvoi = pgEnum("destination_envoi", ["hub", "crm"]);
export const methodeEnvoi = pgEnum("methode_envoi", ["POST", "PUT", "PATCH", "DELETE"]);
export const etatEnvoi = pgEnum("etat_envoi", ["a_envoyer", "en_cours", "envoye", "echec"]);
export const sourceCanal = pgEnum("source_canal", ["hub", "crm"]);
export const resultatFait = pgEnum("resultat_fait", ["traite", "ignore", "a_trancher", "erreur"]);
export const etatLienCrm = pgEnum("etat_lien_crm", ["actif", "absorbe"]);
export const motifATrancher = pgEnum("motif_a_trancher", ["siren_absent_ressemblance", "ressaisie_manuelle", "email_change", "fiche_absorbee", "incoherence_nuit", "lien_crm_different", "identifiant_crm_incoherent"]);
export const etatATrancher = pgEnum("etat_a_trancher", ["ouvert", "tranche"]);
export const porteeExclusion = pgEnum("portee_exclusion", ["client", "plateforme"]);
export const motifExclusion = pgEnum("motif_exclusion", ["rebond", "plainte", "desabonnement", "demande_client"]);
export const sourceExclusion = pgEnum("source_exclusion", ["retour_rebond", "rapport_plainte", "lien_desinscription", "saisie_equipe"]);
export const typeCondition = pgEnum("type_condition", ["remise", "frais", "engagement", "garantie", "delai", "seuil_alerte", "periode"]);
export const sourceCondition = pgEnum("source_condition", ["defaut", "client"]);
export const gravite = pgEnum("gravite_alerte", ["information", "avertissement", "critique"]);
export const etatAlerte = pgEnum("etat_alerte", ["ouverte", "acquittee", "close"]);

const HEX64 = "^[0-9a-f]{64}$";

// Audit : false pour les quatre tables de volume ou de données de personnes (ADR 0050) ; liens_crm et a_trancher restent au journal.
export const boiteEnvoi = tableClient(
  "boite_envoi",
  {
    id: uuid("id").notNull(),
    destination: destinationEnvoi("destination").notNull(),
    route: text("route").notNull(),
    methode: methodeEnvoi("methode").notNull(),
    // Jamais de contenu de travail du client : seulement ce que le Hub ou le CRM reçoit.
    corps: jsonb("corps").notNull(),
    cleAntiDoublon: uuid("cle_anti_doublon").notNull(),
    empreinteCorps: text("empreinte_corps").notNull(),
    etat: etatEnvoi("etat").notNull().default("a_envoyer"),
    nombreEssais: integer("nombre_essais").notNull().default(0),
    prochainEssai: timestamp("prochain_essai", { withTimezone: true }),
    derniereErreur: text("derniere_erreur"),
    // La réponse sert à renvoyer « la même réponse » au rejeu : jamais tronquée.
    reponseRecue: jsonb("reponse_recue"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    audit: false,
    contraintes: (t) => [
      // Par client : une unicité globale serait un oracle d'existence entre clients (règle unicite_sans_tenant).
      unique("boite_envoi_tenant_id_cle_anti_doublon_unique").on(t["tenantId"] as never, t["cleAntiDoublon"] as never),
      // T2-52 : balayage des lignes dues sans parcours séquentiel.
      index("boite_envoi_dues_idx").on(t["destination"] as never, t["creeLe"] as never).where(sql`${t["etat"]} IN ('a_envoyer', 'en_cours')`),
      check("boite_envoi_empreinte_format", sql`${t["empreinteCorps"]} ~ '${sql.raw(HEX64)}'`),
      check("boite_envoi_essais_positifs", sql`${t["nombreEssais"]} >= 0`),
      check("boite_envoi_derniere_erreur_code", sql`${t["derniereErreur"]} ~ '^[a-z0-9_.-]{1,64}$'`),
    ],
  },
);

export const faitsRecus = tableClient(
  "faits_recus",
  {
    id: uuid("id").notNull(),
    source: sourceCanal("source").notNull(),
    eventId: uuid("event_id").notNull(),
    type: text("type").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    sujet: text("sujet").notNull(),
    recuLe: timestamp("recu_le", { withTimezone: true }).notNull().defaultNow(),
    traiteLe: timestamp("traite_le", { withTimezone: true }),
    resultat: resultatFait("resultat"),
    // Contenu allégé du fait (liste autorisée de champs, jamais de lien ni de PII) : la base est la source, la file n'en est qu'une copie (T2-16b).
    payload: jsonb("payload"),
  },
  {
    audit: false,
    contraintes: (t) => [
      unique("faits_recus_tenant_id_source_event_id_unique").on(t["tenantId"] as never, t["source"] as never, t["eventId"] as never),
      check("faits_recus_traitement_complet", sql`(${t["traiteLe"]} IS NULL) = (${t["resultat"]} IS NULL)`),
      // Ordre par sujet et balayage des faits non traités (T2-16b) : toujours bornés par le client.
      index("faits_recus_sujet_idx").on(t["tenantId"] as never, t["sujet"] as never, t["sequence"] as never),
      index("faits_recus_non_traites_idx").on(t["tenantId"] as never, t["recuLe"] as never).where(sql`${t["traiteLe"]} IS NULL`),
    ],
  },
);

export const liensCrm = tableClient(
  "liens_crm",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    crmCompanyId: text("crm_company_id").notNull(),
    etat: etatLienCrm("etat").notNull().default("actif"),
    absorbePar: text("absorbe_par"),
  },
  {
    contraintes: (t) => [
      foreignKey({ name: "liens_crm_organisation_fk", columns: [t["tenantId"] as never, t["organisationId"] as never], foreignColumns: [organisations.tenantId, organisations.id] }),
      unique("liens_crm_tenant_id_crm_company_id_unique").on(t["tenantId"] as never, t["crmCompanyId"] as never),
      check("liens_crm_absorbe_complet", sql`(${t["etat"]} = 'absorbe') = (${t["absorbePar"]} IS NOT NULL)`),
    ],
  },
);

export const aTrancher = tableClient(
  "a_trancher",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id"),
    source: sourceCanal("source").notNull(),
    motif: motifATrancher("motif").notNull(),
    // Métadonnées seulement : jamais le texte d'un message ni d'une demande.
    donneesComparaison: jsonb("donnees_comparaison").notNull().default(sql`'{}'::jsonb`),
    etat: etatATrancher("etat").notNull().default("ouvert"),
    tranchePar: text("tranche_par"),
    decision: text("decision"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      foreignKey({ name: "a_trancher_organisation_fk", columns: [t["tenantId"] as never, t["organisationId"] as never], foreignColumns: [organisations.tenantId, organisations.id] }),
      // T2-52 : anti-doublon par client de la cohérence de nuit (T2-20) et des demandes du Hub (T2-15).
      uniqueIndex("a_trancher_incoherence_nuit_ouverte_unique").on(t["tenantId"] as never, sql`(${t["donneesComparaison"]}->>'cle')`).where(sql`${t["etat"]} = 'ouvert' AND ${t["motif"]} = 'incoherence_nuit'`),
      uniqueIndex("a_trancher_demande_hub_ouverte_unique").on(t["tenantId"] as never, sql`(${t["donneesComparaison"]}->>'idDemande')`).where(sql`${t["etat"]} = 'ouvert' AND ${t["source"]} = 'hub' AND ${t["donneesComparaison"]} ? 'idDemande'`),
      check(
        "a_trancher_cloture",
        sql`(${t["etat"]} = 'ouvert' AND ${t["decision"]} IS NULL AND ${t["tranchePar"]} IS NULL) OR (${t["etat"]} = 'tranche' AND coalesce(length(btrim(${t["decision"]})), 0) > 0 AND coalesce(length(btrim(${t["tranchePar"]})), 0) > 0)`,
      ),
    ],
  },
);

// Exclusions propres à un client. La portée « plateforme » n'a pas de ligne ici (pas de client) : elle vit dans exclusions_plateforme.
// Jamais l'e-mail : seulement l'empreinte SHA-256 de l'e-mail en minuscules.
export const exclusions = tableClient(
  "exclusions",
  {
    id: uuid("id").notNull(),
    portee: porteeExclusion("portee").notNull().default("client"),
    empreinteEmail: text("empreinte_email").notNull(),
    motif: motifExclusion("motif").notNull(),
    source: sourceExclusion("source").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    audit: false,
    contraintes: (t) => [
      unique("exclusions_tenant_id_empreinte_email_unique").on(t["tenantId"] as never, t["empreinteEmail"] as never),
      check("exclusions_empreinte_format", sql`${t["empreinteEmail"]} ~ '${sql.raw(HEX64)}'`),
      check("exclusions_portee_client", sql`${t["portee"]} = 'client'`),
    ],
  },
);

// Liste commune à tous les clients : table SANS tenant_id, inscrite dans TABLES_COMMUNES (invariants C5). Lecture par console_app, écriture par console_equipe seul.
export const exclusionsPlateforme = pgTable(
  "exclusions_plateforme",
  {
    empreinteEmail: text("empreinte_email").primaryKey(),
    motif: motifExclusion("motif").notNull(),
    source: sourceExclusion("source").notNull(),
    // Une adresse bloquée pour tous les clients : on sait toujours qui l'a ajoutée.
    ajoutePar: text("ajoute_par").notNull(),
    creeLe: date("cree_le").notNull().defaultNow(),
  },
  (t) => [
    check("exclusions_plateforme_auteur_non_vide", sql`length(btrim(${t.ajoutePar})) > 0`),
    check("exclusions_plateforme_empreinte_format", sql`${t.empreinteEmail} ~ '${sql.raw(HEX64)}'`),
    check("exclusions_plateforme_motif_commun", sql`${t.motif} IN ('rebond', 'plainte')`),
  ],
);

// Lignes sans client (ADR 0040) : valeurs globales d'AXION, lues par d'autres fiches. `tenant_id` reste OBLIGATOIRE ; les lignes globales
// appartiennent à l'organisation réservée « plateforme » (PLATEFORME_ID). Lecture par console_app : client actif OU plateforme ; écriture par console_equipe seul.
// Réglage global du délai de proposition de suppression (lu par T2-45) : ajout seul, la valeur en vigueur est la dernière ligne ; la première (24) est posée par la migration.
export const reglageGlobalFinDeContrat = tableClient(
  "reglage_global_fin_de_contrat",
  {
    id: uuid("id").notNull(),
    delaiPropositionSuppressionMois: integer("delai_proposition_suppression_mois").notNull(),
    auteur: text("auteur").notNull(),
    changeLe: timestamp("change_le", { withTimezone: true }).notNull().defaultNow(),
  },
  // audit: false pour les trois tables : console_equipe, seul à y écrire, ne peut pas exécuter audit_ajouter (ADR 0050). L'auteur est dans la ligne.
  { audit: false, contraintes: (t) => [check("reglage_global_delai_minimal", sql`${t["delaiPropositionSuppressionMois"]} >= 2`)] },
);

// Conditions par défaut d'AXION (lues par T2-04 et T2-08) : mêmes colonnes que conditions_commerciales de T2-04, source toujours `defaut`.
export const conditionsParDefaut = tableClient(
  "conditions_par_defaut",
  {
    id: uuid("id").notNull(),
    type: typeCondition("type").notNull(),
    valeur: jsonb("valeur").notNull(),
    source: sourceCondition("source").notNull().default("defaut"),
    valideDu: date("valide_du"),
    valideAu: date("valide_au"),
    // T2-03 : ces conditions portent de l'argent, on sait toujours qui les a écrites ; leur journal d'audit est posé par la migration 0007.
    auteur: text("auteur").notNull(),
  },
  {
    audit: false,
    contraintes: (t) => [
      check("conditions_par_defaut_auteur_non_vide", sql`length(btrim(${t["auteur"]})) > 0`),
      check("conditions_par_defaut_source_defaut", sql`${t["source"]} = 'defaut'`),
      check("conditions_par_defaut_validite", sql`${t["valideDu"]} IS NULL OR ${t["valideAu"]} IS NULL OR ${t["valideAu"]} >= ${t["valideDu"]}`),
    ],
  },
);

// Alertes de la plateforme (lues par T2-06) : mêmes colonnes que alertes de T2-06, sans organisation.
export const alertesPlateforme = tableClient(
  "alertes_plateforme",
  {
    id: uuid("id").notNull(),
    type: text("type").notNull(),
    gravite: gravite("gravite").notNull(),
    regle: text("regle").notNull(),
    etat: etatAlerte("etat").notNull().default("ouverte"),
    assigneeA: text("assignee_a"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  { audit: false },
);
