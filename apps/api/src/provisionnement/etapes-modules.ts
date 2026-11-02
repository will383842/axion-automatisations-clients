import { ErreurEtape, type Etape } from "./machine.js";
import type { ContexteBase } from "./etapes-base.js";

// Étape 6 (T2-35) : migrations des modules des instances du client, dans le schéma a_<code>, avec le rôle propriétaire de la base (migrerBase, option `module`).
// Le rôle propriétaire ne sert qu'ici et pour la fermeture : il n'est jamais remis au courtier (T2-36). Aucune instance : étape faite.
const CODE = /^[a-z][a-z0-9_]{1,30}$/;
export interface InstanceModule { code: string; version: number }
export interface PortsModules {
  // Instances du client (catalogue, T2-03) : code du module et version à installer ; lues pour CE client seulement.
  instances(tenantId: string): Promise<InstanceModule[]>;
  // Dernière version appliquée dans a_<code> de la base du client (0 si le schéma n'existe pas encore).
  versionAppliquee(nomBase: string, code: string): Promise<number>;
  migrer(nomBase: string, grappe: string, module: InstanceModule): Promise<void>;
}
const attraper = <T>(code: string, f: () => Promise<T>): Promise<T> => f().catch((e: unknown) => { throw e instanceof ErreurEtape ? e : new ErreurEtape(code); });

export function etapesModules(p: PortsModules): Etape<ContexteBase>[] {
  // Les instances sont validées avant tout appel : un code ou une version hors forme arrête l'étape.
  const aMigrer = async (ctx: ContexteBase): Promise<InstanceModule[]> => {
    const instances = await attraper("instances_illisibles", () => p.instances(ctx.tenantId));
    for (const i of instances) if (!CODE.test(i.code) || !Number.isInteger(i.version) || i.version < 1) throw new ErreurEtape("module_invalide");
    const en_retard: InstanceModule[] = [];
    for (const i of instances) if ((await attraper("base_injoignable", () => p.versionAppliquee(ctx.nomBase, i.code))) < i.version) en_retard.push(i);
    return en_retard;
  };
  return [
    {
      numero: 6,
      nom: "migrations_modules",
      dejaFait: async (ctx) => (await aMigrer(ctx)).length === 0,
      async faire(ctx) {
        if (!ctx.grappe) throw new ErreurEtape("grappe_absente");
        for (const m of await aMigrer(ctx)) await attraper("migration_module_echouee", () => p.migrer(ctx.nomBase, ctx.grappe!, m));
      },
    },
  ];
}
