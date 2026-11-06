import { bigint, check, date, foreignKey, integer, pgEnum, text, timestamp, unique, uuid, type PgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tableClient } from "./aides.ts";
import { organisations } from "./clients.ts";

// Registre des bases des clients et fin de contrat (lot 2b, T2-30) : métadonnées seulement, jamais de données de travail du client.
// Vocabulaires provisoires quand la fiche ne les fixe pas (état d'une fin de contrat) : une valeur s'ajoute plus tard, jamais ne se renomme.
export const etatBaseClient = pgEnum("etat_base_client", ["en_creation", "active", "gelee", "exportee", "a_l_ecart", "effacee"]);
export const resultatVersion = pgEnum("resultat_version", ["ok", "echec", "quarantaine"]);
export const etatFinDeContrat = pgEnum("etat_fin_de_contrat", ["preavis", "export_disponible", "a_l_ecart", "effacee"]);
export const roleConfirmation = pgEnum("role_confirmation", ["will", "second_administrateur"]);
export const etatDemandeEffacement = pgEnum("etat_demande_effacement", ["en_attente", "acceptee", "refusee"]);
export const decisionEffacement = pgEnum("decision_effacement", ["accepter", "refuser", "ecarter"]);
export const causeEffacement = pgEnum("cause_effacement", ["litige_en_cours", "obligation_legale", "decision_de_will"]);
export const etatProposition = pgEnum("etat_proposition", ["en_attente", "acceptee", "ecartee", "reexamen", "executee"]);
export const natureAttestation = pgEnum("nature_attestation", ["mise_a_l_ecart", "effacement"]);

const instant = (nom: string) => timestamp(nom, { withTimezone: true });
const cle = (t: Record<string, unknown>, ...noms: string[]) => noms.map((n) => t[n] as never);
// Clé étrangère composée (tenant_id, x) vers UNIQUE (tenant_id, id) de la cible (règle etrangere_sans_tenant, ADR 0040).
const lien = (nom: string, t: Record<string, unknown>, colonne: string, cible: unknown) => {
  const c = cible as { tenantId: PgColumn; id: PgColumn };
  return foreignKey({ name: nom, columns: [t["tenantId"] as PgColumn, t[colonne] as PgColumn], foreignColumns: [c.tenantId, c.id] });
};

// Les colonnes de texte libre ne portent pas le nom d'un vocabulaire (motif, etat…) : la règle vocabulaire_en_texte de C5 les voudrait en énumération.
// nom_base est DÉRIVÉ de tenant_id : aucun index unique sur nom_base seul (oracle d'existence entre clients, règle unicite_sans_tenant).
export const basesClient = tableClient(
  "bases_client",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    grappe: text("grappe").notNull(),
    nomBase: text("nom_base").notNull(),
    versionStructure: integer("version_structure").notNull().default(0),
    tailleOctets: bigint("taille_octets", { mode: "number" }).notNull().default(0),
    quotaBaseOctets: bigint("quota_base_octets", { mode: "number" }),
    quotaFichiersOctets: bigint("quota_fichiers_octets", { mode: "number" }),
    quotaPersonnes: integer("quota_personnes"),
    derniereSauvegarde: instant("derniere_sauvegarde"),
    dernierTestRestauration: instant("dernier_test_restauration"),
    etat: etatBaseClient("etat").notNull().default("en_creation"),
    etapeProvisionnement: integer("etape_provisionnement").notNull().default(0),
    derniereErreur: text("derniere_erreur"),
  },
  {
    contraintes: (t) => [
      lien("bases_client_organisation_fk", t, "organisationId", organisations),
      unique("bases_client_tenant_id_nom_base_unique").on(...(cle(t, "tenantId", "nomBase") as [never, never])),
      check("bases_client_nom_base_derive", sql`${t["nomBase"]} = 'cli_' || replace(${t["tenantId"]}::text, '-', '')`),
      check("bases_client_derniere_erreur_code", sql`${t["derniereErreur"]} ~ '^[a-z0-9_.-]{1,64}$'`),
      check("bases_client_mesures_positives", sql`${t["tailleOctets"]} >= 0 AND ${t["etapeProvisionnement"]} >= 0 AND ${t["versionStructure"]} >= 0`),
    ],
  },
);

export const versionsStructure = tableClient(
  "versions_structure",
  {
    id: uuid("id").notNull(),
    baseId: uuid("base_id").notNull(),
    version: integer("version").notNull(),
    appliqueeLe: instant("appliquee_le").notNull().defaultNow(),
    resultat: resultatVersion("resultat").notNull(),
    vague: integer("vague"),
  },
  { contraintes: (t) => [lien("versions_structure_base_fk", t, "baseId", basesClient)] },
);

// Préavis J+1, J+20, J+27 : date d'envoi et preuve d'accusé de chacun (six colonnes, pas de table hors liste).
export const finsDeContrat = tableClient(
  "fins_de_contrat",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    dateFin: date("date_fin").notNull(),
    preavisJ1EnvoyeLe: instant("preavis_j1_envoye_le"),
    preavisJ1Accuse: text("preavis_j1_accuse"),
    preavisJ20EnvoyeLe: instant("preavis_j20_envoye_le"),
    preavisJ20Accuse: text("preavis_j20_accuse"),
    preavisJ27EnvoyeLe: instant("preavis_j27_envoye_le"),
    preavisJ27Accuse: text("preavis_j27_accuse"),
    exportReference: text("export_reference"),
    exportExpireLe: instant("export_expire_le"),
    exportTelechargeLe: instant("export_telecharge_le"),
    etat: etatFinDeContrat("etat").notNull().default("preavis"),
  },
  { contraintes: (t) => [lien("fins_de_contrat_organisation_fk", t, "organisationId", organisations)] },
);

export const confirmationsMiseAEcart = tableClient(
  "confirmations_mise_a_l_ecart",
  {
    id: uuid("id").notNull(),
    finDeContratId: uuid("fin_de_contrat_id").notNull(),
    confirmateur: uuid("confirmateur").notNull(),
    role: roleConfirmation("role").notNull(),
    confirmeeLe: instant("confirmee_le").notNull().defaultNow(),
    reauthLe: instant("reauth_le").notNull(),
  },
  {
    contraintes: (t) => [
      lien("confirmations_fin_de_contrat_fk", t, "finDeContratId", finsDeContrat),
      unique("confirmations_tenant_id_fin_role_unique").on(...(cle(t, "tenantId", "finDeContratId", "role") as [never, never, never])),
    ],
  },
);

export const demandesEffacement = tableClient(
  "demandes_effacement",
  {
    id: uuid("id").notNull(),
    finDeContratId: uuid("fin_de_contrat_id").notNull(),
    recueLe: instant("recue_le").notNull().defaultNow(),
    ecritReference: text("ecrit_reference").notNull(),
    etat: etatDemandeEffacement("etat").notNull().default("en_attente"),
  },
  { contraintes: (t) => [lien("demandes_fin_de_contrat_fk", t, "finDeContratId", finsDeContrat)] },
);

export const gelsLitige = tableClient(
  "gels_litige",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    motifLitige: text("motif_litige").notNull(),
    poseeLe: instant("posee_le").notNull().defaultNow(),
    poseePar: text("posee_par").notNull(),
    leveeLe: instant("levee_le"),
    levePar: text("leve_par"),
    // T2-52 : motif de la levée, relu sur le gel levé. Jamais effacé (aucun DELETE).
    motifLevee: text("motif_levee"),
  },
  {
    contraintes: (t) => [
      lien("gels_litige_organisation_fk", t, "organisationId", organisations),
      check("gels_litige_motif_levee_borne", sql`${t["motifLevee"]} IS NULL OR (length(btrim(${t["motifLevee"]})) > 0 AND char_length(${t["motifLevee"]}) <= 500)`),
      // Un motif de levée n'existe que sur un gel levé ; la levée sans motif n'est pas encore refusée (leverGel, repris par T2-52b, n'écrit pas encore le motif).
      check("gels_litige_motif_avec_levee", sql`${t["motifLevee"]} IS NULL OR ${t["leveeLe"]} IS NOT NULL`),
      check("gels_litige_motif_non_vide", sql`length(btrim(${t["motifLitige"]})) > 0`),
      check("gels_litige_levee_complete", sql`(${t["leveeLe"]} IS NULL) = (${t["levePar"]} IS NULL) AND (${t["leveeLe"]} IS NULL OR ${t["leveeLe"]} >= ${t["poseeLe"]})`),
    ],
  },
);

// echeance : date à laquelle une PROPOSITION est créée, jamais une date de suppression (C-623). Transitions gardées par propositions_transition (déclencheur).
export const propositionsSuppression = tableClient(
  "propositions_suppression",
  {
    id: uuid("id").notNull(),
    finDeContratId: uuid("fin_de_contrat_id").notNull(),
    echeance: date("echeance").notNull(),
    etat: etatProposition("etat").notNull().default("en_attente"),
    gelId: uuid("gel_id"),
    creeLe: instant("cree_le").notNull().defaultNow(),
    avisClientLe: instant("avis_client_le"),
    avisClientPreuve: text("avis_client_preuve"),
    rappelsEnvoyes: integer("rappels_envoyes").notNull().default(0),
  },
  {
    contraintes: (t) => [
      lien("propositions_fin_de_contrat_fk", t, "finDeContratId", finsDeContrat),
      lien("propositions_gel_fk", t, "gelId", gelsLitige),
      unique("propositions_tenant_id_fin_echeance_unique").on(...(cle(t, "tenantId", "finDeContratId", "echeance") as [never, never, never])),
      check("propositions_rappels_positifs", sql`${t["rappelsEnvoyes"]} >= 0`),
    ],
  },
);

export const decisionsEffacement = tableClient(
  "decisions_effacement",
  {
    id: uuid("id").notNull(),
    demandeId: uuid("demande_id"),
    propositionId: uuid("proposition_id"),
    decideur: uuid("decideur").notNull(),
    decision: decisionEffacement("decision").notNull(),
    motifEcrit: text("motif_ecrit").notNull(),
    cause: causeEffacement("cause"),
    gelId: uuid("gel_id"),
    referenceTexte: text("reference_texte"),
    decideeLe: instant("decidee_le").notNull().defaultNow(),
    reauthLe: instant("reauth_le").notNull(),
  },
  {
    contraintes: (t) => [
      lien("decisions_demande_fk", t, "demandeId", demandesEffacement),
      lien("decisions_proposition_fk", t, "propositionId", propositionsSuppression),
      lien("decisions_gel_fk", t, "gelId", gelsLitige),
      check("decisions_une_seule_cible", sql`num_nonnulls(${t["demandeId"]}, ${t["propositionId"]}) = 1`),
      check("decisions_motif_non_vide", sql`length(btrim(${t["motifEcrit"]})) > 0`),
      check("decisions_cause_selon_decision", sql`(${t["decision"]} = 'accepter' AND ${t["cause"]} IS NULL) OR (${t["decision"]} IN ('refuser', 'ecarter') AND ${t["cause"]} IS NOT NULL)`),
      check("decisions_decision_de_will_ecarter", sql`${t["cause"]} IS DISTINCT FROM 'decision_de_will' OR ${t["decision"]} = 'ecarter'`),
      check("decisions_gel_si_litige", sql`${t["cause"]} IS DISTINCT FROM 'litige_en_cours' OR ${t["gelId"]} IS NOT NULL`),
      check("decisions_texte_si_obligation", sql`${t["cause"]} IS DISTINCT FROM 'obligation_legale' OR coalesce(length(btrim(${t["referenceTexte"]})), 0) > 0`),
    ],
  },
);

export const reglagesFinDeContrat = tableClient(
  "reglages_fin_de_contrat",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    delaiPropositionSuppressionMois: integer("delai_proposition_suppression_mois").notNull(),
    auteur: text("auteur").notNull(),
    changeLe: instant("change_le").notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      lien("reglages_organisation_fk", t, "organisationId", organisations),
      check("reglages_delai_minimal", sql`${t["delaiPropositionSuppressionMois"]} >= 2`),
    ],
  },
);

export const attestationsFinDeContrat = tableClient(
  "attestations_fin_de_contrat",
  {
    id: uuid("id").notNull(),
    finDeContratId: uuid("fin_de_contrat_id").notNull(),
    nature: natureAttestation("nature").notNull(),
    pdfReference: text("pdf_reference").notNull(),
    empreinteSha256: text("empreinte_sha256").notNull(),
  },
  {
    contraintes: (t) => [
      lien("attestations_fin_de_contrat_fk", t, "finDeContratId", finsDeContrat),
      check("attestations_empreinte_format", sql`${t["empreinteSha256"]} ~ '^[0-9a-f]{64}$'`),
    ],
  },
);

export const visibiliteAcces = tableClient(
  "visibilite_acces",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    lienRetour: text("lien_retour"),
    pageReference: text("page_reference"),
    accordsEcritsLe: date("accords_ecrits_le").array().notNull().default(sql`'{}'`),
    interventionPerimetre: text("intervention_perimetre"),
    interventionDebut: instant("intervention_debut"),
    interventionFin: instant("intervention_fin"),
  },
  {
    contraintes: (t) => [
      lien("visibilite_organisation_fk", t, "organisationId", organisations),
      unique("visibilite_tenant_id_organisation_unique").on(...(cle(t, "tenantId", "organisationId") as [never, never])),
      check("visibilite_intervention_complete", sql`(${t["interventionPerimetre"]} IS NULL) = (${t["interventionDebut"]} IS NULL) AND (${t["interventionDebut"]} IS NULL) = (${t["interventionFin"]} IS NULL) AND (${t["interventionFin"]} IS NULL OR ${t["interventionFin"]} > ${t["interventionDebut"]})`),
    ],
  },
);
