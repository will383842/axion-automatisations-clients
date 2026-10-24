// Garde des destinations (C-533) : en test et en CI, chaque variable d'envoi doit viser un service du socle.
// Elle ne renvoie que le NOM des variables fautives, jamais leur valeur.

// Une variable est « d'envoi » si son nom (majuscules ou non) désigne une adresse ou un hôte, ou commence par SMTP_ / WEBHOOK_.
const VARIABLE_ENVOI = /(?:^|_)(?:URL|URI|HOTE|HOST|ENDPOINT)$|^(?:SMTP|WEBHOOK)_/i;
const LOCAUX = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Une valeur sans schéma est un nom d'hôte, avec un port facultatif, et rien d'autre.
const HOTE_SEUL = /^[a-z0-9.-]+(?::\d+)?$/i;

function hoteDe(valeur: string): string {
  const texte = valeur.trim();
  if (texte.includes("://")) {
    try {
      return new URL(texte).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  return HOTE_SEUL.test(texte) ? texte.replace(/:\d+$/, "").toLowerCase() : "";
}

// Un hôte est du socle s'il est local, en .test, ou s'il porte le nom d'un service du socle (nom à une seule étiquette).
// Un nombre seul (décimal ou 0x…) est une adresse IP déguisée : jamais accepté.
function estDuSocle(hote: string, services: ReadonlySet<string>): boolean {
  if (hote === "" || LOCAUX.has(hote)) return hote !== "";
  if (/^(?:0x[0-9a-f]*|\d+)$/.test(hote)) return false;
  if (!hote.includes(".")) return services.has(hote);
  return /^(?:[a-z0-9-]+\.)+test$/.test(hote);
}

export function verifierDestinations(env: Record<string, string | undefined>, services: ReadonlySet<string> = new Set()): string[] {
  const fautives: string[] = [];
  for (const [nom, valeur] of Object.entries(env)) {
    if (!VARIABLE_ENVOI.test(nom) || !valeur) continue;
    if (!estDuSocle(hoteDe(valeur), services)) fautives.push(nom);
  }
  return fautives;
}

// Appelée au démarrage de l'API en NODE_ENV=test et en CI : arrêt immédiat, nom de la variable seulement.
export function exigerDestinationsDeTest(env: Record<string, string | undefined> = process.env, services: ReadonlySet<string> = new Set()): void {
  const fautives = verifierDestinations(env, services);
  if (fautives.length > 0) throw new Error(`Destination d'envoi refusée en test : ${fautives.join(", ")}`);
}
