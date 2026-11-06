import { sql } from "drizzle-orm";
import { check, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { tableClient } from "./aides.ts";

// Réservation des alertes de quota (T2-52, dette T2-41), par client. Une ligne par (quota, seuil, période) : l'unicité fait passer une seule mesure.
// « Libérer » remet reserve_le à NULL ; aucun DELETE. Valeurs de `quota` : base, fichiers, personnes, tous. Seuils : ceux du type Seuil de quotas/alerter.ts.
export const reservationsAlertesQuota = tableClient(
  "reservations_alertes_quota",
  {
    id: uuid("id").notNull().defaultRandom(),
    quota: text("quota").notNull(),
    seuil: smallint("seuil").notNull(),
    periode: text("periode").notNull(),
    reserveLe: timestamp("reserve_le", { withTimezone: true }),
    envoyeLe: timestamp("envoye_le", { withTimezone: true }),
  },
  {
    contraintes: (t) => [
      unique("reservations_alertes_quota_cle_unique").on(t["tenantId"] as never, t["quota"] as never, t["seuil"] as never, t["periode"] as never),
      check("reservations_alertes_quota_quota", sql`${t["quota"]} IN ('base', 'fichiers', 'personnes', 'tous')`),
      check("reservations_alertes_quota_seuil", sql`${t["seuil"]} IN (70, 100)`),
      check("reservations_alertes_quota_periode", sql`${t["periode"]} ~ '^[0-9]{4}-[0-9]{2}$'`),
      check("reservations_alertes_quota_envoi_reserve", sql`${t["envoyeLe"]} IS NULL OR ${t["reserveLe"]} IS NOT NULL`),
    ],
  },
);
