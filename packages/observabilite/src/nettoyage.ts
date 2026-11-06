// Nettoyage des événements AVANT l'envoi à Sentry (A-113, C-025). Il tourne dans le processus : un nettoyage côté Sentry serait trop tard.
// Liste fermée : seuls l'application, le code d'erreur, le message masqué, la route sans paramètres, la version, la cellule et l'instance opaque sortent.

export const MASQUE = "[masqué]";

const MOTIFS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+){0,2}/g, // jeton signé (JWT)
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // adresse e-mail
  /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, // IBAN
  /(?:\+33|0033|\b0)[\s.-]?[1-9](?:[\s.-]?\d{2}){4}\b/g, // téléphone français
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_]+/g, // clés de fournisseurs
  /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abp]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{8,}|hvs\.[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/g,
];

export function masquer(texte: string): string {
  return MOTIFS.reduce((t, motif) => t.replace(motif, MASQUE), texte);
}

// Route sans paramètres : ni requête, ni identifiant, ni jeton, ni adresse e-mail (chaque segment passe par masquer()).
export function routeSansParametres(url: unknown): string | undefined {
  if (typeof url !== "string" || url === "") return undefined;
  let chemin = url;
  try {
    chemin = new URL(url, "http://local.invalide").pathname;
  } catch {
    chemin = url.split(/[?#]/)[0] ?? "";
  }
  return chemin.split("/").map(segmentSansParametre).join("/");
}

// Un segment est gardé s'il est lisible (sans chiffre, 24 caractères au plus) et sans secret ; la version d'API (v1, v2…) est gardée.
function segmentSansParametre(segment: string): string {
  if (/^v\d{1,2}$/.test(segment)) return segment;
  if (/\d/.test(segment) || segment.length > 24) return ":id";
  return masquer(segment) === segment ? segment : ":id";
}

export type Application = "api" | "executeur" | "console";

export interface EvenementNettoye {
  application: Application;
  code: string;
  message: string;
  route: string;
  version: string;
  cellule: string;
  instance: string;
}

type Objet = Record<string, unknown>;
const objet = (v: unknown): Objet => (v !== null && typeof v === "object" ? (v as Objet) : {});
const texte = (v: unknown): string => (typeof v === "string" ? masquer(v) : "");
// Identifiants opaques et noms de cellule : forme restreinte, sinon masqués.
const identifiant = (v: unknown): string => (typeof v === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(v) && masquer(v) === v ? v : "");

export function avantEnvoi(brut: unknown, contexte: { application: Application }): EvenementNettoye {
  const ev = objet(brut);
  const premiere = objet(objet(objet(ev["exception"])["values"] as unknown)[0]);
  const valeurs = objet(ev["exception"])["values"];
  const exception = objet(Array.isArray(valeurs) ? valeurs[0] : premiere);
  const app = objet(objet(ev["contexts"])["app"]);
  const tags = objet(ev["tags"]);
  return {
    application: contexte.application,
    code: identifiant(exception["type"]) || "ErreurInconnue",
    message: texte(ev["message"]) || texte(exception["value"]),
    route: routeSansParametres(objet(ev["request"])["url"]) ?? "",
    version: identifiant(ev["release"]),
    cellule: identifiant(app["cellule"]) || identifiant(tags["cellule"]),
    instance: identifiant(app["instance"]),
  };
}
