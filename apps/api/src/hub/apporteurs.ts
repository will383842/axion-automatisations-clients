import { ApporteursReponse } from "../../../../packages/contrats/src/c1/schemas.ts";
import type { LecteurTx } from "./client-c1.ts";

// A-147 : lecture de GET /clients/{axiCli}/apporteurs (chaque nuit et à l'activation). Seule écriture permise : la date de lecture.
// Le taux, les commissions et le SIREN ne bougent jamais par cette voie ; un apporteur inconnu est rendu à l'appelant, pas créé.
export async function rangerApporteurs(tx: LecteurTx, tenant: string, reponse: unknown, luLe: Date): Promise<{ mis_a_jour: string[]; inconnus: string[] }> {
  const ids = ApporteursReponse.parse(reponse).apporteurs.map((a) => a.idApporteur);
  const faits = await tx.query("UPDATE apporteurs_clients SET lu_le = GREATEST(lu_le, $1) WHERE tenant_id = $2 AND organisation_id = $2 AND apporteur_axion_ia_id = ANY($3::text[]) RETURNING apporteur_axion_ia_id", [luLe, tenant, ids]);
  const connus = new Set(faits.rows.map((l) => l["apporteur_axion_ia_id"] as string));
  return { mis_a_jour: ids.filter((i) => connus.has(i)), inconnus: ids.filter((i) => !connus.has(i)) };
}
