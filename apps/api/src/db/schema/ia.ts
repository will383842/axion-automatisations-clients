import { sql } from "drizzle-orm";
import { check, foreignKey, pgEnum, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tableClient } from "./aides.ts";
import { organisations } from "./clients.ts";

// Clé d'IA propre du client (T4-34a, migration 0024, ADR 0117). La base ne garde JAMAIS la valeur de la clé : seulement la référence au coffre
// (bao:clients/<tenant>/<uuid>, forme fermée liée au client de la ligne). Une clé ne s'efface pas : elle se désactive, définitivement.
export const etatCleIa = pgEnum("etat_cle_ia", ["a_tester", "active", "refusee", "desactivee"]);

const CODE = "^[a-z][a-z0-9_.-]{0,63}$";
const UUID_MOTIF = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const clesIaClient = tableClient(
  "cles_ia_client",
  {
    id: uuid("id").notNull(),
    organisationId: uuid("organisation_id").notNull(),
    fournisseur: text("fournisseur").notNull(),
    referenceCoffre: text("reference_coffre").notNull(),
    etat: etatCleIa("etat").notNull().default("a_tester"),
    dernierEssaiLe: timestamp("dernier_essai_le", { withTimezone: true }),
    dernierRefusCode: text("dernier_refus_code"),
    creePar: text("cree_par").notNull(),
    creeLe: timestamp("cree_le", { withTimezone: true }).notNull().defaultNow(),
    desactiveeLe: timestamp("desactivee_le", { withTimezone: true }),
  },
  {
    contraintes: (t) => [
      foreignKey({ name: "cles_ia_client_organisation_fk", columns: [t["tenantId"] as never, t["organisationId"] as never], foreignColumns: [organisations.tenantId, organisations.id] }),
      unique("cles_ia_client_reference_unique").on(t["tenantId"] as never, t["referenceCoffre"] as never),
      // Une seule clé non désactivée par (client, organisation, fournisseur) : un remplacement crée une nouvelle ligne après désactivation de l'ancienne.
      uniqueIndex("cles_ia_client_une_vivante_idx").on(t["tenantId"] as never, t["organisationId"] as never, t["fournisseur"] as never).where(sql`${t["etat"]} <> 'desactivee'`),
      check("cles_ia_client_fournisseur_code", sql`${t["fournisseur"]} ~ '${sql.raw(CODE)}'`),
      check(
        "cles_ia_client_reference_du_client",
        sql`${t["referenceCoffre"]} ~ ('^bao:clients/' || ${t["tenantId"]}::text || '/${sql.raw(UUID_MOTIF)}$') AND char_length(${t["referenceCoffre"]}) <= 96`,
      ),
      check("cles_ia_client_refus_code", sql`${t["dernierRefusCode"]} IS NULL OR ${t["dernierRefusCode"]} ~ '${sql.raw(CODE)}'`),
      check("cles_ia_client_refus_coherent", sql`${t["etat"]} <> 'refusee' OR ${t["dernierRefusCode"]} IS NOT NULL`),
      check("cles_ia_client_cree_par_borne", sql`length(btrim(${t["creePar"]})) > 0 AND char_length(${t["creePar"]}) <= 200`),
      check("cles_ia_client_desactivation_coherente", sql`(${t["etat"]} = 'desactivee') = (${t["desactiveeLe"]} IS NOT NULL)`),
    ],
  },
);
