// Garde des destinations (C-533) : en test et en CI, chaque variable d'envoi doit viser un service du socle.
// Elle ne renvoie que le NOM des variables fautives, jamais leur valeur.

// Toute variable qui désigne une adresse ou un hôte (casse ignorée), pas seulement une liste fermée de noms.
const VARIABLE = /(?:_URL|_HOTE|_HOST)$|^WEBHOOK_/i;
// Hôtes locaux ou en .test ; un nom à une seule étiquette doit être un service du socle (voir verifierDestinations).
const HOTE_LOCAL = /^(?:localhost|127\.0\.0\.1|\[::1\]|(?:[a-z0-9-]+\.)+test)$/;
const UNE_ETIQUETTE = /^[a-z][a-z0-9-]*$/;

// Une valeur sans schéma (SMTP_HOTE) est un nom d'hôte, éventuellement suivi d'un port : l'analyseur d'URL la lit.
function hoteDe(valeur: string): string {
  try {
    return new URL(valeur.includes("://") ? valeur : `http://${valeur}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// `servicesDuSocle` : noms des services du compose assemblé. Sans eux, aucun nom simple n'est accepté.
export function verifierDestinations(env: Record<string, string | undefined>, servicesDuSocle: ReadonlySet<string> = new Set()): string[] {
  const fautives: string[] = [];
  for (const [nom, valeur] of Object.entries(env)) {
    if (!VARIABLE.test(nom) || !valeur) continue;
    const hote = hoteDe(valeur);
    if (!HOTE_LOCAL.test(hote) && !(UNE_ETIQUETTE.test(hote) && servicesDuSocle.has(hote))) fautives.push(nom);
  }
  return fautives;
}

// Appelée au démarrage de l'API en NODE_ENV=test et en CI : arrêt immédiat, nom de la variable seulement.
export function exigerDestinationsDeTest(env: Record<string, string | undefined> = process.env, servicesDuSocle: ReadonlySet<string> = new Set()): void {
  const fautives = verifierDestinations(env, servicesDuSocle);
  if (fautives.length > 0) throw new Error(`Destination d'envoi refusée en test : ${fautives.join(", ")}`);
}
