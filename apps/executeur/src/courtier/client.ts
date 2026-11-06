// Client du courtier côté exécuteur (ADR 0113) : demande la base en LECTURE. La demande ne porte que tenantId et idTache ;
// le rôle n'est jamais envoyé ni lu dans la réponse : il se déduit de la base reçue (cli_<12 hex>) + "_lecture".
// `hotes` : liste fermée des hôtes de la grappe (configuration de l'exécuteur) ; un hôte remis hors de la liste est refusé.
// `origines` : liste fermée des origines du courtier (https://hote, sans port, chemin ni identifiants) ; `url` doit en être exactement une.
export interface OptionsCourtier { url: string; jeton: string; hotes: readonly string[]; origines: readonly string[]; fetch?: typeof fetch }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_TACHE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export interface BaseLecture { hote: string; base: string; role: string; motDePasse: string; expire: Date; valideJusqua: Date | null }

export async function demanderBaseLecture(o: OptionsCourtier, tenantId: string, idTache: string): Promise<BaseLecture> {
  if (!UUID.test(tenantId) || !ID_TACHE.test(idTache)) throw new Error("demande_invalide"); // rien ne part sur le réseau
  if (!o.origines.includes(o.url) || !/^https:\/\/[a-z0-9.-]+$/.test(o.url)) throw new Error("url_courtier_refusee"); // rien ne part sur le réseau
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
  if (c["type"] !== "base_lecture" || typeof hote !== "string" || !o.hotes.includes(hote) || typeof base !== "string" || !/^cli_[0-9a-f]{12}$/.test(base) || typeof motDePasse !== "string" || motDePasse === "" || !date(expire)) throw new Error("reponse_invalide");
  return { hote, base, role: `${base}_lecture`, motDePasse, expire: date(expire)!, valideJusqua: date(valideJusqua) ?? null };
}
