// Nettoyage des événements AVANT l'envoi à Sentry (A-113, C-025). Il tourne dans le processus : un nettoyage côté Sentry serait trop tard.
// Liste fermée : seuls l'application, le code d'erreur, le message masqué et borné, la route sans paramètres, la version, la cellule, l'instance opaque et des cadres de pile réduits sortent.
// Limite connue (garde non exhaustive par nature) : les motifs ne reconnaissent pas toute forme de secret ; le vrai rempart est la liste fermée de champs, la borne de taille et le masqueur des secrets réellement lus, injecté par l'application.

export const MASQUE = "[masqué]";

const MOTIFS: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi, // chaîne de connexion avec mot de passe
  /\bBasic\s+[A-Za-z0-9+/=_-]{6,}/gi, // en-tête Basic
  /\b(?:password|passwd|pwd|secret|token|jeton|api[_-]?key)\s*[=:]\s*[^\s;,&"']+/gi, // « password=… »
  /\bs\.[A-Za-z0-9]{20,}\b/g, // jeton OpenBao (ancienne forme)
  /eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+){0,2}/g, // jeton signé (JWT)
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // adresse e-mail
  /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/gi, // IBAN, majuscules ou minuscules
  /(?:\+33|0033|\b0)[\s.-]?(?:\(0\)[\s.-]?)?[1-9](?:[\s.-]?\d{2}){4}\b/g, // téléphone français
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_]+/g, // clés de fournisseurs
  /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abp]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{8,}|hvs\.[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/g,
];

export function masquer(texte: string): string {
  return MOTIFS.reduce((t, motif) => t.replace(motif, MASQUE), texte);
}

// Route sans paramètres : ni requête, ni identifiant, ni jeton, ni adresse e-mail (chaque segment passe par masquer()).
// Un segment qui suit « accuse », « reinit » ou « invitations » tient la place d'un paramètre déclaré : il est masqué quelle que soit sa forme.
const AVANT_PARAMETRE = new Set(["accuse", "reinit", "invitations"]);

export function routeSansParametres(url: unknown): string | undefined {
  if (typeof url !== "string" || url === "") return undefined;
  let chemin = url;
  try {
    chemin = new URL(url, "http://local.invalide").pathname;
  } catch {
    chemin = url.split(/[?#]/)[0] ?? "";
  }
  let apres = false;
  return chemin
    .split("/")
    .map((segment) => {
      const sortie = segment !== "" && apres ? ":id" : segmentSansParametre(segment);
      apres ||= AVANT_PARAMETRE.has(segment);
      return sortie;
    })
    .join("/");
}

// Un segment est gardé s'il est lisible (sans chiffre, 24 caractères au plus, sans @ ; = %) et sans secret ; la version d'API (v1, v2…) est gardée.
function segmentSansParametre(segment: string): string {
  if (/^v\d{1,2}$/.test(segment)) return segment;
  if (/\d|[@;=%]/.test(segment) || segment.length > 24) return ":id";
  return masquer(segment) === segment ? segment : ":id";
}

export type Application = "api" | "executeur" | "console";

export interface CadreNettoye {
  filename: string;
  function: string;
  lineno?: number;
}

// Forme Sentry (exception.values[0], tags, release, contexts.app) : le SDK sait l'envoyer telle quelle.
export interface EvenementNettoye {
  event_id?: string;
  timestamp?: number;
  release: string;
  message: string;
  exception: { values: [{ type: string; value: string; stacktrace?: { frames: CadreNettoye[] } }] };
  tags: { application: Application; cellule: string; route: string };
  contexts: { app: { cellule: string; instance: string } };
}

export interface ContexteNettoyage {
  application: Application;
  // Masque les valeurs de secrets réellement lues (OpenBao) ; appliqué avant les motifs.
  masquerSecrets?: (texte: string) => string;
}

const BORNE_MESSAGE = 500;
const BORNE_CADRES = 50;
type Objet = Record<string, unknown>;
const objet = (v: unknown): Objet => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Objet) : {});

export function avantEnvoi(brut: unknown, contexte: ContexteNettoyage): EvenementNettoye {
  const secrets = contexte.masquerSecrets ?? ((t: string) => t);
  // Le masqueur des secrets réellement lus passe AVANT les motifs : un motif ne doit pas couper un secret en deux et en laisser la suite en clair.
  const nettoyer = (t: string): string => masquer(secrets(t));
  const texte = (v: unknown): string => (typeof v === "string" ? nettoyer(v).slice(0, BORNE_MESSAGE) : "");
  // Identifiants opaques et noms de cellule : forme restreinte, sinon vides.
  const identifiant = (v: unknown): string => (typeof v === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(v) && nettoyer(v) === v ? v : "");

  const ev = objet(brut);
  const valeurs = objet(ev["exception"])["values"];
  const exception = objet(Array.isArray(valeurs) ? valeurs[0] : undefined);
  const app = objet(objet(ev["contexts"])["app"]);
  const tags = objet(ev["tags"]);
  const cellule = identifiant(app["cellule"]) || identifiant(tags["cellule"]);
  const messageBrut = ev["message"];
  const message = texte(typeof messageBrut === "string" ? messageBrut : objet(messageBrut)["formatted"]) || texte(exception["value"]);

  const cadres = objet(exception["stacktrace"])["frames"];
  const frames: CadreNettoye[] = (Array.isArray(cadres) ? cadres : []).slice(-BORNE_CADRES).map((c) => {
    const cadre = objet(c);
    const fichier = typeof cadre["filename"] === "string" ? (cadre["filename"].split(/[\\/]/).pop() ?? "") : "";
    const sortie: CadreNettoye = { filename: texte(fichier).slice(0, 100), function: identifiant(cadre["function"]) || "?" };
    const ligne = cadre["lineno"];
    if (typeof ligne === "number" && Number.isInteger(ligne) && ligne >= 0) sortie.lineno = ligne;
    return sortie;
  });
  const valeur: { type: string; value: string; stacktrace?: { frames: CadreNettoye[] } } = {
    type: identifiant(exception["type"]) || "ErreurInconnue",
    value: texte(exception["value"]),
  };
  if (frames.length > 0) valeur.stacktrace = { frames };

  const sortie: EvenementNettoye = {
    release: identifiant(ev["release"]),
    message,
    exception: { values: [valeur] },
    tags: { application: contexte.application, cellule, route: routeSansParametres(objet(ev["request"])["url"]) ?? "" },
    contexts: { app: { cellule, instance: identifiant(app["instance"]) } },
  };
  if (typeof ev["event_id"] === "string" && /^[0-9a-f]{32}$/.test(ev["event_id"])) sortie.event_id = ev["event_id"];
  if (typeof ev["timestamp"] === "number" && Number.isFinite(ev["timestamp"])) sortie.timestamp = ev["timestamp"];
  return sortie;
}
