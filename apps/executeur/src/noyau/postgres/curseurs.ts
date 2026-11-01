import type { Pool } from "pg";
import { avecClient } from "../../db/connexion.ts";

// Valeur opaque (A-374) : lue et écrite sans être interprétée, bornée comme la table (512 caractères), aucun contenu de personne.
export interface Curseurs {
  lire(instanceId: string, declencheur: string): Promise<string | undefined>;
  ecrire(instanceId: string, declencheur: string, valeur: string): Promise<void>;
}
const TAILLE_MAX = 512;

export class CurseursPostgres implements Curseurs {
  constructor(
    private pool: Pool,
    private tenantId: string,
  ) {}

  async lire(instanceId: string, declencheur: string) {
    const { rows } = await avecClient(this.pool, this.tenantId, (c) => c.query<{ valeur: string }>("SELECT valeur FROM curseurs WHERE tenant_id = $1 AND instance_id = $2 AND declencheur = $3", [this.tenantId, instanceId, declencheur]));
    return rows[0]?.valeur;
  }

  async ecrire(instanceId: string, declencheur: string, valeur: string) {
    if (valeur.length > TAILLE_MAX) throw new Error("curseur_trop_long");
    await avecClient(this.pool, this.tenantId, (c) =>
      c.query(
        "INSERT INTO curseurs (tenant_id, id, instance_id, declencheur, valeur) VALUES ($1, gen_random_uuid(), $2, $3, $4) ON CONFLICT (tenant_id, instance_id, declencheur) DO UPDATE SET valeur = EXCLUDED.valeur, change_le = now()",
        [this.tenantId, instanceId, declencheur, valeur],
      ),
    );
  }
}
