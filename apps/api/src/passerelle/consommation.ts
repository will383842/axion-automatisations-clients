import { createHash } from "node:crypto";
import { z } from "zod";
import { validerTenant, type Coffre } from "../coffre/coffre.js";

// Consommation d'un client (A-059), lue côté serveur avec une clé d'équipe de MOINDRE privilège : jamais la clé maîtresse, jamais la clé du client.
// Cette clé est limitée par allowed_routes à la lecture de /spend/logs ; sa valeur vient du coffre (C-011) par `lireCleEquipe`, et n'entre
// ni dans une erreur, ni dans une trace, ni dans une adresse. Le journal est filtré par l'empreinte SHA-256 de la clé du client, calculée
// ICI : la clé du client ne part jamais vers la passerelle pour cette lecture. Chaque ligne rendue est revérifiée.
// Montants en micro-centimes ENTIERS : une unité monétaire = 100 centimes = 10^8 micro-centimes ; arrondi à l'entier le plus proche.
// Le flottant de LiteLLM ne franchit pas cette frontière.

export const MICRO_CENTIMES_PAR_UNITE = 100_000_000;

export type CodeConsommation = "tenant_invalide" | "coffre_indisponible" | "cle_equipe_indisponible" | "passerelle_indisponible" | "reponse_invalide" | "client_different";

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
  /** Clé d'équipe de lecture de la dépense (valeur du coffre, jamais la clé maîtresse). */
  lireCleEquipe: () => Promise<string>;
  fetch?: typeof fetch;
}

const jetons = z.number().int().nonnegative();
// Forme réelle d'une ligne de /spend/logs (table LiteLLM_SpendLogs) : seuls les champs lus ici sont exigés.
const journal = z.array(z.object({ api_key: z.string(), spend: z.number().finite().nonnegative(), prompt_tokens: jetons, completion_tokens: jetons }));
// Le produit flottant peut tomber juste sous le demi (1,5e-8 × 10^8 = 1,4999999999999998) : on le ramène à 15 chiffres avant d'arrondir.
const enMicroCentimes = (unites: number) => Math.round(Number((unites * MICRO_CENTIMES_PAR_UNITE).toPrecision(15)));
const empreinteDe = (cle: string) => createHash("sha256").update(cle).digest("hex");

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
      // Le coffre refuse la référence d'un autre client : aucun appel à la passerelle avant ce contrôle.
      let cleClient: string;
      try {
        cleClient = await o.coffre.lireValeur(tenantId, reference);
      } catch {
        throw new ErreurConsommation("coffre_indisponible");
      }
      let cleEquipe: string;
      try {
        cleEquipe = await o.lireCleEquipe();
      } catch {
        throw new ErreurConsommation("cle_equipe_indisponible");
      }
      if (!cleEquipe || !cleClient) throw new ErreurConsommation(cleEquipe ? "coffre_indisponible" : "cle_equipe_indisponible");
      const empreinte = empreinteDe(cleClient);
      const l = journal.safeParse(await obtenir(`/spend/logs?api_key=${empreinte}&summarize=false`, cleEquipe));
      if (!l.success) throw new ErreurConsommation("reponse_invalide");
      // Chaque ligne doit porter l'empreinte attendue : une ligne d'un autre client fait échouer la lecture (jamais une somme mélangée).
      if (l.data.some((x) => x.api_key !== empreinte)) throw new ErreurConsommation("client_different");
      if (l.data.some((x) => x.spend > 0 !== x.prompt_tokens + x.completion_tokens > 0)) throw new ErreurConsommation("reponse_invalide");
      const somme = (k: "prompt_tokens" | "completion_tokens") => l.data.reduce((n, x) => n + x[k], 0);
      const depense = l.data.reduce((n, x) => n + x.spend, 0);
      const r = { jetonsEntree: somme("prompt_tokens"), jetonsSortie: somme("completion_tokens"), coutMicroCentimes: enMicroCentimes(depense) };
      if (!Object.values(r).every(Number.isSafeInteger)) throw new ErreurConsommation("reponse_invalide");
      return r;
    },
  };
}
