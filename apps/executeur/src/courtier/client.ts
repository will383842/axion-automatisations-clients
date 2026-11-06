// Client du courtier côté exécuteur (ADR 0113) : demande la base en LECTURE. La demande ne porte que tenantId et idTache ;
// le rôle n'est jamais envoyé ni lu dans la réponse : il se déduit de la base reçue (cli_<12 hex>) + "_lecture".
export interface OptionsCourtier { url: string; jeton: string; fetch?: typeof fetch }
export interface BaseLecture { hote: string; base: string; role: string; motDePasse: string; expire: Date; valideJusqua: Date | null }

export async function demanderBaseLecture(o: OptionsCourtier, tenantId: string, idTache: string): Promise<BaseLecture> {
  const r = await (o.fetch ?? fetch)(`${o.url}/base-lecture`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${o.jeton}` },
    body: JSON.stringify({ tenantId, idTache }),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
  if (!r?.ok) throw new Error("remise_refusee"); // le corps d'une réponse en erreur n'est jamais repris
  const c = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  const { hote, base, motDePasse, expire, valideJusqua } = c;
  const date = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : undefined);
  if (c["type"] !== "base_lecture" || typeof hote !== "string" || hote === "" || typeof base !== "string" || !/^cli_[0-9a-f]{12}$/.test(base) || typeof motDePasse !== "string" || motDePasse === "" || !date(expire)) throw new Error("reponse_invalide");
  return { hote, base, role: `${base}_lecture`, motDePasse, expire: date(expire)!, valideJusqua: date(valideJusqua) ?? null };
}
