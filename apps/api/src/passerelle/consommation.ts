import { z } from "zod";
import { validerTenant, type Coffre } from "../coffre/coffre.js";

// Consommation d'un client (A-059), lue avec SA clé virtuelle : la passerelle ne montre à une clé que ses propres lignes.
// Montants en micro-centimes ENTIERS : une unité monétaire = 100 centimes = 10^8 micro-centimes ; arrondi à l'entier le plus proche.
// Le flottant de LiteLLM ne franchit pas cette frontière.

export const MICRO_CENTIMES_PAR_UNITE = 100_000_000;

export type CodeConsommation = "tenant_invalide" | "coffre_indisponible" | "passerelle_indisponible" | "reponse_invalide" | "client_different";

export class ErreurConsommation extends Error {
  constructor(readonly code: CodeConsommation) {
    super(code);
    this.name = "ErreurConsommation";
  }
}

export interface Consommation {
  jetonsEntree: number;
  jetonsSortie: number;
  coutMicroCentimes: number;
}

export interface OptionsConsommation {
  url: string;
  coffre: Pick<Coffre, "lireValeur">;
  fetch?: typeof fetch;
}

const info = z.object({ info: z.object({ spend: z.number().finite().nonnegative(), key_alias: z.string(), metadata: z.object({ tenant_id: z.string() }) }) });
const jetons = z.number().int().nonnegative();
const journal = z.array(z.object({ prompt_tokens: jetons, completion_tokens: jetons }));

export function creerConsommation(o: OptionsConsommation) {
  async function obtenir(chemin: string, cle: string): Promise<unknown> {
    try {
      const r = await (o.fetch ?? fetch)(`${o.url}${chemin}`, {
        headers: { Authorization: `Bearer ${cle}` },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error();
      return await r.json();
    } catch {
      throw new ErreurConsommation("passerelle_indisponible");
    }
  }
  return {
    async lire(tenantId: string, reference: string): Promise<Consommation> {
      try {
        validerTenant(tenantId);
      } catch {
        throw new ErreurConsommation("tenant_invalide");
      }
      let cle: string;
      try {
        cle = await o.coffre.lireValeur(tenantId, reference);
      } catch {
        throw new ErreurConsommation("coffre_indisponible");
      }
      const i = info.safeParse(await obtenir("/key/info", cle));
      const l = journal.safeParse(await obtenir("/spend/logs?summarize=false", cle));
      if (!i.success || !l.success) throw new ErreurConsommation("reponse_invalide");
      if (i.data.info.metadata.tenant_id !== tenantId || i.data.info.key_alias !== `cli-${tenantId}`) throw new ErreurConsommation("client_different");
      const cout = Math.round(i.data.info.spend * MICRO_CENTIMES_PAR_UNITE);
      const somme = (k: "prompt_tokens" | "completion_tokens") => l.data.reduce((n, x) => n + x[k], 0);
      const r = { jetonsEntree: somme("prompt_tokens"), jetonsSortie: somme("completion_tokens"), coutMicroCentimes: cout };
      if (!Object.values(r).every(Number.isSafeInteger)) throw new ErreurConsommation("reponse_invalide");
      return r;
    },
  };
}
