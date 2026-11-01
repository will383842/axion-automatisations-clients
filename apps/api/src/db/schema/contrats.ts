import { bigint, check, date, foreignKey, integer, pgEnum, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tableClient } from "./aides.ts";
import { instances, organisations } from "./clients.ts";

// Contrats, devis, factures et apporteurs (C5, lot 2, ADR 0053). Copie des faits du Hub : la console ne crée ni ne corrige jamais une facture.
// Vocabulaires provisoires : une valeur s'ajoute plus tard (additif), jamais ne se renomme.
export const typeContrat = pgEnum("type_contrat", ["contrat_service", "sous_traitance_art28", "bon_de_commande", "autre"]);
export const statutDevis = pgEnum("statut_devis", ["brouillon", "envoye", "accepte", "refuse", "expire", "annule"]);
export const natureFacture = pgEnum("nature_facture", ["abonnement", "mise_en_place", "complement_prorata", "avoir"]);
export const statutFacture = pgEnum("statut_facture", ["emise", "payee", "impayee", "annulee"]);

const HEX64 = "^[0-9a-f]{64}$";
// Référence d'un objet du stockage : jamais le PDF lui-même (pas de base64 : ni « = » ni « + », 255 caractères au plus).
const REF_OBJET = "^[A-Za-z0-9][A-Za-z0-9_./-]{0,254}$";
const organisationFk = (nom: string) => (t: Record<string, unknown>) =>
  foreignKey({ name: `${nom}_organisation_fk`, columns: [t["tenantId"] as never, t["organisationId"] as never], foreignColumns: [organisations.tenantId, organisations.id] });

export const contrats = tableClient(
  "contrats",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    type: typeContrat("type").notNull(),
    dateSignature: date("date_signature").notNull(),
    pdfRef: text("pdf_ref").notNull(),
    empreinteSha256: text("empreinte_sha256").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      organisationFk("contrats")(t),
      check("contrats_pdf_ref_format", sql`${t["pdfRef"]} ~ '${sql.raw(REF_OBJET)}'`),
      check("contrats_empreinte_format", sql`${t["empreinteSha256"]} ~ '${sql.raw(HEX64)}'`),
    ],
  },
);

export const devis = tableClient(
  "devis",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    numeroHub: text("numero_hub").notNull(),
    propositionRef: text("proposition_ref"),
    pdfRef: text("pdf_ref").notNull(),
    dateEnvoi: timestamp("date_envoi", { withTimezone: true }),
    dureeValiditeJours: integer("duree_validite_jours").notNull(),
    statut: statutDevis("statut").notNull().default("brouillon"),
    motifAnnulation: text("motif_annulation"),
    annuleLe: timestamp("annule_le", { withTimezone: true }),
    annulePar: text("annule_par"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      organisationFk("devis")(t),
      // Par client : la numérotation unique est garantie par le Hub, pas par un index global (oracle d'existence, ADR 0040).
      unique("devis_tenant_id_numero_hub_unique").on(t["tenantId"] as never, t["numeroHub"] as never),
      check("devis_pdf_ref_format", sql`${t["pdfRef"]} ~ '${sql.raw(REF_OBJET)}'`),
      check("devis_validite_positive", sql`${t["dureeValiditeJours"]} > 0`),
      check("devis_annulation_complete", sql`(${t["statut"]} = 'annule' AND coalesce(length(btrim(${t["motifAnnulation"]})), 0) > 0 AND ${t["annuleLe"]} IS NOT NULL AND coalesce(length(btrim(${t["annulePar"]})), 0) > 0) OR (${t["statut"]} <> 'annule' AND ${t["motifAnnulation"]} IS NULL AND ${t["annuleLe"]} IS NULL AND ${t["annulePar"]} IS NULL)`),
    ],
  },
);

export const factures = tableClient(
  "factures",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    numero: text("numero").notNull(),
    hubId: text("hub_id").notNull(),
    nature: natureFacture("nature").notNull(),
    plan: text("plan"),
    // Code de l'automatisation (celui de l'instance, jamais un libellé) : porte l'unicité de la mise en place, sans entrer dans une clé avec l'instance.
    codeAutomatisation: text("code_automatisation"),
    instanceId: uuid("instance_id"),
    periodeDebut: date("periode_debut").notNull(),
    periodeFin: date("periode_fin").notNull(),
    montantHtCentimes: bigint("montant_ht_centimes", { mode: "number" }).notNull(),
    statut: statutFacture("statut").notNull().default("emise"),
    pdfRef: text("pdf_ref").notNull(),
    empreinteSha256: text("empreinte_sha256").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      organisationFk("factures")(t),
      foreignKey({ name: "factures_instance_fk", columns: [t["tenantId"] as never, t["instanceId"] as never], foreignColumns: [instances.tenantId, instances.id] }),
      unique("factures_tenant_id_numero_unique").on(t["tenantId"] as never, t["numero"] as never),
      unique("factures_tenant_id_hub_id_unique").on(t["tenantId"] as never, t["hubId"] as never),
      // Abonnement : une facture par client, plan et début de période ; les avoirs (autre nature) ne bloquent jamais la facture rectifiée.
      uniqueIndex("factures_abonnement_periode_unique").on(t["tenantId"] as never, t["plan"] as never, t["periodeDebut"] as never).where(sql`${t["nature"]} = 'abonnement'`),
      // Mise en place : une facture par client et par automatisation.
      uniqueIndex("factures_mise_en_place_unique").on(t["tenantId"] as never, t["codeAutomatisation"] as never).where(sql`${t["nature"]} = 'mise_en_place'`),
      check("factures_pdf_ref_format", sql`${t["pdfRef"]} ~ '${sql.raw(REF_OBJET)}'`),
      check("factures_empreinte_format", sql`${t["empreinteSha256"]} ~ '${sql.raw(HEX64)}'`),
      check("factures_montant_positif", sql`${t["montantHtCentimes"]} >= 0`),
      check("factures_periode_ordonnee", sql`${t["periodeFin"]} >= ${t["periodeDebut"]}`),
      check("factures_cle_unicite_presente", sql`(${t["nature"]} <> 'abonnement' OR ${t["plan"]} IS NOT NULL) AND (${t["nature"]} <> 'mise_en_place' OR ${t["codeAutomatisation"]} IS NOT NULL)`),
    ],
  },
);

// Valeurs lues dans axion-ia : colonnes écrites seulement par la synchronisation (T2-15), jamais par console_app (ADR 0053).
export const apporteursClients = tableClient(
  "apporteurs_clients",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    apporteurAxionIaId: text("apporteur_axion_ia_id").notNull(),
    tauxPointsDeBase: integer("taux_points_de_base").notNull(),
    commissionsDuesCentimes: bigint("commissions_dues_centimes", { mode: "number" }).notNull().default(0),
    luLe: timestamp("lu_le", { withTimezone: true }).notNull(),
  },
  {
    contraintes: (t) => [
      organisationFk("apporteurs_clients")(t),
      unique("apporteurs_clients_tenant_id_organisation_id_apporteur_unique").on(t["tenantId"] as never, t["organisationId"] as never, t["apporteurAxionIaId"] as never),
      check("apporteurs_clients_taux_borne", sql`${t["tauxPointsDeBase"]} BETWEEN 0 AND 10000`),
      check("apporteurs_clients_commissions_positives", sql`${t["commissionsDuesCentimes"]} >= 0`),
    ],
  },
);
