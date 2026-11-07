import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, integer, pgEnum, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tableClient } from "./aides.ts";
import { organisations } from "./clients.ts";

// Tables du portail client (T6-01a, migration 0025) : des métadonnées SEULEMENT. Aucune colonne ne peut ranger le texte d'une demande (C-604) :
// ce texte vit dans la base du client (cli_<id>). Toute colonne de texte est bornée par un motif fermé. Aucun jeton en clair : seulement l'empreinte HMAC.
export const etatPremiersPas = pgEnum("etat_premiers_pas", ["a_faire", "en_cours", "fait", "passe"]);
export const roleInvitation = pgEnum("role_invitation", ["dirigeant", "administrateur", "utilisateur"]);
export const etatInvitation = pgEnum("etat_invitation", ["envoyee", "acceptee", "expiree", "revoquee"]);

const CODE = "^[a-z][a-z0-9_.-]{0,63}$";
const orgFk = (nom: string, t: Record<string, unknown>) =>
  foreignKey({ name: nom, columns: [t["tenantId"] as never, t["organisationId"] as never], foreignColumns: [organisations.tenantId, organisations.id] });

// Reprise exacte des premiers pas (B-281) : une ligne par (client, utilisateur, étape). L'utilisateur est l'identifiant opaque de l'annuaire.
export const progressionPremiersPas = tableClient(
  "progression_premiers_pas",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    utilisateur: uuid("utilisateur").notNull(),
    etape: text("etape").notNull(),
    etat: etatPremiersPas("etat").notNull().default("a_faire"),
    commenceLe: timestamp("commence_le", { withTimezone: true }),
    termineLe: timestamp("termine_le", { withTimezone: true }),
    majLe: timestamp("maj_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    // Volume élevé, aucune valeur métier : pas de copie au journal d'audit.
    audit: false,
    contraintes: (t) => [
      orgFk("progression_premiers_pas_organisation_fk", t),
      unique("progression_premiers_pas_etape_unique").on(t["tenantId"] as never, t["utilisateur"] as never, t["etape"] as never),
      check("progression_premiers_pas_etape_code", sql`${t["etape"]} ~ '${sql.raw(CODE)}'`),
      check("progression_premiers_pas_fin_coherente", sql`(${t["etat"]} = 'fait') = (${t["termineLe"]} IS NOT NULL)`),
    ],
  },
);

export const preferencesNotifications = tableClient(
  "preferences_notifications",
  {
    id: uuid("id").notNull(),
    utilisateur: uuid("utilisateur").notNull(),
    cleEnvoi: text("cle_envoi").notNull(),
    activee: boolean("activee").notNull().default(true),
    resumeHebdomadaire: boolean("resume_hebdomadaire").notNull().default(false),
    majLe: timestamp("maj_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    // Volume élevé, aucune valeur métier : pas de copie au journal d'audit.
    audit: false,
    contraintes: (t) => [
      unique("preferences_notifications_cle_unique").on(t["tenantId"] as never, t["utilisateur"] as never, t["cleEnvoi"] as never),
      check("preferences_notifications_cle_code", sql`${t["cleEnvoi"]} ~ '${sql.raw(CODE)}'`),
    ],
  },
);

// Invitation à usage unique : la base ne garde QUE l'empreinte HMAC-SHA-256 (64 caractères hexadécimaux) du jeton, jamais sa valeur.
export const invitations = tableClient(
  "invitations",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    role: roleInvitation("role").notNull(),
    empreinteInvitation: text("empreinte_invitation").notNull(),
    expireLe: timestamp("expire_le", { withTimezone: true }).notNull(),
    etat: etatInvitation("etat").notNull().default("envoyee"),
    invitePar: uuid("invite_par").notNull(),
    accepteeLe: timestamp("acceptee_le", { withTimezone: true }),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    contraintes: (t) => [
      orgFk("invitations_organisation_fk", t),
      unique("invitations_empreinte_unique").on(t["tenantId"] as never, t["empreinteInvitation"] as never),
      check("invitations_empreinte_forme", sql`${t["empreinteInvitation"]} ~ '^[0-9a-f]{64}$'`),
      check("invitations_expiration", sql`${t["expireLe"]} > ${t["creeLe"]} AND ${t["expireLe"]} <= ${t["creeLe"]} + interval '30 days'`),
      check("invitations_acceptation", sql`(${t["etat"]} = 'acceptee') = (${t["accepteeLe"]} IS NOT NULL)`),
    ],
  },
);

// Confirmation écrite tracée de l'accord pour le logo du client (C-572) : la preuve est une référence de forme fermée, pas un texte.
export const accordsLogo = tableClient(
  "accords_logo",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    confirmePar: uuid("confirme_par").notNull(),
    confirmeLe: timestamp("confirme_le", { withTimezone: true }).notNull().defaultNow(),
    referencePreuve: text("reference_preuve").notNull(),
    retireLe: timestamp("retire_le", { withTimezone: true }),
  },
  {
    contraintes: (t) => [
      orgFk("accords_logo_organisation_fk", t),
      // Un seul accord vivant par organisation.
      uniqueIndex("accords_logo_un_vivant").on(t["tenantId"] as never, t["organisationId"] as never).where(sql`${t["retireLe"]} IS NULL`),
      check("accords_logo_preuve_forme", sql`${t["referencePreuve"]} ~ '^[A-Za-z0-9][A-Za-z0-9_./:-]{0,127}$'`),
    ],
  },
);

// Compteurs d'ouvertures et d'aides par écran et par jour (T5-23) : des entiers, aucun contenu.
export const compteursEcrans = tableClient(
  "compteurs_ecrans",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    ecran: text("ecran").notNull(),
    jour: date("jour").notNull(),
    ouvertures: integer("ouvertures").notNull().default(0),
    aides: integer("aides").notNull().default(0),
  },
  {
    // Volume élevé, aucune valeur métier : pas de copie au journal d'audit.
    audit: false,
    contraintes: (t) => [
      orgFk("compteurs_ecrans_organisation_fk", t),
      unique("compteurs_ecrans_jour_unique").on(t["tenantId"] as never, t["organisationId"] as never, t["ecran"] as never, t["jour"] as never),
      check("compteurs_ecrans_ecran_code", sql`${t["ecran"]} ~ '^[A-Za-z][A-Za-z0-9_.-]{0,63}$'`),
      check("compteurs_ecrans_positifs", sql`${t["ouvertures"]} >= 0 AND ${t["aides"]} >= 0`),
    ],
  },
);
