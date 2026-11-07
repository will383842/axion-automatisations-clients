import type { PoolClient, Pool } from "pg";
import { z } from "zod";
import { avecClient } from "../db/client-actif.js";
import { ErreurApi } from "../plugins/erreurs.js";
import { modifierDans } from "../reglages/versions.js";
import type { EmetteurC3 } from "../crm/emetteur-c3.js";
import { activerInstance, ErreurRegleMetier, type Requeteur } from "./activer.js";
import { verifierFormule } from "./formule.js";

// Création d'une instance et gardes d'activation (T4-28b1, ADR 0125). Le client vient TOUJOURS de la session (paramètre tenantId, posé par avecClient), jamais du corps.
// Une instance naît en pause ; elle ne devient active que par activerAvecGardes (seul appelant d'activerInstance) : toutes les gardes doivent dire oui.
const Uuid = z.uuid();
export const DemandeCreation = z.strictObject({
  organisation_id: Uuid,
  version_id: Uuid,
  formule: z.string().max(40),
  environnement: z.enum(["test", "production"]).default("production"),
  reglages: z.record(z.string(), z.unknown()),
  motif: z.string().trim().min(1).max(500).default("installation"),
});
export type DemandeCreation = z.infer<typeof DemandeCreation>;
export function lireDemandeCreation(corps: unknown): DemandeCreation {
  const r = DemandeCreation.safeParse(corps);
  if (!r.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  return r.data;
}
export interface ResultatCreation { instanceId: string; configurationId: string; etat: "pause" }

const REFERENCE = /^connexion:([a-z][a-z0-9-]{0,40})$/;
// Références « connexion:<famille> » des réglages, à tout niveau. Une valeur qui commence par « connexion: » sans respecter la forme est refusée.
function references(valeur: unknown, profondeur = 0): string[] {
  if (typeof valeur === "string") {
    if (!valeur.startsWith("connexion:")) return [];
    const m = REFERENCE.exec(valeur);
    if (!m) throw new ErreurApi("schema_invalide", "Référence de connexion invalide.");
    return [m[1] as string];
  }
  if (!valeur || typeof valeur !== "object") return [];
  if (profondeur > 10) throw new ErreurApi("schema_invalide", "Réglages trop profonds.");
  return Object.values(valeur).flatMap((v) => references(v, profondeur + 1));
}

type EcrireReglages = typeof modifierDans;

export async function creerInstanceDans(client: PoolClient, tenantId: string, d: DemandeCreation, acteur: string, ecrireReglages: EcrireReglages = modifierDans): Promise<ResultatCreation> {
  verifierFormule(d.formule);
  // console_app ne voit que les versions publiées, dépréciées ou retirées ; seule une version publiée est proposée (B-461). La base le refuse aussi (instances_garde).
  const version = (await client.query("SELECT v.id, v.automatisation_id, v.statut, a.code FROM versions_automatisation AS v JOIN automatisations AS a ON a.id = v.automatisation_id WHERE v.id = $1", [d.version_id])).rows[0] as
    { id: string; automatisation_id: string; statut: string; code: string } | undefined;
  if (!version) throw new ErreurApi("introuvable", "Version introuvable.");
  if (version.statut !== "publiee") throw new ErreurApi("regle_metier", "Seule une version publiée peut être installée.");
  if (!(await client.query("SELECT 1 AS un FROM organisations WHERE tenant_id = $1 AND id = $2", [tenantId, d.organisation_id])).rows[0]) throw new ErreurApi("introuvable", "Organisation introuvable.");
  // Chaque connexion citée par les réglages est une connexion de CE client, non révoquée (attaque 3 de la fiche) : jamais celle d'un autre.
  for (const famille of new Set(references(d.reglages))) {
    const connexion = await client.query("SELECT 1 AS un FROM connexions WHERE tenant_id = $1 AND (outil = $2 OR connecteur = $2) AND etat <> 'revoquee' LIMIT 1", [tenantId, famille]);
    if (connexion.rows.length === 0) throw new ErreurApi("regle_metier", `Aucune connexion « ${famille} » n'existe pour ce client.`);
  }
  let instanceId: string;
  try {
    const ligne = await client.query(
      "INSERT INTO instances (tenant_id, organisation_id, code_automatisation, formule, environnement, etat, automatisation_id, version_courante_id) VALUES ($1, $2, $3, $4, $5, 'pause', $6, $7) RETURNING id",
      [tenantId, d.organisation_id, version.code, "abonnement", d.environnement, version.automatisation_id, version.id],
    );
    instanceId = ligne.rows[0]?.["id"] as string;
  } catch (e) {
    if ((e as { code?: string }).code === "23505" && (e as { constraint?: string }).constraint === "instances_une_par_automatisation") throw new ErreurApi("identifiant_deja_pris", "Cette automatisation est déjà installée pour ce client.");
    throw e;
  }
  // Première configuration par le chemin des versions de réglages (validation contre le schéma de la version, une seule configuration active).
  const configuration = await ecrireReglages(client, instanceId, d.reglages, acteur, d.motif);
  return { instanceId, configurationId: configuration.id, etat: "pause" };
}

export function creerInstance(pool: Pool, tenantId: string, d: DemandeCreation, acteur: string): Promise<ResultatCreation> {
  return avecClient(pool, tenantId, (c) => creerInstanceDans(c, tenantId, d, acteur), { acteur });
}

// Gardes d'activation (C-628) : fonction par garde, toutes doivent dire oui. T4-51 (paiement) et T4-54 (clé d'IA) brancheront les leurs ici.
export interface ContexteGarde { client: Requeteur; tenantId: string; instanceId: string }
export type ResultatGarde = { ok: true } | { ok: false; motif: string };
export type GardeActivation = (ctx: ContexteGarde) => Promise<ResultatGarde>;

export async function activerAvecGardes(client: Requeteur, tenantId: string, instanceId: string, gardes: readonly GardeActivation[], emetteur?: Pick<EmetteurC3, "automatisationActivee">): Promise<void> {
  // Verrou de l'instance du client de la session : l'état ne change pas entre les gardes et l'activation.
  const verrou = await client.query("SELECT id FROM instances WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, instanceId]);
  if (verrou.rows.length === 0) throw new ErreurRegleMetier("instance_introuvable");
  for (const garde of gardes) {
    const r = await garde({ client, tenantId, instanceId });
    if (!r.ok) throw new ErreurRegleMetier(r.motif);
  }
  await activerInstance(client, tenantId, instanceId, emetteur);
}

export function activer(pool: Pool, tenantId: string, instanceId: string, acteur: string, gardes: readonly GardeActivation[], emetteur?: Pick<EmetteurC3, "automatisationActivee">): Promise<void> {
  return avecClient(pool, tenantId, (c) => activerAvecGardes(c, tenantId, instanceId, gardes, emetteur), { acteur });
}
