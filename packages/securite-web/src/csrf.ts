// Protection contre les requêtes forgées (C-681) : tout geste qui change quelque chose exige l'origine attendue ET un jeton lié à la session.
// Un GET ne change jamais rien : il passe sans jeton. Web Crypto seulement ; la vérification du jeton est à temps constant (crypto.subtle.verify).
const SURES = new Set(["GET", "HEAD", "OPTIONS"]);
const FORME = /^[A-Za-z0-9_-]{43}$/;
const encodeur = new TextEncoder();
const base64url = (o: Uint8Array) => btoa(String.fromCharCode(...o)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

async function cle(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("secret CSRF trop court");
  return crypto.subtle.importKey("raw", encodeur.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}
const message = (sessionId: string) => {
  if (!sessionId) throw new Error("session absente");
  return encodeur.encode(`csrf:${sessionId}`);
};

export async function creerJetonCsrf(secret: string, sessionId: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", await cle(secret, "sign"), message(sessionId))));
}

export async function verifierJetonCsrf(secret: string, sessionId: string, jeton: string | null): Promise<boolean> {
  if (!jeton || !FORME.test(jeton)) return false;
  const octets = Uint8Array.from(atob(jeton.replaceAll("-", "+").replaceAll("_", "/") + "="), (c) => c.charCodeAt(0));
  return crypto.subtle.verify("HMAC", await cle(secret, "verify"), octets, message(sessionId));
}

export interface Geste { methode: string; origine: string | null; origineAttendue: string; jeton: string | null; sessionId: string; secret: string }
// Origine d'abord (refus avant tout calcul), puis jeton. Origine absente, « null » ou différente d'un seul caractère : refus.
export async function verifierGeste(g: Geste): Promise<"ok" | "origine" | "jeton"> {
  if (SURES.has(g.methode)) return "ok";
  if (!g.origine || g.origine !== g.origineAttendue) return "origine";
  return (await verifierJetonCsrf(g.secret, g.sessionId, g.jeton)) ? "ok" : "jeton";
}
