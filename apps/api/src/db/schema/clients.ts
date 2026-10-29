import { boolean, check, foreignKey, pgEnum, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tableClient } from "./aides.ts";

// Organisations, contacts et instances (C5, lot 2). Vocabulaires provisoires : une valeur s'ajoute plus tard (additif), jamais ne se renomme.
export const statutOrganisation = pgEnum("statut_organisation", ["prospect", "en_signature", "client", "ancien_client"]);
export const tailleOrganisation = pgEnum("taille_organisation", ["tpe", "pme", "eti", "grande"]);
export const roleContact = pgEnum("role_contact", ["principal", "facturation", "technique", "autre"]);
export const formuleInstance = pgEnum("formule_instance", ["abonnement", "achat", "installation_maintenance"]);
export const environnementInstance = pgEnum("environnement_instance", ["test", "production"]);
export const etatInstance = pgEnum("etat_instance", ["active", "pause", "erreur", "livree"]);

// L'identifiant console, tenant_id et id sont une seule valeur. console_client_id est DÉRIVÉ de tenant_id par CHECK (jamais d'unicité globale, ADR 0040).
// `en_signature` est interne à la console : C1 et C3 la voient comme `prospect` (correspondance dans T2-15/T2-18).
export const organisations = tableClient(
  "organisations",
  {
    id: uuid("id").notNull(),
    consoleClientId: uuid("console_client_id").notNull(),
    raisonSociale: text("raison_sociale").notNull(),
    siren: text("siren"),
    metier: text("metier"),
    codeNaf: text("code_naf"),
    taille: tailleOrganisation("taille"),
    modeleIaDefaut: text("modele_ia_defaut"),
    statut: statutOrganisation("statut").notNull().default("prospect"),
    responsableAxion: text("responsable_axion"),
    crmCompanyId: text("crm_company_id"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      check("organisations_id_tenant", sql`${t["id"]} = ${t["tenantId"]}`),
      check("organisations_console_client_id_derive", sql`${t["consoleClientId"]} = ${t["tenantId"]}`),
      unique("organisations_tenant_id_console_client_id_unique").on(t["tenantId"] as never, t["consoleClientId"] as never),
      // Pas d'unicité sur le SIREN : plusieurs établissements, doublon tranché par la file « à trancher » (C-456, T2-15).
      check("organisations_siren_format", sql`${t["siren"]} ~ '^[0-9]{9}$'`),
      check("organisations_code_naf_format", sql`${t["codeNaf"]} ~ '^[0-9]{2}\\.[0-9]{2}[A-Z]$'`),
    ],
  },
);

// Données de personnes : audit_ecrire n'est pas attaché tant que le mécanisme d'effacement du journal n'est pas choisi (ADR 0043 et 0042, T2-11).
export const contacts = tableClient(
  "contacts",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    nom: text("nom").notNull(),
    email: text("email").notNull(),
    role: roleContact("role").notNull().default("principal"),
    accesPortail: boolean("acces_portail").notNull().default(false),
    keycloakId: uuid("keycloak_id"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    audit: false,
    contraintes: (t) => [
      foreignKey({ name: "contacts_organisation_fk", columns: [t["tenantId"] as never, t["organisationId"] as never], foreignColumns: [organisations.tenantId, organisations.id] }),
      check("contacts_email_format", sql`${t["email"]} ~ '^[^@[:space:]]+@[^@[:space:]]+$'`),
    ],
  },
);

export const instances = tableClient(
  "instances",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    codeAutomatisation: text("code_automatisation").notNull(),
    formule: formuleInstance("formule").notNull(),
    environnement: environnementInstance("environnement").notNull(),
    etat: etatInstance("etat").notNull().default("active"),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      foreignKey({ name: "instances_organisation_fk", columns: [t["tenantId"] as never, t["organisationId"] as never], foreignColumns: [organisations.tenantId, organisations.id] }),
    ],
  },
);
