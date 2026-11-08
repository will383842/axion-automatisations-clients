import type { Pool } from "pg";
import { avecClient } from "../../db/client-actif.js";
import { cleRegroupement, depuisSante, type CauseAlerte } from "./regrouper.js";
import type { DepotCycle } from "./cycle.js";
import { retablirAlerte } from "./cycle.js";
import { GRAVITE, type EtatSante } from "../sante/etat.js";

// Ouverture et comptage dans la file d'alertes (T5-04b, ADR 0126). Une alerte en cours par (client, clé) ; chaque occurrence ajoute une ligne ; compteur = nombre de lignes.
// Types « service » (C-097, C-217) : une alerte est un message de service, jamais commercial. Cette file n'importe rien de envois/exclusions.
export const TYPES_SERVICE = [
  "connexion_expiree", "palier_80", "quota_80", "incident", "violation",
  "sante_instance", "sauvegarde_echec", "base_saturee", "base_a_nettoyer", "mise_a_jour_echec",
] as const;
export type TypeService = (typeof TYPES_SERVICE)[number];

// Une relance au plus toutes les 2 heures et par alerte (B-395). Constante écrite une fois ; le calcul réel est fait en base, sur now() du serveur.
export const DELAI_RELANCE_MS = 7_200_000;
export function relanceDue(repereMs: number, maintenantMs: number): boolean {
  return maintenantMs - repereMs >= DELAI_RELANCE_MS;
}

export type Gravite = "information" | "avertissement" | "critique";
export interface EntreeOuverture {
  type: string;
  gravite: Gravite;
  regle: string;
  cle: string;
  cause: string;
  instanceId: string | null;
}
export interface ResultatOuverture {
  alerteId: string;
  nouvelle: boolean;
  relance: boolean;
}
// Ports. Le dépôt valide sa transaction AVANT de rendre la main ; les notifications partent ensuite (une annulation n'envoie rien).
export interface DepotFile {
  ouvrirOuCompter(tenantId: string, e: EntreeOuverture): Promise<ResultatOuverture>;
}
export interface Notifications {
  relance(tenantId: string, alerteId: string): Promise<void>;
  retabli(tenantId: string, alerteId: string): Promise<void>;
}

export async function ouvrirAlerte(
  depot: DepotFile,
  notifications: Notifications,
  tenantId: string,
  e: { type: string; gravite: Gravite; regle: string; cause: CauseAlerte; instanceId: string | null },
): Promise<ResultatOuverture> {
  if (!(TYPES_SERVICE as readonly string[]).includes(e.type)) throw new Error("type d'alerte inconnu");
  const cle = cleRegroupement(e.cause);
  const r = await depot.ouvrirOuCompter(tenantId, { type: e.type, gravite: e.gravite, regle: e.regle, cle, cause: e.cause.cause.toLowerCase(), instanceId: e.instanceId });
  if (r.relance) await notifications.relance(tenantId, r.alerteId);
  return r;
}

// Branchement de T5-03 (l'émission réelle de sante.changee est une autre fiche) : orange ou rouge ouvre ou compte, vert rétablit.
export async function surChangementSante(
  depot: DepotFile & DepotCycle,
  notifications: Notifications,
  evt: { tenantId: string; instanceId: string | null; avant: string; apres: string; raisons: readonly string[]; connecteur?: string; version?: string },
): Promise<void> {
  const cause = depuisSante(evt);
  const niveau = GRAVITE[evt.apres as EtatSante];
  if (niveau === 0) {
    await retablirAlerte(depot, notifications, evt.tenantId, cause, evt.instanceId);
    return;
  }
  if (niveau === undefined) return;
  const rouge = niveau >= GRAVITE.rouge;
  await ouvrirAlerte(depot, notifications, evt.tenantId, { type: "sante_instance", gravite: rouge ? "critique" : "avertissement", regle: rouge ? "sante_rouge" : "sante_orange", cause, instanceId: evt.instanceId });
}

// Dépôt SQL : UNE transaction avecClient (acteur « supervision »). Le prédicat d'ON CONFLICT répète celui de l'index partiel alertes_une_ouverte_par_cle (sinon 42P10).
const EN_COURS = "etat IN ('ouverte','acquittee')";
export function depotSqlFile(pool: Pool): DepotFile {
  return {
    ouvrirOuCompter: (tenantId, e) =>
      avecClient(
        pool,
        tenantId,
        async (c) => {
          const cree = await c.query(
            "INSERT INTO alertes (tenant_id, id, organisation_id, type, gravite, regle, etat, cle_regroupement, cause) " +
              "SELECT $1, gen_random_uuid(), (SELECT id FROM organisations WHERE tenant_id = $1 ORDER BY id LIMIT 1), $2, $3, $4, 'ouverte', $5, $6 WHERE EXISTS (SELECT 1 FROM organisations WHERE tenant_id = $1) " +
              `ON CONFLICT (tenant_id, cle_regroupement) WHERE cle_regroupement IS NOT NULL AND ${EN_COURS} DO NOTHING RETURNING id`,
            [tenantId, e.type, e.gravite, e.regle, e.cle, e.cause],
          );
          const nouvelle = (cree.rowCount ?? 0) > 0;
          const verrou = await c.query(`SELECT id, cree_le FROM alertes WHERE tenant_id = $1 AND cle_regroupement = $2 AND ${EN_COURS} FOR UPDATE`, [tenantId, e.cle]);
          const alerte = verrou.rows[0] as { id: string; cree_le: Date } | undefined;
          if (!alerte) throw new Error("organisation introuvable pour ce client");
          // Sous le verrou : calme = la dernière relance (ou la création) date de moins de 2 h, sur l'heure du serveur.
          const calme = await c.query(
            "SELECT coalesce(max(recue_le) FILTER (WHERE relance), $3::timestamptz) >= now() - interval '2 hours' AS calme FROM occurrences_alertes WHERE tenant_id = $1 AND alerte_id = $2",
            [tenantId, alerte.id, alerte.cree_le],
          );
          const relance = !nouvelle && (calme.rows[0] as { calme: boolean } | undefined)?.calme === false;
          await c.query("INSERT INTO occurrences_alertes (tenant_id, alerte_id, instance_id, relance) VALUES ($1, $2, $3, $4)", [tenantId, alerte.id, e.instanceId, relance]);
          return { alerteId: alerte.id, nouvelle, relance };
        },
        { acteur: "supervision" },
      ),
  };
}
