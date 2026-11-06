// Politique de contenu stricte (C-681) : aucun « unsafe-inline » ni « unsafe-eval » ; les scripts passent par un nonce neuf à chaque réponse.
// Web Crypto seulement (pas de module Node) : ce code tourne aussi dans le middleware de la console.
const NONCE = /^[A-Za-z0-9+/]{1,64}={0,2}$/;

export function genererNonce(): string {
  const octets = new Uint8Array(16);
  crypto.getRandomValues(octets);
  return btoa(String.fromCharCode(...octets));
}

// Un nonce qui contiendrait « ; », une apostrophe, une virgule ou un saut de ligne sortirait de l'en-tête : il est refusé.
export function construireCsp(o: { nonce: string }): string {
  if (!NONCE.test(o.nonce)) throw new Error("nonce invalide");
  return [
    "default-src 'none'",
    `script-src 'nonce-${o.nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${o.nonce}'`,
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}
