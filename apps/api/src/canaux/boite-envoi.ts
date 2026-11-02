import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ZodType } from "zod";
import { ROUTES_C1, type RouteC1 } from "../../../../packages/contrats/src/c1/routes.js";
import { cleDIntention } from "../../../../packages/contrats/src/commun/idempotence.js";
import type { Destination } from "./expediteur.js";

// Boîte d'envoi (A-088, C-402, C-535) : la ligne s'écrit dans la MÊME transaction que le changement métier. Aucune tâche de file ici :
// le relais dépose la tâche après validation (sinon une tâche pourrait partir pour une transaction annulée).
declare const OUVERTE: unique symbol;
// Type qui impose la transaction : seul transactionOuverte() en fabrique un, à partir du client fourni par avecClient().
export type TransactionOuverte = Pick<PoolClient, "query"> & { readonly [OUVERTE]: true };
export const transactionOuverte = (client: Pick<PoolClient, "query">): TransactionOuverte => client as TransactionOuverte;

export type Methode = "POST" | "PUT" | "PATCH" | "DELETE";
export interface Depot {
  destination: Destination;
  route: string;
  methode: Methode;
  corps: unknown;
  intention: string;
}
// Schéma d'entrée par destination et par route : la boîte d'envoi ne porte que ce que le Hub ou le CRM reçoit.
export type SchemasRoutes = (destination: Destination, route: string) => ZodType | undefined;

// Racine des routes de C1, écrite ici : la garde des canaux refuse l'import du préfixe du contrat hors des fichiers de canaux ; un test la compare au contrat.
export const RACINE_C1 = "/api/console/v1";
const modele = (chemin: string) => new RegExp(`^${(RACINE_C1 + chemin).replace(/\{[^}]+\}/g, "[^/?]+")}$`);
const ROUTES_HUB = (Object.values(ROUTES_C1) as RouteC1[]).flatMap((r) => (r.methode === "POST" && r.requete ? [{ motif: modele(r.chemin), schema: r.requete }] : []));
// Le CRM n'a pas encore de route d'écriture C3 enregistrée ici : tout dépôt vers le CRM est refusé tant qu'un registre n'est pas fourni.
export const schemasParDefaut: SchemasRoutes = (destination, route) => (destination === "hub" ? ROUTES_HUB.find((r) => r.motif.test(route))?.schema : undefined);

export async function deposer(tx: TransactionOuverte, depot: Depot, schemas: SchemasRoutes = schemasParDefaut): Promise<{ id: string; cle: string; nouveau: boolean }> {
  const schema = schemas(depot.destination, depot.route);
  if (!schema) throw new Error("route inconnue pour cette destination");
  if (!schema.safeParse(depot.corps).success) throw new Error("corps hors contrat de la route");
  // Hors transaction, set_config(..., true) de avecClient n'a plus d'effet : le client n'est plus fixé et le dépôt est refusé.
  const tenant = (await tx.query("SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant")).rows[0]?.["tenant"] as string | null | undefined;
  if (!tenant) throw new Error("dépôt refusé : aucune transaction de client ouverte");
  const cle = cleDIntention(depot.destination, depot.intention);
  const empreinte = createHash("sha256").update(JSON.stringify(depot.corps)).digest("hex");
  const id = randomUUID();
  const inseree = await tx.query(
    `INSERT INTO boite_envoi (tenant_id, id, destination, route, methode, corps, cle_anti_doublon, empreinte_corps) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (tenant_id, cle_anti_doublon) DO NOTHING RETURNING id`,
    [tenant, id, depot.destination, depot.route, depot.methode, JSON.stringify(depot.corps), cle, empreinte],
  );
  if (inseree.rows.length === 0) {
    // Même intention déjà déposée : une seule ligne ; un corps différent est un défaut du producteur, jamais un second envoi.
    const connue = (await tx.query("SELECT id, empreinte_corps FROM boite_envoi WHERE tenant_id = $1 AND cle_anti_doublon = $2", [tenant, cle])).rows[0];
    if (!connue || connue["empreinte_corps"] !== empreinte) throw new Error("intention déjà déposée avec un autre corps");
    return { id: connue["id"] as string, cle, nouveau: false };
  }
  // Livré au COMMIT seulement : réveille le relais, sans rien porter de la ligne.
  await tx.query("SELECT pg_notify('boite_envoi', $1)", [depot.destination]);
  return { id, cle, nouveau: true };
}
