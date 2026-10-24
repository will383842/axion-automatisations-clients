// Garde des destinations (C-533) : en test et en CI, chaque variable d'envoi doit viser un service du socle.
// Elle ne renvoie que le NOM des variables fautives, jamais leur valeur.

const VARIABLES = /^(?:SMTP_HOTE|GRAPH_URL|GMAIL_URL|TELEGRAM_URL|MAILWIZZ_URL|WEBHOOK_\w+)$/;
// Hôtes locaux, noms simples du réseau « interne » (sans point, sauf un nombre seul, décimal ou 0x…, qui est une adresse IP) ou en .test.
const HOTE_SOCLE = /^(?:localhost|127\.0\.0\.1|\[::1\]|(?!(?:0x[0-9a-f]+|\d+)$)[a-z0-9-]+|(?:[a-z0-9-]+\.)+test)$/;

function hoteDe(valeur: string): string {
  const texte = valeur.trim();
  // Une valeur sans schéma (SMTP_HOTE) est déjà un nom d'hôte, éventuellement suivi d'un port.
  if (!texte.includes("://")) return texte.replace(/:\d+$/, "").toLowerCase();
  try {
    return new URL(texte).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function verifierDestinations(env: Record<string, string | undefined>): string[] {
  const fautives: string[] = [];
  for (const [nom, valeur] of Object.entries(env)) {
    if (!VARIABLES.test(nom) || !valeur) continue;
    if (!HOTE_SOCLE.test(hoteDe(valeur))) fautives.push(nom);
  }
  return fautives;
}

// Appelée au démarrage de l'API en NODE_ENV=test et en CI : arrêt immédiat, nom de la variable seulement.
export function exigerDestinationsDeTest(env: Record<string, string | undefined> = process.env): void {
  const fautives = verifierDestinations(env);
  if (fautives.length > 0) throw new Error(`Destination d'envoi refusée en test : ${fautives.join(", ")}`);
}
