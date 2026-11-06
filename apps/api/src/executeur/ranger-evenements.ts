import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { Evenement, Paquet } from "../../../../packages/contrats/src/c4/evenements-executeur.js";
import { avecClient } from "../db/client-actif.js";
import type { InstanceResolue } from "./portees.js";

// Rangement des événements d'exécution (A-343, A-346). Aucun contenu métier : des identifiants, des entiers, des codes fermés.
// La table `executions` n'a pas de colonne « minutes gagnées » : cette valeur n'est pas rangée ici (dette T4-23-dette-minutes).
export const ELEMENTS_MAX = 2_147_483_647; // executions.elements_traites est un integer

// Identifiant de ligne dérivé de (instance, exécution) : un paquet rejoué retombe sur la même ligne.
export function idExecution(instanceId: string, executionId: string): string {
  const h = createHash("sha256").update(`${instanceId.toLowerCase()}\n${executionId}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export interface DepotExecutions {
  debut(tenantId: string, instanceId: string, id: string): Promise<void>;
  fin(tenantId: string, instanceId: string, id: string, v: { dureeMs: number; elements: number; jetons: number; coutIaMicroCentimes: number }): Promise<void>;
  erreur(tenantId: string, instanceId: string, id: string, code: string): Promise<void>;
  signalDeVie(cellule: string): Promise<void>;
}

// Vrai si le paquet est rangeable (bornes de la base). Appelé AVANT tout rangement : le paquet est accepté en entier ou refusé en entier.
export const dansLesBornes = (paquet: Paquet): boolean => paquet.evenements.every((e) => e.type !== "fin" || e.elements <= ELEMENTS_MAX);

export async function rangerPaquet(depot: DepotExecutions, paquet: Paquet, cellule: string, instance: (id: string) => InstanceResolue): Promise<void> {
  for (const e of paquet.evenements as Evenement[]) {
    if (e.type === "signal_de_vie") {
      await depot.signalDeVie(cellule);
      continue;
    }
    if (e.type !== "debut" && e.type !== "fin" && e.type !== "erreur") continue; // a_trancher, etape, action_ecran : pas rangés par cette fiche
    const { tenantId } = instance(e.instanceId);
    const id = idExecution(e.instanceId, e.executionId);
    if (e.type === "debut") await depot.debut(tenantId, e.instanceId.toLowerCase(), id);
    else if (e.type === "fin") await depot.fin(tenantId, e.instanceId.toLowerCase(), id, e);
    else await depot.erreur(tenantId, e.instanceId.toLowerCase(), id, e.code);
  }
}

// Dépôt réel : sous RLS avec le tenant_id de l'INSTANCE (résolu côté serveur), acteur = la cellule. Une ligne n'est créée qu'une fois, jamais réécrite après sa fin.
// Le signal de vie (cellules.dernier_signal_le) demande l'écriture du pool de l'équipe : `signal` est injecté par l'appelant.
export function depotExecutionsPg(poolApp: Pool, cellule: string, signal: (cellule: string) => Promise<void>): DepotExecutions {
  const appelant = { acteur: `cellule:${cellule}` };
  const creer = (tenant: string, instance: string, id: string) =>
    avecClient(poolApp, tenant, (c) => c.query("INSERT INTO executions (tenant_id, id, instance_id, auteur) SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM executions WHERE tenant_id = $1 AND id = $2)", [tenant, id, instance, appelant.acteur]), appelant);
  return {
    debut: async (t, i, id) => void (await creer(t, i, id)),
    async fin(t, i, id, v) {
      await creer(t, i, id);
      await avecClient(poolApp, t, (c) => c.query("UPDATE executions SET statut = 'reussie', duree_ms = $3, elements_traites = $4, unites_ia = $5, cout_micro_centimes = $6, termine_par = $7 WHERE tenant_id = $1 AND id = $2 AND statut = 'en_cours'", [t, id, v.dureeMs, v.elements, v.jetons, v.coutIaMicroCentimes, appelant.acteur]), appelant);
    },
    async erreur(t, i, id, code) {
      await creer(t, i, id);
      await avecClient(poolApp, t, (c) => c.query("UPDATE executions SET statut = 'echec', code_erreur = $3, termine_par = $4 WHERE tenant_id = $1 AND id = $2 AND statut = 'en_cours'", [t, id, code, appelant.acteur]), appelant);
    },
    signalDeVie: signal,
  };
}
