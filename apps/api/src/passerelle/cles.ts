import { validerTenant, type Coffre } from "../coffre/coffre.js";

// Clés virtuelles de la passerelle (A-058) : une clé par client, alias cli-<tenantId>, modèles permis explicites.
// La valeur de la clé ne va qu'au coffre (T1A-06) ; l'appelant ne reçoit que la référence. Les erreurs ne portent qu'un code.

export const MODELES_PERMIS = ["claude-standard", "mistral-souverain", "gpt-option"] as const;

export type CodePasserelle =
  | "tenant_invalide"
  | "modeles_invalides"
  | "cle_maitresse_indisponible"
  | "passerelle_indisponible"
  | "reponse_invalide"
  | "coffre_indisponible";

export class ErreurPasserelle extends Error {
  constructor(readonly code: CodePasserelle) {
    super(code);
    this.name = "ErreurPasserelle";
  }
}

export interface OptionsCles {
  url: string;
  lireCleMaitre: () => Promise<string>;
  coffre: Pick<Coffre, "rangerIdentifiant">;
  fetch?: typeof fetch;
}

const DELAI_MS = 5000;

function tenant(tenantId: string): string {
  try {
    return validerTenant(tenantId);
  } catch {
    throw new ErreurPasserelle("tenant_invalide");
  }
}

export function creerCles(o: OptionsCles) {
  async function appeler(chemin: string, corps: unknown): Promise<unknown> {
    let maitre: string;
    try {
      maitre = await o.lireCleMaitre();
    } catch {
      throw new ErreurPasserelle("cle_maitresse_indisponible");
    }
    try {
      const r = await (o.fetch ?? fetch)(`${o.url}${chemin}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${maitre}`, "Content-Type": "application/json" },
        body: JSON.stringify(corps),
        redirect: "error", // la clé maîtresse ne suit jamais une redirection
        signal: AbortSignal.timeout(DELAI_MS),
      });
      if (!r.ok) throw new Error();
      return await r.json();
    } catch {
      throw new ErreurPasserelle("passerelle_indisponible");
    }
  }
  const revoquer = (t: string) => appeler("/key/delete", { key_aliases: [`cli-${t}`] });

  return {
    async creerCleClient(tenantId: string, options: { modelesPermis: string[] }): Promise<{ reference: string }> {
      const t = tenant(tenantId);
      // Une liste vide vaut « tous les modèles » pour LiteLLM, et un joker aussi : seules les trois familles sont permises.
      const m = options.modelesPermis;
      if (!Array.isArray(m) || m.length === 0 || m.some((x) => !(MODELES_PERMIS as readonly string[]).includes(x))) throw new ErreurPasserelle("modeles_invalides");
      const reponse = await appeler("/key/generate", { key_alias: `cli-${t}`, models: [...new Set(m)], metadata: { tenant_id: t } });
      const cle = typeof reponse === "object" && reponse !== null ? (reponse as { key?: unknown }).key : undefined;
      if (typeof cle !== "string" || !cle.startsWith("sk-") || cle.length < 8) throw new ErreurPasserelle("reponse_invalide");
      try {
        return { reference: await o.coffre.rangerIdentifiant(t, "cle-passerelle", cle) };
      } catch {
        await revoquer(t).catch(() => undefined); // jamais de clé vivante sans référence
        throw new ErreurPasserelle("coffre_indisponible");
      }
    },
    async revoquerCle(tenantId: string): Promise<void> {
      await revoquer(tenant(tenantId));
    },
  };
}
