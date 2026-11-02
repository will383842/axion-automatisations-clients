import { ErreurEtape, type Etape } from "./machine.js";
import type { ContexteBase } from "./etapes-base.js";

// Étapes 4 (clé du client) et 5 (compartiment) du provisionnement (T2-35). Les noms de clé et de compartiment viennent UNIQUEMENT de l'UUID validé du client de la tâche :
// le contexte passé d'une étape à l'autre est celui de CE client, jamais une valeur gardée entre deux tâches. Une erreur ne reprend jamais le texte de la cause.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface PortsCoffreClient {
  // Moteur transit d'OpenBao : `creer` crée une clé aes256-gcm96 NON exportable (jamais d'option contraire).
  cle: { existe(nom: string): Promise<boolean>; creer(nom: string): Promise<void> };
  compartiment: {
    // Le jeu d'identifiants rangé au coffre pour CE client (nom du compartiment auquel il ouvre), ou rien.
    identifiants(tenantId: string): Promise<{ compartiment: string } | undefined>;
    creer(tenantId: string): Promise<void>;
    quota(tenantId: string): Promise<number | undefined>;
    poserQuota(tenantId: string, fichiers: number): Promise<void>;
  };
  // Quota de fichiers du palier : configuration des quotas (T2-41) ou, à défaut, valeur par défaut de la configuration.
  quotaFichiers(tenantId: string): Promise<number>;
}
const id = (ctx: ContexteBase): string => { if (!UUID.test(ctx.tenantId)) throw new ErreurEtape("tenant_invalide"); return ctx.tenantId; };
const attraper = <T>(code: string, f: () => Promise<T>): Promise<T> => f().catch((e: unknown) => { throw e instanceof ErreurEtape ? e : new ErreurEtape(code); });
const quotaValide = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

export function etapesCoffre(p: PortsCoffreClient): Etape<ContexteBase>[] {
  const noms = (ctx: ContexteBase) => [`cli-${id(ctx)}`, `cli-${id(ctx)}-recherche`];
  return [
    {
      numero: 4,
      nom: "cle_client",
      async dejaFait(ctx) {
        for (const nom of noms(ctx)) if (!(await attraper("coffre_indisponible", () => p.cle.existe(nom)))) return false;
        return true;
      },
      async faire(ctx) {
        for (const nom of noms(ctx)) {
          if (!(await attraper("coffre_indisponible", () => p.cle.existe(nom)))) await attraper("cle_client_echouee", () => p.cle.creer(nom));
        }
      },
    },
    {
      numero: 5,
      nom: "compartiment",
      async dejaFait(ctx) {
        const t = id(ctx);
        const rangees = await attraper("stockage_indisponible", () => p.compartiment.identifiants(t));
        if (!rangees) return false;
        // Des identifiants qui ouvrent le compartiment d'un autre client ne comptent jamais pour faits.
        if (rangees.compartiment !== `cli-${t}`) throw new ErreurEtape("identifiants_etrangers");
        return (await attraper("stockage_indisponible", () => p.compartiment.quota(t))) === (await attraper("quota_illisible", () => p.quotaFichiers(t)));
      },
      async faire(ctx) {
        const t = id(ctx);
        const quota = await attraper("quota_illisible", () => p.quotaFichiers(t));
        if (!quotaValide(quota)) throw new ErreurEtape("quota_invalide");
        if (!(await attraper("stockage_indisponible", () => p.compartiment.identifiants(t)))) await attraper("compartiment_echoue", () => p.compartiment.creer(t));
        await attraper("quota_echoue", () => p.compartiment.poserQuota(t, quota));
      },
    },
  ];
}
