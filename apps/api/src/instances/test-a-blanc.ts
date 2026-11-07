import type { Pool } from "pg";
import { avecClient } from "../db/client-actif.js";
import { ErreurApi } from "../plugins/erreurs.js";
import type { GardeActivation } from "./creer.js";

// Test à blanc (B-093, ADR 0125) : exécution complète sans aucun envoi, rapport montré à l'équipe. L'exécution passe par un PORT (faux en mémoire pour les tests) ;
// l'adaptateur réel (bac à sable de l'exécuteur, connexions en lecture seule, effets forcés en brouillon) est T4-28c. Le rapport ne garde que des compteurs et un code.
export interface RapportExecution { lectures: number; brouillons: number; envois: number; dureeMs: number; codeErreur?: string }
export interface ExecuteurABlanc {
  executer(c: { tenantId: string; instanceId: string; versionId: string; configurationId: string }): Promise<RapportExecution>;
}
export interface RapportTest { id: string; resultat: "reussi" | "echoue"; lectures: number; brouillons: number; envois: number; dureeMs: number; codeErreur: string | null }
export interface CibleTest { instanceId: string; versionId: string; configurationId: string }

const CODE = /^[a-z0-9_.-]{1,64}$/;
const COMPTEUR_MAX = 1_000_000;
const DUREE_MAX = 3_600_000;
const entier = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
const erreurVersion = () => new ErreurApi("regle_metier", "La version ou les réglages ont changé : le test à blanc doit porter sur la version et les réglages actuels.");

// Rapport propre : liste fermée de clés ; tout écart (compteur absurde, code qui n'est pas un code) donne un échec avec un code fermé, jamais un texte de l'exécuteur.
function normaliser(r: RapportExecution | Error): Omit<RapportTest, "id"> {
  if (r instanceof Error) return { resultat: "echoue", lectures: 0, brouillons: 0, envois: 0, dureeMs: 0, codeErreur: "executeur_indisponible" };
  const { lectures, brouillons, envois, dureeMs, codeErreur } = r;
  if (!entier(lectures, COMPTEUR_MAX) || !entier(brouillons, COMPTEUR_MAX) || !entier(envois, COMPTEUR_MAX) || !entier(dureeMs, DUREE_MAX))
    return { resultat: "echoue", lectures: 0, brouillons: 0, envois: 0, dureeMs: 0, codeErreur: "rapport_invalide" };
  const base = { lectures, brouillons, envois, dureeMs };
  if (envois > 0) return { resultat: "echoue", ...base, codeErreur: "envoi_pendant_test" };
  if (codeErreur !== undefined) return { resultat: "echoue", ...base, codeErreur: typeof codeErreur === "string" && CODE.test(codeErreur) ? codeErreur : "code_invalide" };
  return { resultat: "reussi", ...base, codeErreur: null };
}

// Version courante et configuration active de l'instance de CE client. Sous verrou (FOR UPDATE) dans la transaction d'écriture.
async function lireCourant(client: { query(t: string, v?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }, tenantId: string, instanceId: string, verrou: boolean) {
  const r = await client.query(
    `SELECT i.version_courante_id, c.id AS configuration_id FROM instances AS i LEFT JOIN configurations AS c ON c.tenant_id = i.tenant_id AND c.instance_id = i.id AND c.active WHERE i.tenant_id = $1 AND i.id = $2${verrou ? " FOR UPDATE OF i" : ""}`,
    [tenantId, instanceId],
  );
  const ligne = r.rows[0] as { version_courante_id: string | null; configuration_id: string | null } | undefined;
  if (!ligne) throw new ErreurApi("introuvable", "Instance introuvable.");
  return ligne;
}
const estCourant = (ligne: { version_courante_id: string | null; configuration_id: string | null }, c: CibleTest) => ligne.version_courante_id === c.versionId && ligne.configuration_id === c.configurationId;

export async function lancerTestABlanc(pool: Pool, tenantId: string, cible: CibleTest, acteur: string, executeur: ExecuteurABlanc): Promise<RapportTest> {
  // Avant l'exécution : la cible est la version courante et la configuration active (sinon rien ne tourne).
  if (!estCourant(await avecClient(pool, tenantId, (c) => lireCourant(c, tenantId, cible.instanceId, false), { acteur }), cible)) throw erreurVersion();
  // L'exécution (longue) se fait hors transaction.
  const brut = await executeur.executer({ tenantId, ...cible }).catch((e: unknown) => (e instanceof Error ? e : new Error("executeur")));
  const rapport = normaliser(brut);
  // Écriture : la version et la configuration sont relues dans la MÊME transaction, sous verrou de l'instance (M1 de l'audit de #234) ; la base ne lie pas la version à l'automatisation.
  return avecClient(pool, tenantId, async (client) => {
    if (!estCourant(await lireCourant(client, tenantId, cible.instanceId, true), cible)) throw erreurVersion();
    const ligne = await client.query(
      "INSERT INTO tests_a_blanc (tenant_id, instance_id, version_id, configuration_id, resultat, lectures, brouillons, envois, duree_ms, code_erreur, auteur) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id",
      [tenantId, cible.instanceId, cible.versionId, cible.configurationId, rapport.resultat, rapport.lectures, rapport.brouillons, rapport.envois, rapport.dureeMs, rapport.codeErreur, acteur],
    );
    return { id: ligne.rows[0]?.["id"] as string, ...rapport };
  }, { acteur });
}

// Pour la route : le test porte sur la version courante et la configuration active, lues ici.
export async function testerInstance(pool: Pool, tenantId: string, instanceId: string, acteur: string, executeur: ExecuteurABlanc): Promise<RapportTest> {
  const courant = await avecClient(pool, tenantId, (c) => lireCourant(c, tenantId, instanceId, false), { acteur });
  if (!courant.version_courante_id || !courant.configuration_id) throw new ErreurApi("regle_metier", "L'instance n'a pas de version installée ou de réglages actifs.");
  return lancerTestABlanc(pool, tenantId, { instanceId, versionId: courant.version_courante_id, configurationId: courant.configuration_id }, acteur, executeur);
}

// Garde d'activation : la DERNIÈRE ligne de tests_a_blanc pour (instance, version courante, configuration active) doit être « reussi ».
// Tout changement de version ou de réglages crée une autre version ou une autre configuration : l'ancien test ne compte plus.
export const gardeTestABlanc: GardeActivation = async ({ client, tenantId, instanceId }) => {
  const r = await client.query(
    "SELECT t.resultat FROM tests_a_blanc AS t JOIN instances AS i ON i.tenant_id = t.tenant_id AND i.id = t.instance_id JOIN configurations AS c ON c.tenant_id = t.tenant_id AND c.instance_id = t.instance_id AND c.active WHERE t.tenant_id = $1 AND t.instance_id = $2 AND t.version_id = i.version_courante_id AND t.configuration_id = c.id ORDER BY t.cree_le DESC, t.id DESC LIMIT 1",
    [tenantId, instanceId],
  );
  const resultat = r.rows[0]?.["resultat"];
  if (resultat === "reussi") return { ok: true };
  return { ok: false, motif: resultat === "echoue" ? "test_a_blanc_echoue" : "test_a_blanc_absent" };
};
