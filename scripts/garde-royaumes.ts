import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Garde des fichiers de royaume Keycloak réels (A-062, C-001, C-002). JSON lu par l'analyseur JSON, rien n'est exécuté.
// La surcouche d'essai (ops/socle/keycloak/essai/) n'est jamais lue ici : un client d'essai dans un fichier réel est refusé.

const SESSION_MAX = 8 * 3600;
const JETON_MAX = 300;
const FACTEUR_ECHECS_MAX = 5;
const SECRET_ENV = /^\$\{env\.[A-Z][A-Z0-9_]*\}$/;
// Seuls authentificateurs permis dans le flux de navigateur de l'équipe : tout autre (SMS, fournisseur d'identité, clé d'accès seule…) est refusé.
// La condition de niveau d'authentification ne sert qu'à poser le niveau « mfa » (acr) APRÈS le double facteur, qui reste REQUIRED à part.
const PERMIS = new Set(["auth-cookie", "auth-username-password-form", "auth-otp-form", "webauthn-authenticator", "conditional-level-of-authentication"]);
const FACTEURS = new Set(["auth-otp-form", "webauthn-authenticator"]);

type Objet = Record<string, unknown>;
const estObjet = (v: unknown): v is Objet => typeof v === "object" && v !== null && !Array.isArray(v);
const liste = (v: unknown): Objet[] => (Array.isArray(v) ? v.filter(estObjet) : []);

function verifierDurees(r: Objet, echec: (m: string) => void): void {
  const duree = (cle: string, max: number) => {
    const v = r[cle];
    if (typeof v !== "number" || !(v > 0) || v > max) echec(`${cle} doit être un nombre de secondes de 1 à ${max} (absent = valeur par défaut de Keycloak)`);
  };
  duree("ssoSessionMaxLifespan", SESSION_MAX);
  duree("ssoSessionIdleTimeout", SESSION_MAX);
  duree("accessTokenLifespan", JETON_MAX);
}

// Force brute (C-002) : absent = faux par défaut de Keycloak ; verrouillage temporaire seulement, échecs peu nombreux.
function verifierForceBrute(r: Objet, echec: (m: string) => void): void {
  if (r["bruteForceProtected"] !== true) echec("bruteForceProtected doit être true (absent = faux par défaut de Keycloak)");
  const f = r["failureFactor"];
  if (typeof f !== "number" || !(f >= 1) || f > FACTEUR_ECHECS_MAX) echec(`failureFactor doit être un nombre de 1 à ${FACTEUR_ECHECS_MAX}`);
  if (r["permanentLockout"] === true) echec("permanentLockout interdit : verrouillage temporaire seulement");
}

function verifierClients(r: Objet, echec: (m: string) => void): void {
  for (const c of liste(r["clients"])) {
    const id = String(c["clientId"]);
    if (/^essai-|-direct$/.test(id)) echec(`client « ${id} » : client d'essai interdit dans un fichier réel`);
    if (c["directAccessGrantsEnabled"] !== false) echec(`client « ${id} » : directAccessGrantsEnabled doit être false (absent = valeur par défaut de Keycloak)`);
    if (c["implicitFlowEnabled"] === true) echec(`client « ${id} » : implicitFlowEnabled interdit`);
    if (!estObjet(c["attributes"]) || c["attributes"]["pkce.code.challenge.method"] !== "S256") echec(`client « ${id} » : PKCE S256 obligatoire`);
    for (const cle of ["redirectUris", "webOrigins"]) {
      const v = c[cle];
      if (Array.isArray(v) && v.some((x) => typeof x !== "string" || x.includes("*"))) echec(`client « ${id} » : ${cle} sans joker « * »`);
    }
    const liaisons = c["authenticationFlowBindingOverrides"];
    if (liaisons !== undefined && !(estObjet(liaisons) && Object.keys(liaisons).length === 0)) echec(`client « ${id} » : authenticationFlowBindingOverrides interdit (contourne le flux du royaume)`);
    // offline_access donne des sessions hors ligne de 30 jours : déclarer les portées, sans elle.
    for (const cle of ["defaultClientScopes", "optionalClientScopes"]) {
      const v = c[cle];
      if (!Array.isArray(v) || v.includes("offline_access")) echec(`client « ${id} » : ${cle} doit être déclaré, sans offline_access`);
    }
    if (c["secret"] !== undefined && !(typeof c["secret"] === "string" && SECRET_ENV.test(c["secret"]))) echec(`client « ${id} » : secret en clair (utiliser \${env.NOM})`);
  }
}

// Parcourt le flux de navigateur et ses sous-flux ; vérifie l'ordre mot de passe puis double facteur obligatoire.
function verifierDoubleFacteur(r: Objet, echec: (m: string) => void): void {
  const flux = new Map(liste(r["authenticationFlows"]).map((f) => [String(f["alias"]), liste(f["authenticationExecutions"])]));
  const racine = String(r["browserFlow"]);
  if (!flux.has(racine)) return echec(`browserFlow « ${racine} » absent des flux déclarés`);
  const vus = new Set<string>();
  let motDePasse = false;
  let doubleFacteur = false;
  const parcourir = (alias: string) => {
    if (vus.has(alias)) return;
    vus.add(alias);
    for (const e of flux.get(alias) ?? []) {
      if (typeof e["flowAlias"] === "string") {
        if (!flux.has(e["flowAlias"])) echec(`sous-flux « ${e["flowAlias"]} » absent des flux déclarés`);
        else if (e["requirement"] === "DISABLED") continue;
        else parcourir(e["flowAlias"]);
        continue;
      }
      const a = String(e["authenticator"]);
      if (e["requirement"] === "DISABLED") continue;
      if (!PERMIS.has(a)) echec(`authentificateur « ${a} » interdit dans le flux de l'équipe`);
    }
  };
  parcourir(racine);
  // Le formulaire (mot de passe) et le sous-flux de double facteur sont REQUIRED ; les facteurs y sont des alternatives entre eux.
  for (const alias of vus) {
    const executions = flux.get(alias) ?? [];
    const mdp = executions.find((e) => e["authenticator"] === "auth-username-password-form");
    if (mdp) {
      motDePasse = mdp["requirement"] === "REQUIRED";
      if (!motDePasse) echec(`mot de passe « ${alias} » : doit être REQUIRED`);
      const sous = executions.filter((e) => typeof e["flowAlias"] === "string");
      const ok = sous.some((e) => e["requirement"] === "REQUIRED" && (flux.get(String(e["flowAlias"])) ?? []).some((x) => FACTEURS.has(String(x["authenticator"])) && x["requirement"] !== "DISABLED"));
      if (ok) doubleFacteur = true;
    }
  }
  if (!motDePasse || !doubleFacteur) echec("double facteur : sous-flux REQUIRED avec une clé d'accès ou un TOTP actif obligatoire après le mot de passe");
  const actions = liste(r["requiredActions"]);
  const configure = ["CONFIGURE_TOTP", "webauthn-register"].some((a) => actions.some((x) => x["alias"] === a && x["enabled"] === true && x["defaultAction"] === true));
  if (!configure) echec("action requise : la configuration du double facteur doit être activée par défaut à la première connexion");
}

export function verifierRoyaume(nom: string, texte: string): string[] {
  let r: unknown;
  try {
    r = JSON.parse(texte);
  } catch {
    return [`${nom}: JSON illisible`];
  }
  if (!estObjet(r)) return [`${nom}: un royaume est un objet JSON`];
  const erreurs: string[] = [];
  const echec = (m: string) => erreurs.push(`${nom}: ${m}`);
  verifierDurees(r, echec);
  verifierForceBrute(r, echec);
  verifierClients(r, echec);
  if (liste(r["identityProviders"]).length > 0) echec("identityProviders : aucun courtier d'identité (hors du flux de connexion contrôlé)");
  if (liste(r["users"]).length > 0) echec("users : aucun utilisateur ni identifiant dans un fichier de royaume");
  if (r["realm"] === "equipe") {
    if (r["registrationAllowed"] !== false) echec("registrationAllowed doit être false dans le royaume de l'équipe");
    verifierDoubleFacteur(r, echec);
  }
  return erreurs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dossier = new URL("../ops/socle/keycloak/", import.meta.url);
  const erreurs = ["royaume-equipe.json", "royaume-clients.json"].flatMap((n) => verifierRoyaume(n, readFileSync(new URL(n, dossier), "utf8")));
  if (erreurs.length) {
    console.error(erreurs.join("\n"));
    process.exit(1);
  }
}
