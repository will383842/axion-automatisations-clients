// Journal de l'API : l'adresse d'une requête n'est jamais écrite avec ses paramètres (A-005, A-346, C-531).
// Un jeton passé dans l'adresse (« ?code= », lien signé) ne doit pas entrer dans le journal : on retire TOUT ce qui suit
// le « ? » ou le « # », jamais une liste de noms (une liste oublie toujours le prochain).

export function cheminSansRequete(url: string | undefined): string {
  if (typeof url !== "string") return "";
  const coupe = url.search(/[?#]/);
  return coupe === -1 ? url : url.slice(0, coupe);
}

// Pour un texte libre (message ou pile d'erreur) : retire la partie « ?… » ou « #… » de toute adresse ou chemin trouvé.
const ADRESSE_AVEC_REQUETE = /((?:https?:\/\/[^\s/?#"'<>]+)?\/[^\s?#"'<>]*)[?#][^\s"'<>]*/g;

export function retirerRequetes(texte: string): string {
  return texte.replace(ADRESSE_AVEC_REQUETE, "$1");
}

// Sérialiseurs du journal Fastify : ni hôte, ni IP, ni port, ni en-têtes, ni corps.
export const serialiseursJournal = {
  req: (r: { method?: string; url?: string }) => ({ method: String(r.method ?? ""), url: cheminSansRequete(r.url) }),
  res: (r: { statusCode?: number }) => ({ statusCode: Number(r.statusCode ?? 0) }),
  err: (e: { name?: string; code?: unknown; message?: unknown; stack?: unknown } | null | undefined) => ({
    type: String(e?.name ?? "Error"),
    ...(e?.code === undefined ? {} : { code: String(e.code) }),
    message: retirerRequetes(String(e?.message ?? "")),
    stack: retirerRequetes(String(e?.stack ?? "")),
  }),
};
