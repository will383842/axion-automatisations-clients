// Test immédiat (A-385) : une lecture sans effet. Aucune valeur n'est rendue ni journalisée.
export type ResultatTest = { ok: true } | { ok: false; code: "refuse_401" | "refuse_403" | "indisponible" | "delai" };
export type Planifier = (action: () => void, ms: number) => () => void;
const planifierReel: Planifier = (action, ms) => { const h = setTimeout(action, ms); return () => clearTimeout(h); };
export const DELAI_TEST_MS = 5000;

// Copie de avecDelai de remise.ts (aucun import hors de connexion/).
export async function avecDelai<T>(appel: (signal: AbortSignal) => Promise<T>, ms: number, planifier: Planifier = planifierReel): Promise<T> {
  const controle = new AbortController();
  let annuler = () => undefined as void;
  const echeance = new Promise<never>((_, ko) => { annuler = planifier(() => { controle.abort(); ko(new Error("delai")); }, ms); });
  try {
    return await Promise.race([appel(controle.signal), echeance]);
  } finally {
    annuler();
  }
}

export interface PortsTest { fetch: typeof fetch; delaiMs?: number; hoteMicrosoft?: string; hoteGoogle?: string; planifier?: Planifier }

export async function testerConnexion(p: PortsTest, fournisseur: "microsoft" | "google", accessToken: string): Promise<ResultatTest> {
  const url = fournisseur === "microsoft"
    ? `${p.hoteMicrosoft ?? "https://graph.microsoft.com"}/v1.0/me/mailFolders/SentItems/messages?$top=1&$select=id`
    : `${p.hoteGoogle ?? "https://gmail.googleapis.com"}/gmail/v1/users/me/messages?maxResults=1`;
  try {
    const r = await avecDelai((signal) => p.fetch(url, { method: "GET", headers: { authorization: `Bearer ${accessToken}` }, signal }), p.delaiMs ?? DELAI_TEST_MS, p.planifier);
    if (r.ok) return { ok: true };
    return { ok: false, code: r.status === 401 ? "refuse_401" : r.status === 403 ? "refuse_403" : "indisponible" };
  } catch (e) {
    return { ok: false, code: e instanceof Error && e.message === "delai" ? "delai" : "indisponible" };
  }
}
