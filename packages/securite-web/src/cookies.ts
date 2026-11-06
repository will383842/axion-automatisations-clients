// Cookie de session (C-681) : préfixe __Host-, Secure, HttpOnly, SameSite Lax (Strict pour les actions risquées), Path=/, jamais de Domain.
// La durée et le renouvellement viennent de C-541 (console) et de T6-04 (portail, 30 jours sur l'application installée) : l'appelant choisit les secondes.
const VALEUR = /^[A-Za-z0-9._~+/=-]{1,512}$/;
const DUREE_MAX = 30 * 24 * 3600;

export function cookieSession(valeur: string, secondes: number, o: { strict?: boolean } = {}): string {
  if (!VALEUR.test(valeur)) throw new Error("valeur de cookie invalide");
  if (!Number.isInteger(secondes) || secondes < 1 || secondes > DUREE_MAX) throw new Error("durée de cookie invalide");
  return `__Host-session=${valeur}; Path=/; Secure; HttpOnly; SameSite=${o.strict ? "Strict" : "Lax"}; Max-Age=${secondes}`;
}

// Garde de CI : ce qui manque à un en-tête Set-Cookie. Vide = conforme.
export function problemesCookie(setCookie: string): string[] {
  const [paire = "", ...attributs] = setCookie.split(/;\s*/);
  const noms = attributs.map((a) => a.split("=")[0]!.toLowerCase());
  const valeur = (n: string) => attributs.find((a) => a.toLowerCase().startsWith(`${n}=`))?.slice(n.length + 1);
  const p: string[] = [];
  if (!paire.startsWith("__Host-")) p.push("nom sans préfixe __Host-");
  if (!noms.includes("secure")) p.push("attribut Secure absent");
  if (!noms.includes("httponly")) p.push("attribut HttpOnly absent");
  if (!/^(lax|strict)$/i.test(valeur("samesite") ?? "")) p.push("SameSite absent ou ni Lax ni Strict");
  if (noms.includes("domain")) p.push("attribut Domain interdit avec __Host-");
  if (valeur("path") !== "/") p.push("Path=/ exigé avec __Host-");
  return p;
}
