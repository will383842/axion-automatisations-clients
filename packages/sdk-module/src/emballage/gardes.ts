// La liste des licences du livré est celle de la garde du dépôt (ADR 0012), lue à l'exécution : tsc ne suit pas ce script (js-yaml sans types).
const garde = (await import(new URL("../../../../scripts/garde-licences.ts", import.meta.url).href)) as {
  expressionPermise: (expression: string, ok: (id: string) => boolean) => boolean;
  LIVRE: Set<string>;
};
const { expressionPermise, LIVRE } = garde;

export interface Paquet {
  nom: string;
  version: string;
  licence: string | undefined;
}
// Jamais le contenu du fichier : seulement la règle et, au plus, le nom du paquet.
export interface Violation {
  regle: "licence" | "provenance" | "nom" | "cle" | "courriel" | "url-identifiant" | "chemin";
  paquet?: string;
}

// Mêmes six licences que le livré (ADR 0012). Une licence inconnue ou « non commerciale » n'y figure pas : refus.
export function verifierLicences(paquets: Paquet[]): Violation[] {
  return paquets
    .filter((p) => p.licence === undefined || !expressionPermise(p.licence, (id) => LIVRE.has(id)))
    .map((p) => ({ regle: "licence", paquet: p.nom }));
}

const EDITEURS_VISUELS = ["node-red", "@node-red/", "flowise", "@activepieces/", "windmill-client"];
const estN8n = (nom: string) => nom === "n8n" || nom.startsWith("n8n-") || nom.startsWith("@n8n/");
const estEditeur = (nom: string) => EDITEURS_VISUELS.some((e) => (e.endsWith("/") ? nom.startsWith(e) : nom === e));

export function verifierProvenance(paquets: Paquet[]): Violation[] {
  return paquets.filter((p) => estN8n(p.nom) || estEditeur(p.nom)).map((p) => ({ regle: "provenance", paquet: p.nom }));
}

const CLES: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/,
  /(?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[:=]\s*["'][A-Za-z0-9+/_=-]{16,}["']/i,
];
const COURRIEL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const URL_IDENTIFIANT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@"'`]+:[^\s/@"'`]*@/i;
const fictif = (domaine: string) => domaine.toLowerCase() === "exemple.fr" || domaine.toLowerCase().endsWith(".test");

// Lit le texte emballé ; `cheminsMachine` = dossiers de la machine qui ne doivent pas s'y trouver.
export function verifierCode(texte: string, cheminsMachine: string[]): Violation[] {
  const v: Violation[] = [];
  if (CLES.some((r) => r.test(texte))) v.push({ regle: "cle" });
  if ([...texte.matchAll(COURRIEL)].some((m) => !fictif(m[1] ?? ""))) v.push({ regle: "courriel" });
  if (URL_IDENTIFIANT.test(texte)) v.push({ regle: "url-identifiant" });
  if (cheminsMachine.some((c) => c && texte.includes(c))) v.push({ regle: "chemin" });
  return v;
}
