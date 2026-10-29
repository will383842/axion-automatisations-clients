import { index, pgTable, primaryKey, unique, uuid, type PgColumn, type PgColumnBuilderBase, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";

// Organisation réservée « plateforme » (ADR 0043) : porte les valeurs globales d'AXION (tables de T2-02), n'est jamais un client.
// Elle est insérée par la migration des tables de client ; les listes de clients et les envois vers le CRM l'écartent par cet identifiant.
export const PLATEFORME_ID = "00000000-0000-0000-0000-000000000001";

// Tables posées par tableClient() : la migration écrit, pour chacune, ENABLE + FORCE ROW LEVEL SECURITY, les deux politiques du modèle
// (ops/socle/postgres/modele-politique-rls.sql) et, si `audit`, le déclencheur audit_ecrire. Un test relit la migration contre cette liste.
export const TABLES_CLIENT: { nom: string; audit: boolean }[] = [];

type Options = {
  // Table partitionnée par `debut` (executions, T2-06) : clé (tenant_id, id, debut), pas de UNIQUE (tenant_id, id) ;
  // les clés étrangères vers une telle table incluent `debut`.
  partitionnee?: boolean;
  // false : la table porte des données de personnes, pas de copie au journal tant que le mécanisme d'effacement n'est pas choisi (ADR 0043, T2-11).
  audit?: boolean;
  contraintes?: (t: Record<string, PgColumn>) => PgTableExtraConfigValue[];
};

export function tableClient<C extends Record<string, PgColumnBuilderBase>>(nom: string, colonnes: C, options: Options = {}) {
  TABLES_CLIENT.push({ nom, audit: options.audit ?? true });
  const tenant = uuid("tenant_id").notNull();
  return pgTable(
    nom,
    { tenantId: tenant, ...colonnes } as { tenantId: typeof tenant } & C,
    (brut) => {
      const t = brut as unknown as Record<string, PgColumn>;
      const tenantId = t["tenantId"] as PgColumn;
      const cle = options.partitionnee ? [tenantId, t["id"] as PgColumn, t["debut"] as PgColumn] : [tenantId, t["id"] as PgColumn];
      const supplementaires: PgTableExtraConfigValue[] = options.contraintes?.(t) ?? [];
      return [
        primaryKey({ columns: cle as [PgColumn, ...PgColumn[]] }),
        ...(options.partitionnee ? [] : [unique(`${nom}_tenant_id_id_unique`).on(tenantId, t["id"] as PgColumn)]),
        index(`${nom}_tenant_id_idx`).on(tenantId),
        ...supplementaires,
      ];
    },
  );
}
