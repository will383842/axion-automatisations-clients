import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { createRemoteJWKSet, decodeJwt } from "jose";
import Fastify from "fastify";
import { beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { exigerReauthentification } from "./exiger-reauthentification.ts";
import { creerVerificateur, exigerJeton } from "./oidc.ts";

// Tests contre le vrai Keycloak du socle lancé par ops/socle/lancer.sh (job socle-integration).
// Le réseau « interne » n'ouvre aucun port : on joint l'adresse du conteneur (docker inspect). Données d'essai générées, jamais écrites.
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = () => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", "label=com.docker.compose.service=keycloak");
const modele = '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}';
const BASE = process.env["SOCLE_KEYCLOAK"] ?? `http://${docker("inspect", "-f", modele, conteneur())}:8080`;
const environnement = new Map(
  (JSON.parse(docker("inspect", "-f", "{{json .Config.Env}}", conteneur())) as string[]).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
);
const lireEnv = (nom: string) => environnement.get(nom) ?? "";
const REDIRECTION = "https://console.socle.test/auth/retour";
const OIDC = (royaume: string) => `${BASE}/realms/${royaume}/protocol/openid-connect`;
const essai = JSON.parse(readFileSync(new URL("../../../../ops/socle/keycloak/essai/royaume-equipe-essai.json", import.meta.url), "utf8")) as { clients: { clientId: string }[] };

type Json = Record<string, unknown>;
const formulaire = (champs: Record<string, string>) => new URLSearchParams(champs);

async function jetonAdmin(): Promise<string> {
  const r = await fetch(`${OIDC("master")}/token`, {
    method: "POST",
    body: formulaire({ grant_type: "password", client_id: "admin-cli", username: lireEnv("KC_BOOTSTRAP_ADMIN_USERNAME"), password: lireEnv("KC_BOOTSTRAP_ADMIN_PASSWORD") }),
  });
  return ((await r.json()) as { access_token: string }).access_token;
}
let admin = "";
const api = (chemin: string, init: RequestInit & { json?: unknown } = {}) =>
  fetch(`${BASE}/admin/realms${chemin}`, {
    ...init,
    headers: { authorization: `Bearer ${admin}`, ...(init.json === undefined ? {} : { "content-type": "application/json" }) },
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  });

// TOTP (RFC 6238, SHA-1, 6 chiffres, 30 s) : Keycloak lit le secret comme les octets de la chaîne enregistrée.
const code = (secret: string, pas: number) => {
  const compteur = Buffer.alloc(8);
  compteur.writeBigUInt64BE(BigInt(pas));
  const h = createHmac("sha1", Buffer.from(secret)).update(compteur).digest();
  const o = (h[19] ?? 0) & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
};
const pasCourant = () => Math.floor(Date.now() / 30_000);

interface Utilisateur {
  nom: string;
  motDePasse: string;
  secret: string;
  dernierPas: number;
  id: string;
}
// Un code TOTP ne sert qu'une fois : chaque connexion prend un pas strictement plus grand que le précédent (Keycloak accepte un pas d'avance).
const prochainCode = (u: Utilisateur) => {
  u.dernierPas = Math.max(pasCourant(), u.dernierPas + 1);
  return code(u.secret, u.dernierPas);
};

async function creerUtilisateur(royaume = "equipe"): Promise<Utilisateur> {
  const nom = `essai.${randomBytes(4).toString("hex")}@exemple.fr`;
  const u: Utilisateur = { nom, motDePasse: randomBytes(12).toString("hex"), secret: randomBytes(10).toString("hex"), dernierPas: 0, id: "" };
  const r = await api(`/${royaume}/users`, {
    method: "POST",
    json: {
      username: nom, email: nom, firstName: "Essai", lastName: "Equipe", enabled: true, emailVerified: true,
      credentials: [
        { type: "password", value: u.motDePasse, temporary: false },
        { type: "otp", secretData: JSON.stringify({ value: u.secret }), credentialData: JSON.stringify({ subType: "totp", digits: 6, period: 30, algorithm: "HmacSHA1", counter: 0 }) },
      ],
    },
  });
  expect(r.status).toBe(201);
  u.id = (r.headers.get("location") ?? "").split("/").at(-1) ?? "";
  // Les actions requises par défaut (configuration du double facteur) ne servent pas ici : l'utilisateur a déjà son TOTP.
  expect((await api(`/${royaume}/users/${u.id}`, { method: "PUT", json: { requiredActions: [] } })).status).toBe(204);
  return u;
}

// Navigation sans navigateur : un pot de cookies, des redirections lues à la main, les formulaires de Keycloak lus dans le HTML.
class Navigateur {
  private cookies = new Map<string, string>();
  async requete(url: string, init: RequestInit = {}): Promise<Response> {
    const entetes = new Headers(init.headers);
    if (this.cookies.size) entetes.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const r = await fetch(url, { ...init, headers: entetes, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [paire = ""] = c.split(";");
      const i = paire.indexOf("=");
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c)) this.cookies.delete(paire.slice(0, i));
      else this.cookies.set(paire.slice(0, i), paire.slice(i + 1));
    }
    return r;
  }
}
const action = (html: string) => (/<form[^>]*\saction="([^"]+)"/.exec(html)?.[1] ?? "").replaceAll("&amp;", "&");
const pageConnexion = (html: string) => html.includes("kc-form-login");
const pageOtp = (html: string) => html.includes('name="otp"');

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function demander(n: Navigateur, extra: Record<string, string> = {}) {
  const p = pkce();
  const q = formulaire({ client_id: "console", response_type: "code", scope: "openid", redirect_uri: REDIRECTION, state: "s", code_challenge: p.challenge, code_challenge_method: "S256", ...extra });
  return { r: await n.requete(`${OIDC("equipe")}/auth?${q}`), verifier: p.verifier };
}
const codeDe = (r: Response) => new URL(r.headers.get("location") ?? "http://sans.redirection.test").searchParams.get("code");

async function echanger(codeAutorisation: string, verifier: string): Promise<Json> {
  const r = await fetch(`${OIDC("equipe")}/token`, {
    method: "POST",
    body: formulaire({ grant_type: "authorization_code", client_id: "console", client_secret: lireEnv("KC_SECRET_CONSOLE"), code: codeAutorisation, redirect_uri: REDIRECTION, code_verifier: verifier }),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as Json;
}

// Mot de passe puis double facteur dans le vrai flux de navigateur ; renvoie les jetons.
async function connecter(n: Navigateur, u: Utilisateur, extra: Record<string, string> = {}): Promise<Json> {
  const { r, verifier } = await demander(n, extra);
  const pageMdp = await r.text();
  expect(pageConnexion(pageMdp), "formulaire de connexion attendu").toBe(true);
  const rMdp = await n.requete(action(pageMdp), { method: "POST", body: formulaire({ username: u.nom, password: u.motDePasse }) });
  const pageDeuxieme = await rMdp.text();
  expect(pageOtp(pageDeuxieme), "le mot de passe seul mène au formulaire TOTP").toBe(true);
  const rOtp = await n.requete(action(pageDeuxieme), { method: "POST", body: formulaire({ otp: prochainCode(u) }) });
  const c = codeDe(rOtp);
  expect(c, "code d'autorisation attendu après le TOTP").toBeTruthy();
  return echanger(c ?? "", verifier);
}

// Le rapport JSON de la CI ne montre pas le détail d'un échec : on l'écrit sur la sortie d'erreur du processus.
beforeEach(({ task }) => {
  onTestFailed(() => writeSync(2, `ECHEC ${task.name}\n${(task.result?.errors ?? []).map((e: { message?: string }) => e.message).join("\n")}\n`));
});

beforeAll(async () => {
  admin = await jetonAdmin();
  // Surcouche d'essai : le client d'octroi direct n'existe que dans cette base jetable, par import partiel.
  const importe = await api("/equipe/partialImport", { method: "POST", json: { ifResourceExists: "OVERWRITE", ...essai } });
  expect(importe.status).toBe(200);
  // Les adresses de retour dépendent de l'environnement : elles ne sont pas dans le fichier de royaume.
  const [console_] = (await (await api("/equipe/clients?clientId=console")).json()) as Json[];
  expect((await api(`/equipe/clients/${console_?.["id"]}`, { method: "PUT", json: { ...console_, redirectUris: [REDIRECTION] } })).status).toBe(204);
}, 120_000);

describe("Keycloak réel : royaumes et réglages", { timeout: 60_000 }, () => {
  it("[A-062] les royaumes equipe et clients sont importés et leur découverte OIDC répond", async () => {
    for (const nom of ["equipe", "clients"]) {
      const r = await fetch(`${BASE}/realms/${nom}/.well-known/openid-configuration`);
      expect(r.status, nom).toBe(200);
      expect(((await r.json()) as { issuer: string }).issuer.endsWith(`/realms/${nom}`)).toBe(true);
    }
  });

  it("[C-001] la session de l'équipe dure 8 h au plus (réglage relu par l'API d'administration)", async () => {
    const r = (await (await api("/equipe")).json()) as Json;
    expect(r["ssoSessionMaxLifespan"]).toBe(28_800);
    expect(r["accessTokenLifespan"]).toBe(300);
  });

  it("[LOT1-kc] [KC_SECRET_*] les secrets des clients viennent de l'environnement, pas du texte du fichier", async () => {
    for (const [royaume, client, variable] of [["equipe", "console", "KC_SECRET_CONSOLE"], ["clients", "portail", "KC_SECRET_PORTAIL"]] as const) {
      const [c] = (await (await api(`/${royaume}/clients?clientId=${client}`)).json()) as { id: string }[];
      const secret = ((await (await api(`/${royaume}/clients/${c?.id}/client-secret`)).json()) as { value: string }).value;
      expect(lireEnv(variable).length, variable).toBeGreaterThan(20);
      expect(secret, variable).toBe(lireEnv(variable));
      expect(secret).not.toContain("${");
    }
  });

  it("[LOT1-kc] l'octroi direct est refusé au client réel de la console, même avec son secret", async () => {
    const r = await fetch(`${OIDC("equipe")}/token`, {
      method: "POST",
      body: formulaire({ grant_type: "password", client_id: "console", client_secret: lireEnv("KC_SECRET_CONSOLE"), username: "x@exemple.fr", password: "x" }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("unauthorized_client");
  });
});

describe("Keycloak réel : double facteur et sessions", { timeout: 60_000 }, () => {
  const direct = (u: Utilisateur, extra: Record<string, string> = {}) =>
    fetch(`${OIDC("equipe")}/token`, { method: "POST", body: formulaire({ grant_type: "password", client_id: "essai-direct", username: u.nom, password: u.motDePasse, ...extra }) });

  it("[C-002] mot de passe seul → aucun jeton ; mot de passe + TOTP → jeton (client d'essai)", async () => {
    const u = await creerUtilisateur();
    const seul = await direct(u);
    expect(seul.status).toBeGreaterThanOrEqual(400);
    expect(((await seul.json()) as Json)["access_token"]).toBeUndefined();
    const faux = await direct(u, { totp: "000000" });
    expect(((await faux.json()) as Json)["access_token"]).toBeUndefined();
    const complet = await direct(u, { totp: prochainCode(u) });
    expect(complet.status).toBe(200);
    expect(((await complet.json()) as Json)["access_token"]).toBeTypeOf("string");
  });

  it("[C-002] navigateur : le mot de passe seul ne donne aucun code d'autorisation", async () => {
    const u = await creerUtilisateur();
    const n = new Navigateur();
    const { r } = await demander(n);
    const page = await r.text();
    const rMdp = await n.requete(action(page), { method: "POST", body: formulaire({ username: u.nom, password: u.motDePasse }) });
    expect(codeDe(rMdp)).toBeNull();
    const suite = await rMdp.text();
    expect(pageOtp(suite)).toBe(true);
    const rFaux = await n.requete(action(suite), { method: "POST", body: formulaire({ otp: "000000" }) });
    expect(codeDe(rFaux)).toBeNull();
  });

  it("[C-003] le jeton de la connexion réelle porte acr « mfa » et passe la garde de réauthentification de l'API", async () => {
    const u = await creerUtilisateur();
    const jetons = await connecter(new Navigateur(), u);
    const jeton = String(jetons["access_token"]);
    const claims = decodeJwt(jeton);
    expect(claims["acr"]).toBe("mfa");
    expect(claims["auth_time"]).toBeTypeOf("number");
    const verificateur = creerVerificateur({
      emetteur: String(claims.iss),
      audience: "api-equipe",
      cles: createRemoteJWKSet(new URL(`${OIDC("equipe")}/certs`)),
    });
    const app = Fastify();
    app.get("/sensible", { preHandler: [exigerJeton(verificateur), exigerReauthentification()] }, async () => ({ ok: true }));
    const bonne = await app.inject({ method: "GET", url: "/sensible", headers: { authorization: `Bearer ${jeton}` } });
    expect(bonne.statusCode).toBe(200);
    // Une connexion trop ancienne est refusée avec le même jeton : l'horloge de l'API avance de 10 minutes.
    const tardive = Fastify();
    tardive.get("/sensible", { preHandler: [exigerJeton(verificateur), exigerReauthentification(() => Date.now() + 600_000)] }, async () => ({ ok: true }));
    const vieille = await tardive.inject({ method: "GET", url: "/sensible", headers: { authorization: `Bearer ${jeton}` } });
    expect(vieille.statusCode).toBe(401);
    expect(vieille.json().erreur.code).toBe("reauthentification_requise");
  });

  it("[C-003] max_age=0 oblige à saisir de nouveau mot de passe et TOTP, et renouvelle auth_time", async () => {
    const u = await creerUtilisateur();
    const n = new Navigateur();
    const premiers = await connecter(n, u);
    const avant = decodeJwt(String(premiers["access_token"])).auth_time as number;
    // Sans max_age, la session existante suffit : code immédiat, aucune saisie.
    const sso = await demander(n);
    expect(codeDe(sso.r)).toBeTruthy();
    await new Promise((ok) => setTimeout(ok, 1500));
    // Avec max_age=0, Keycloak ignore la session et redemande le formulaire.
    const seconds = await connecter(n, u, { max_age: "0" });
    const apres = decodeJwt(String(seconds["access_token"])).auth_time as number;
    expect(apres).toBeGreaterThan(avant);
    expect(decodeJwt(String(seconds["access_token"]))["acr"]).toBe("mfa");
  });

  it("[C-001] après une déconnexion forcée par l'administration, le jeton de rafraîchissement est refusé", async () => {
    const u = await creerUtilisateur();
    const jetons = await connecter(new Navigateur(), u);
    const rafraichir = () =>
      fetch(`${OIDC("equipe")}/token`, {
        method: "POST",
        body: formulaire({ grant_type: "refresh_token", client_id: "console", client_secret: lireEnv("KC_SECRET_CONSOLE"), refresh_token: String(jetons["refresh_token"]) }),
      });
    expect((await api(`/equipe/users/${u.id}/logout`, { method: "POST" })).status).toBe(204);
    const r = await rafraichir();
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_grant");
  });
});
