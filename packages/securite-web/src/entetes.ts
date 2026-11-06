import { construireCsp } from "./csp.ts";

// En-têtes de sécurité de toute réponse des écrans (C-681). Referrer-Policy « no-referrer » : le jeton d'invitation ne fuit jamais par Referer.
export function entetesSecurite(nonce: string): Record<string, string> {
  return {
    "content-security-policy": construireCsp({ nonce }),
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
    "cross-origin-opener-policy": "same-origin",
  };
}

export function appliquerEntetes(h: Headers, nonce: string): void {
  for (const [nom, valeur] of Object.entries(entetesSecurite(nonce))) h.set(nom, valeur);
}

// Garde de CI : liste ce qui manque ou s'est affaibli dans les en-têtes d'une réponse. Vide = conforme.
export function problemesEntetes(h: Headers): string[] {
  const p: string[] = [];
  for (const nom of Object.keys(entetesSecurite("AAAA"))) if (!h.get(nom)) p.push(`${nom} : absent`);
  const csp = h.get("content-security-policy");
  if (csp) {
    if (/unsafe-inline|unsafe-eval/.test(csp)) p.push("content-security-policy : unsafe-inline ou unsafe-eval interdit");
    if (!/script-src[^;]*'nonce-[A-Za-z0-9+/]+={0,2}'/.test(csp)) p.push("content-security-policy : script-src sans nonce");
    if (!csp.includes("frame-ancestors 'none'")) p.push("content-security-policy : frame-ancestors 'none' exigé");
    if (!csp.includes("form-action 'self'")) p.push("content-security-policy : form-action 'self' exigé");
  }
  if (h.get("referrer-policy") && h.get("referrer-policy") !== "no-referrer") p.push("referrer-policy : no-referrer exigé");
  if (h.get("x-content-type-options") && h.get("x-content-type-options") !== "nosniff") p.push("x-content-type-options : nosniff exigé");
  return p;
}
