import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Garde des fichiers de royaume Keycloak réels (A-062, C-001, C-002). JSON lu par l'analyseur JSON, rien n'est exécuté.
// La surcouche d'essai (ops/socle/keycloak/essai/) n'est jamais lue ici : un client d'essai dans un fichier réel est refusé.

const SESSION_MAX = 8 * 3600;
const JETON_MAX = 300;
const FACTEUR_ECHECS_MAX = 5;
// Keycloak ne substitue que la forme sans préfixe : « ${env.NOM} » resterait un secret littéral (constaté contre le vrai Keycloak).
const SECRET_ENV = /^\$\{[A-Z][A-Z0-9_]*\}$/;
// Seuls authentificateurs permis dans le flux de navigateur de l'équipe : tout autre (SMS, fournisseur d'identité, clé d'accès seule…) est refusé.
// La condition de niveau d'authentification enveloppe le double facteur (montage de Keycloak 26) : toujours vraie tant que le niveau 2 n'est pas atteint.
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
    if (c["secret"] !== undefined && !(typeof c["secret"] === "string" && SECRET_ENV.test(c["secret"]))) echec(`client « ${id} » : secret en clair (utiliser \${NOM})`);
  }
}

// Double facteur sous condition : la SEULE condition est le niveau d'authentification ≥ 2, puis le double facteur en REQUIRED ;
// tout client de l'équipe exige alors l'acr « mfa » (sinon un niveau déjà atteint dans la session sauterait le double facteur).
function niveauSeul(r: Objet, flux: Map<string, Objet[]>, contenu: Objet[], echec: (m: string) => void): boolean {
  const actifs = contenu.filter((x) => x["requirement"] !== "DISABLED");
  const conditions = actifs.filter((x) => String(x["authenticator"]).startsWith("conditional-"));
  const [condition] = conditions;
  if (conditions.length !== 1 || condition?.["authenticator"] !== "conditional-level-of-authentication" || condition["requirement"] !== "REQUIRED") return false;
  const config = liste(r["authenticatorConfig"]).find((c) => c["alias"] === condition["authenticatorConfig"]);
  const niveau = estObjet(config?.["config"]) ? Number(config["config"]["loa-condition-level"]) : NaN;
  if (!(niveau >= 2)) return false;
  const facteurs = actifs.filter((x) => typeof x["flowAlias"] === "string");
  const ok = facteurs.some((x) => x["requirement"] === "REQUIRED" && (flux.get(String(x["flowAlias"])) ?? []).some((y) => FACTEURS.has(String(y["authenticator"])) && y["requirement"] !== "DISABLED"));
  if (!ok) return false;
  for (const c of liste(r["clients"])) {
    const a = c["attributes"];
    if (!estObjet(a) || a["minimum.acr.value"] !== "mfa") echec(`client « ${String(c["clientId"])} » : minimum.acr.value doit valoir mfa (double facteur sous condition de niveau)`);
  }
  return true;
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
      const aFacteur = (xs: Objet[]) => xs.some((x) => FACTEURS.has(String(x["authenticator"])) && x["requirement"] !== "DISABLED");
      const ok = sous.some((e) => {
        const contenu = flux.get(String(e["flowAlias"])) ?? [];
        if (e["requirement"] === "REQUIRED") return aFacteur(contenu);
        return e["requirement"] === "CONDITIONAL" && niveauSeul(r, flux, contenu, echec);
      });
      if (ok) doubleFacteur = true;
    }
  }
  if (!motDePasse || !doubleFacteur) echec("double facteur : sous-flux REQUIRED (ou sous la seule condition de niveau ≥ 2) avec une clé d'accès ou un TOTP actif obligatoire après le mot de passe");
  const actions = liste(r["requiredActions"]);
  const configure = ["CONFIGURE_TOTP", "webauthn-register"].some((a) => actions.some((x) => x["alias"] === a && x["enabled"] === true && x["defaultAction"] === true));
  if (!configure) echec("action requise : la configuration du double facteur doit être activée par défaut à la première connexion");
}

// Compte de service de l'API (A1, ADR 0129) : seule entrée « users » permise, royaume equipe seulement, aux deux seuls rôles de gestion des utilisateurs.
// Aucun identifiant, mot de passe, rôle de royaume ni rôle d'administration (realm-admin, manage-realm, impersonation, view-clients, manage-clients…).
const CLES_COMPTE = new Set(["username", "enabled", "serviceAccountClientId", "clientRoles"]);
const ROLES_COMPTE = new Set(["view-users", "manage-users"]);

function verifierComptesDeService(r: Objet, echec: (m: string) => void): void {
  const equipe = r["realm"] === "equipe";
  const clients = liste(r["clients"]);
  const comptes = liste(r["users"]);
  if (Array.isArray(r["users"]) && comptes.length !== r["users"].length) echec("users : entrée illisible");
  for (const c of clients.filter((x) => x["serviceAccountsEnabled"] === true)) {
    const id = String(c["clientId"]);
    if (!equipe) echec(`client « ${id} » : aucun compte de service dans ce royaume`);
    if (c["standardFlowEnabled"] === true) echec(`client « ${id} » : un compte de service n'a pas de standardFlowEnabled`);
    if (!comptes.some((u) => u["serviceAccountClientId"] === id)) echec(`client « ${id} » : serviceAccountsEnabled sans entrée users du compte de service`);
  }
  for (const u of comptes) {
    const cible = u["serviceAccountClientId"];
    if (typeof cible !== "string") {
      echec("users : seule une entrée avec serviceAccountClientId (compte de service) est permise, jamais un utilisateur");
      continue;
    }
    if (!equipe) echec("users : aucun compte de service dans ce royaume");
    for (const cle of Object.keys(u)) if (!CLES_COMPTE.has(cle)) echec(`users « ${cle} » interdit dans un compte de service (clés permises : ${[...CLES_COMPTE].join(", ")})`);
    if (u["username"] !== `service-account-${cible}`) echec(`compte de service « ${cible} » : username attendu service-account-${cible}`);
    if (!clients.some((c) => c["clientId"] === cible && c["serviceAccountsEnabled"] === true)) echec(`compte de service « ${cible} » : serviceAccountsEnabled doit être vrai sur un client du même fichier`);
    const roles = u["clientRoles"];
    if (!estObjet(roles) || Object.keys(roles).some((k) => k !== "realm-management")) echec(`compte de service « ${cible} » : clientRoles ne porte que realm-management`);
    else {
      const permis = roles["realm-management"];
      const rolesDuClient = Array.isArray(permis) ? permis : [];
      for (const role of rolesDuClient) if (typeof role !== "string" || !ROLES_COMPTE.has(role)) echec(`compte de service « ${cible} » : rôle « ${String(role)} » interdit (permis : ${[...ROLES_COMPTE].join(", ")})`);
    }
  }
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
  verifierComptesDeService(r, echec);
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
