import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { avecClient } from "../db/client-actif.js";
import { ErreurApi } from "../plugins/erreurs.js";
import type { ExecuteurABlanc, RapportExecution } from "./test-a-blanc.js";

// Mise à jour d'une instance vers une autre version de la même automatisation (T4-28b2, A-171, A-228, ADR 0125).
// Ordre : réglages migrés par le PORT du bac à sable (le code du module ne tourne jamais dans l'API) → rangés comme configuration INACTIVE → tables du module par les vagues → test à blanc de
// (version cible, configuration migrée) → UNE transaction de bascule. Tout échec : une ligne echec ou quarantaine, une alerte, l'instance reste sur l'ancienne version, rien n'est perdu.
export interface MigrateurReglages {
  // Adaptateur réel : bac à sable de l'exécuteur (T4-28c, révision de C4). Rend les réglages migrés, jamais un texte d'erreur.
  migrer(c: { versionCibleId: string; depuisSemver: string; reglages: Record<string, unknown> }): Promise<Record<string, unknown>>;
}
export interface AlertesDeploiement {
  alerter(alerte: { type: "mise_a_jour_echec"; clientId: string; instanceId: string }): Promise<void>;
}
export interface PortsMiseAJour {
  migrateur: MigrateurReglages;
  // Migration des tables du module dans la base du client (deployerTablesModule) : « ok » seulement si a_<code> est à la version cible.
  tables(c: { tenantId: string; instanceId: string; versionCibleId: string }): Promise<"ok" | "quarantaine">;
  executeur: ExecuteurABlanc;
  alertes: AlertesDeploiement;
}
export type ResultatMiseAJour = { etat: "ok" } | { etat: "echec" | "quarantaine"; cause: string };

interface Etat { depart: string; automatisationId: string; semverDepart: string; configurationId: string; reglages: Record<string, unknown> }
interface Cible { id: string; semver: string; schema: object }

const refus = (m: string) => new ErreurApi("regle_metier", m);
const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const CONNEXION = /^connexion:([a-z][a-z0-9-]{0,40})$/;
const COMPTEUR_MAX = 1_000_000;
const entier = (v: unknown, max: number) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const CODE = /^[a-z0-9_.-]{1,64}$/;

// Références « connexion:<famille> » des réglages migrés : celles d'un module ne doivent jamais viser une connexion d'un autre client (même contrôle que creer.ts, non exporté : dette de factorisation).
function familles(valeur: unknown, profondeur = 0): string[] {
  if (typeof valeur === "string") {
    if (!valeur.startsWith("connexion:")) return [];
    const m = CONNEXION.exec(valeur);
    if (!m) throw new Error("reference");
    return [m[1] as string];
  }
  if (!valeur || typeof valeur !== "object" || profondeur > 10) {
    if (profondeur > 10) throw new Error("profondeur");
    return [];
  }
  return Object.values(valeur).flatMap((v) => familles(v, profondeur + 1));
}

async function lire(client: PoolClient, tenantId: string, instanceId: string, versionCibleId: string): Promise<{ etat: Etat; cible: Cible }> {
  const i = (await client.query(
    "SELECT i.version_courante_id, i.automatisation_id, i.etat, vc.semver AS semver_depart, cfg.id AS configuration_id, cfg.donnees FROM instances AS i LEFT JOIN versions_automatisation AS vc ON vc.id = i.version_courante_id LEFT JOIN configurations AS cfg ON cfg.tenant_id = i.tenant_id AND cfg.instance_id = i.id AND cfg.active WHERE i.tenant_id = $1 AND i.id = $2",
    [tenantId, instanceId],
  )).rows[0] as { version_courante_id: string | null; automatisation_id: string | null; etat: string; semver_depart: string | null; configuration_id: string | null; donnees: unknown } | undefined;
  if (!i) throw new ErreurApi("introuvable", "Instance introuvable.");
  if (!i.version_courante_id || !i.automatisation_id || !i.semver_depart || !i.configuration_id || !estObjet(i.donnees) || i.etat === "livree") throw refus("Cette instance ne peut pas être mise à jour (version ou réglages actifs absents, ou instance livrée).");
  // console_app ne voit que les versions publiées, dépréciées ou retirées : un brouillon est « indisponible », sans dire s'il existe.
  const c = (await client.query("SELECT id, automatisation_id, statut, semver, schema_configuration FROM versions_automatisation WHERE id = $1", [versionCibleId])).rows[0] as
    { id: string; automatisation_id: string; statut: string; semver: string; schema_configuration: object } | undefined;
  if (!c || c.statut !== "publiee" || c.automatisation_id !== i.automatisation_id || c.id === i.version_courante_id) throw refus("La version cible doit être une autre version publiée de la même automatisation.");
  return { etat: { depart: i.version_courante_id, automatisationId: i.automatisation_id, semverDepart: i.semver_depart, configurationId: i.configuration_id, reglages: i.donnees }, cible: { id: c.id, semver: c.semver, schema: c.schema_configuration } };
}

// Rapport de l'exécuteur : liste fermée de clés, compteurs bornés, aucun envoi, aucun code ; tout écart donne un échec avec un code fermé (jamais un texte de l'exécuteur). Dupliqué de test-a-blanc.ts (non exporté) : dette.
function rapportPropre(r: RapportExecution | Error): { resultat: "reussi" | "echoue"; lectures: number; brouillons: number; envois: number; dureeMs: number; codeErreur: string | null } {
  const nul = { lectures: 0, brouillons: 0, envois: 0, dureeMs: 0 };
  if (r instanceof Error) return { resultat: "echoue", ...nul, codeErreur: "executeur_indisponible" };
  const { lectures, brouillons, envois, dureeMs, codeErreur } = r;
  if (!entier(lectures, COMPTEUR_MAX) || !entier(brouillons, COMPTEUR_MAX) || !entier(envois, COMPTEUR_MAX) || !entier(dureeMs, 3_600_000)) return { resultat: "echoue", ...nul, codeErreur: "rapport_invalide" };
  const base = { lectures, brouillons, envois, dureeMs };
  if (envois > 0) return { resultat: "echoue", ...base, codeErreur: "envoi_pendant_test" };
  if (codeErreur !== undefined) return { resultat: "echoue", ...base, codeErreur: typeof codeErreur === "string" && CODE.test(codeErreur) ? codeErreur : "code_invalide" };
  return { resultat: "reussi", ...base, codeErreur: null };
}

const LIGNE = "INSERT INTO deploiements_instance (tenant_id, instance_id, version_depart_id, version_cible_id, configuration_id, resultat, cause, vague, auteur) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)";

export async function mettreAJourInstance(pool: Pool, tenantId: string, instanceId: string, versionCibleId: string, acteur: string, ports: PortsMiseAJour): Promise<ResultatMiseAJour> {
  const { etat, cible } = await avecClient(pool, tenantId, (c) => lire(c, tenantId, instanceId, versionCibleId), { acteur });
  const migree: { id?: string } = {};
  const echouer = async (resultat: "echec" | "quarantaine", cause: string): Promise<ResultatMiseAJour> => {
    await avecClient(pool, tenantId, (c) => c.query(LIGNE, [tenantId, instanceId, etat.depart, cible.id, migree.id ?? null, resultat, cause, acteur]), { acteur });
    await ports.alertes.alerter({ type: "mise_a_jour_echec", clientId: tenantId, instanceId }).catch(() => undefined);
    return { etat: resultat, cause };
  };

  // 1. Réglages migrés (port du bac à sable), valides pour le schéma de la version cible, sans connexion d'un autre client.
  const brut = await ports.migrateur.migrer({ versionCibleId: cible.id, depuisSemver: etat.semverDepart, reglages: etat.reglages }).catch(() => undefined);
  if (!estObjet(brut) || !z.fromJSONSchema(cible.schema as never).safeParse(brut).success) return echouer("echec", "reglages");
  let refs: string[];
  try {
    refs = [...new Set(familles(brut))];
  } catch {
    return echouer("echec", "reglages");
  }
  // 2. Configuration migrée rangée INACTIVE (la politique de la base l'impose) ; l'ancienne reste active tant que rien n'a basculé.
  const id = randomUUID();
  try {
    await avecClient(pool, tenantId, async (c) => {
      for (const famille of refs) if (!(await c.query("SELECT 1 AS un FROM connexions WHERE tenant_id = $1 AND (outil = $2 OR connecteur = $2) AND etat <> 'revoquee' LIMIT 1", [tenantId, famille])).rows[0]) throw new Error("connexion");
      await c.query("SELECT 1 AS un FROM instances WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, instanceId]);
      const dernier = Number(((await c.query("SELECT coalesce(max(numero), 0) AS dernier FROM configurations WHERE tenant_id = $1 AND instance_id = $2", [tenantId, instanceId])).rows[0] as { dernier: number | string }).dernier);
      await c.query(
        "INSERT INTO configurations (tenant_id, id, instance_id, numero, donnees, version_schema, auteur, motif_changement) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)",
        [tenantId, id, instanceId, dernier + 1, JSON.stringify(brut), cible.semver, acteur, `mise à jour vers ${cible.semver}`],
      );
    }, { acteur });
  } catch {
    return echouer("echec", "reglages");
  }
  migree.id = id;

  // 3. Tables du module dans la base du client, par les vagues.
  const tables = await ports.tables({ tenantId, instanceId, versionCibleId: cible.id }).catch(() => "quarantaine" as const);
  if (tables !== "ok") return echouer("quarantaine", "tables");

  // 4. Test à blanc de (version cible, configuration migrée) : l'exécution (longue) se fait hors transaction ; un test échoué est rangé, rien ne bascule.
  const brutTest = await ports.executeur.executer({ tenantId, instanceId, versionId: cible.id, configurationId: id }).catch((e: unknown) => (e instanceof Error ? e : new Error("executeur")));
  const rapport = rapportPropre(brutTest);
  try {
    await avecClient(pool, tenantId, (c) => c.query(
      "INSERT INTO tests_a_blanc (tenant_id, instance_id, version_id, configuration_id, resultat, lectures, brouillons, envois, duree_ms, code_erreur, auteur) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [tenantId, instanceId, cible.id, id, rapport.resultat, rapport.lectures, rapport.brouillons, rapport.envois, rapport.dureeMs, rapport.codeErreur, acteur],
    ), { acteur });
  } catch {
    return echouer("echec", "test_a_blanc");
  }
  if (rapport.resultat !== "reussi") return echouer("echec", "test_a_blanc");

  // 5. UNE transaction de bascule, sous verrou de l'instance : rien n'a changé depuis la lecture, le dernier test de (cible, configuration migrée) est réussi, puis version, configuration active et journal.
  try {
    await avecClient(pool, tenantId, async (c) => {
      const maintenant = (await c.query("SELECT version_courante_id, configuration_id FROM instances AS i LEFT JOIN configurations AS cfg ON cfg.tenant_id = i.tenant_id AND cfg.instance_id = i.id AND cfg.active WHERE i.tenant_id = $1 AND i.id = $2 FOR UPDATE OF i", [tenantId, instanceId])).rows[0] as { version_courante_id: string | null; configuration_id: string | null } | undefined;
      if (!maintenant || maintenant.version_courante_id !== etat.depart || maintenant.configuration_id !== etat.configurationId) throw refus("changement_concurrent");
      const test = (await c.query("SELECT resultat FROM tests_a_blanc WHERE tenant_id = $1 AND instance_id = $2 AND version_id = $3 AND configuration_id = $4 ORDER BY cree_le DESC, id DESC LIMIT 1", [tenantId, instanceId, cible.id, id])).rows[0] as { resultat: string } | undefined;
      if (test?.resultat !== "reussi") throw refus("test_a_blanc");
      await c.query("UPDATE configurations SET active = false, active_par = $3 WHERE tenant_id = $1 AND instance_id = $2 AND active", [tenantId, instanceId, acteur]);
      await c.query("UPDATE configurations SET active = true, active_par = $3 WHERE tenant_id = $1 AND id = $2", [tenantId, id, acteur]);
      await c.query("UPDATE instances SET version_courante_id = $3 WHERE tenant_id = $1 AND id = $2", [tenantId, instanceId, cible.id]);
      await c.query(LIGNE, [tenantId, instanceId, etat.depart, cible.id, id, "ok", null, acteur]);
    }, { acteur });
  } catch (e) {
    return echouer("echec", e instanceof ErreurApi && e.message === "changement_concurrent" ? "changement_concurrent" : e instanceof ErreurApi && e.message === "test_a_blanc" ? "test_a_blanc" : "bascule");
  }
  return { etat: "ok" };
}
