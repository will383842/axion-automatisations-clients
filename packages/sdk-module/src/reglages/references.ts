// C-245 : un réglage ne porte jamais une valeur secrète ou personnelle, seulement une référence « connexion:<famille> ».
export const REFERENCE = /^connexion:[a-z][a-z0-9-]{0,40}$/;
const NOM_SECRET = /mot.?de.?passe|passw|secret|jeton|token|cle.?api|api.?key/i;
const COURRIEL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const JETON = /(?:\b(?:sk|pk|ghp|gho|xox[bap]|akia)[-_]?[a-z0-9]{16,}|eyj[\w-]+\.[\w-]+\.[\w-]+)/i;
const PROFONDEUR_MAX = 10;

function urlAvecSecret(texte: string): boolean {
  for (const mot of texte.match(/https?:\/\/\S+/gi) ?? []) {
    try {
      const u = new URL(mot);
      if (u.username || u.password) return true;
      for (const cle of u.searchParams.keys()) if (NOM_SECRET.test(cle)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

export function enClair(texte: string, cle: string): boolean {
  if (texte.startsWith("connexion:")) return !REFERENCE.test(texte);
  if (NOM_SECRET.test(cle) && texte !== "") return true;
  const net = texte.normalize("NFKC").replace(/\s*[([{]\s*at\s*[)\]}]\s*/gi, "@");
  return COURRIEL.test(net) || JETON.test(net) || urlAvecSecret(net);
}

// Parcourt les valeurs (objets et listes compris) et rend les chemins qui portent une valeur en clair.
export function trouverEnClair(valeur: unknown, chemin = "", cle = "", profondeur = 0): string[] {
  if (typeof valeur === "string") return enClair(valeur, cle) ? [chemin] : [];
  if (!valeur || typeof valeur !== "object") return [];
  if (profondeur > PROFONDEUR_MAX) return [chemin];
  return Object.entries(valeur).flatMap(([k, v]) =>
    trouverEnClair(v, chemin ? `${chemin}.${k}` : k, Array.isArray(valeur) ? cle : k, profondeur + 1),
  );
}
