import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { tableClient } from "./aides.ts";
import { organisations } from "./clients.ts";

// Adaptateur du récepteur C3 (T2-17b, ADR 0106). Les lignes sans client appartiennent à l'organisation « plateforme » (ADR 0044) ;
// celles d'une fiche portent le tenant_id de la fiche. Aucune suppression n'est accordée : une opposition est une exclusion durable par empreinte.
const HEX64 = "^[0-9a-f]{64}$";

// Fait reçu, rangé AVANT la file (le job ne porte que l'identifiant). Contient les contacts du fait « devenue cliente » jusqu'à leur rangement.
export const contenusC3 = tableClient(
  "contenus_c3",
  { id: uuid("id").notNull(), eventId: uuid("event_id").notNull(), contenu: jsonb("contenu").notNull(), recuLe: timestamp("recu_le", { withTimezone: true }).notNull().defaultNow() },
  { audit: false, contraintes: (t) => [unique("contenus_c3_tenant_id_event_id_unique").on(t["tenantId"] as never, t["eventId"] as never)] },
);

// Exclusion durable par (portée, empreinte), sans lien avec les contacts. Portée « * » = toute la plateforme (opposition) ; sinon l'identifiant CRM du client du sujet (désabonnement).
export const exclusionsC3 = tableClient(
  "exclusions_c3",
  {
    id: uuid("id").notNull(),
    portee: text("portee").notNull(),
    empreinte: text("empreinte").notNull(),
    genre: text("genre").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    audit: false,
    contraintes: (t) => [
      unique("exclusions_c3_tenant_id_portee_empreinte_unique").on(t["tenantId"] as never, t["portee"] as never, t["empreinte"] as never),
      check("exclusions_c3_empreinte_format", sql`${t["empreinte"]} ~ '${sql.raw(HEX64)}'`),
      check("exclusions_c3_genre", sql`${t["genre"]} IN ('desabonnement', 'opposition')`),
      check("exclusions_c3_portee", sql`(${t["genre"]} = 'opposition') = (${t["portee"]} = '*') AND char_length(${t["portee"]}) BETWEEN 1 AND 200`),
    ],
  },
);

// Boîte des alertes : rangées dans la transaction du fait, confirmées une à une après envoi. Ni nom ni e-mail : un type et une référence.
export const alertesC3 = tableClient(
  "alertes_c3",
  {
    id: uuid("id").notNull(),
    eventId: uuid("event_id").notNull(),
    type: text("type").notNull(),
    reference: text("reference").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
    confirmeeLe: timestamp("confirmee_le", { withTimezone: true }),
  },
  {
    audit: false,
    contraintes: (t) => [
      unique("alertes_c3_tenant_id_event_id_type_reference_unique").on(t["tenantId"] as never, t["eventId"] as never, t["type"] as never, t["reference"] as never),
      check("alertes_c3_type", sql`${t["type"]} IN ('exclusion_a_reporter_dans_le_hub', 'effacement_demande', 'ecart_propose', 'fait_hors_perimetre')`),
      check("alertes_c3_reference_bornee", sql`char_length(${t["reference"]}) BETWEEN 1 AND 200`),
      // T2-52 : lecture des alertes non confirmées.
      index("alertes_c3_non_confirmees_idx").on(t["tenantId"] as never, t["creeLe"] as never).where(sql`${t["confirmeeLe"]} IS NULL`),
    ],
  },
);

// Copie CRM, écart proposé et apporteur d'une fiche (jamais appliqués : le Hub fait foi pour l'identité, C-725).
export const donneesCrmC3 = tableClient(
  "donnees_crm_c3",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    eventId: uuid("event_id").notNull(),
    sorte: text("sorte").notNull(),
    contenu: jsonb("contenu").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
  },
  {
    audit: false,
    contraintes: (t) => [
      foreignKey({ name: "donnees_crm_c3_organisation_fk", columns: [t["tenantId"] as never, t["organisationId"] as never], foreignColumns: [organisations.tenantId, organisations.id] }),
      unique("donnees_crm_c3_tenant_id_event_id_sorte_unique").on(t["tenantId"] as never, t["eventId"] as never, t["sorte"] as never),
      check("donnees_crm_c3_sorte", sql`${t["sorte"]} IN ('copie', 'ecart', 'apporteur')`),
    ],
  },
);
