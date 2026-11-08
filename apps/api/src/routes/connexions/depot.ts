import type { Pool } from "pg";
import { avecClient } from "../../db/client-actif.js";

// Dépôt SQL des connexions (T4-42b) : MÉTADONNÉES ET ÉTAT seulement, sous le client actif, auteur obligatoire (journal d'audit de la base).
// Les seules requêtes permises : créer, réclamer, marquer l'état, révoquer, mettre en pause. Aucune valeur de secret ne passe ici.
export interface NouvelleConnexion {
  tenantId: string;
  acteur: string;
  connexionId: string;
  organisationId: string;
  outil: string;
  connecteur: string;
  portee: "lecture" | "ecriture" | "lecture_ecriture";
  referenceCoffre: string;
}
export interface DepotConnexions {
  creer(c: NouvelleConnexion): Promise<void>;
  existe(tenantId: string, connexionId: string): Promise<boolean>;
  // Réclamation atomique : une seule ligne passe (connexion a_tester et jamais testée), sinon faux.
  reclamer(tenantId: string, connexionId: string, acteur: string): Promise<boolean>;
  marquerEtat(tenantId: string, connexionId: string, acteur: string, etat: "active" | "en_echec"): Promise<boolean>;
  // Définitive : la base ne modifie plus une ligne révoquée. Le motif est dit à l'appelant ; l'auteur est dans le journal d'audit.
  marquerRevoquee(tenantId: string, connexionId: string, acteur: string, motif: string): Promise<boolean>;
  mettreEnPause(tenantId: string, connexionId: string, acteur: string): Promise<number>;
}

const SQL_CREER = `INSERT INTO connexions (tenant_id, id, organisation_id, outil, connecteur, reference_coffre, portee)
  VALUES ($1, $2, $3, $4, $5, $6, $7)`;
const SQL_EXISTE = "SELECT 1 FROM connexions WHERE tenant_id = $1 AND id = $2";
const SQL_RECLAMER = "UPDATE connexions SET dernier_test_le = now() WHERE tenant_id = $1 AND id = $2 AND etat = 'a_tester' AND dernier_test_le IS NULL";
const SQL_ETAT = "UPDATE connexions SET etat = $3 WHERE tenant_id = $1 AND id = $2 AND etat = 'a_tester' AND dernier_test_le IS NOT NULL";
const SQL_REVOQUER = "UPDATE connexions SET etat = 'revoquee' WHERE tenant_id = $1 AND id = $2 AND etat <> 'revoquee'";
const SQL_PAUSE = `UPDATE instances SET etat = 'pause' WHERE tenant_id = $1 AND etat = 'active'
  AND id IN (SELECT instance_id FROM connexions_instances WHERE tenant_id = $1 AND connexion_id = $2 AND delie_le IS NULL)`;

export function creerDepotConnexions(pool: Pool): DepotConnexions {
  const ecrire = async (tenantId: string, acteur: string, texte: string, valeurs: unknown[]): Promise<number> =>
    (await avecClient(pool, tenantId, (c) => c.query(texte, valeurs), { acteur })).rowCount ?? 0;
  return {
    async creer(c) {
      await ecrire(c.tenantId, c.acteur, SQL_CREER, [c.tenantId, c.connexionId, c.organisationId, c.outil, c.connecteur, c.referenceCoffre, c.portee]);
    },
    async existe(tenantId, connexionId) {
      return ((await avecClient(pool, tenantId, (c) => c.query(SQL_EXISTE, [tenantId, connexionId]))).rowCount ?? 0) === 1;
    },
    async reclamer(tenantId, connexionId, acteur) {
      return (await ecrire(tenantId, acteur, SQL_RECLAMER, [tenantId, connexionId])) === 1;
    },
    async marquerEtat(tenantId, connexionId, acteur, etat) {
      if (etat !== "active" && etat !== "en_echec") throw new Error("etat invalide");
      return (await ecrire(tenantId, acteur, SQL_ETAT, [tenantId, connexionId, etat])) === 1;
    },
    async marquerRevoquee(tenantId, connexionId, acteur) {
      return (await ecrire(tenantId, acteur, SQL_REVOQUER, [tenantId, connexionId])) === 1;
    },
    async mettreEnPause(tenantId, connexionId, acteur) {
      return ecrire(tenantId, acteur, SQL_PAUSE, [tenantId, connexionId]);
    },
  };
}
