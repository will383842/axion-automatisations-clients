import { execFileSync } from "node:child_process";
import { createPublicKey, createVerify, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { journalEchecs } from "../provisionnement/journal-echecs.ts";

// Essais réels contre le Keycloak du socle (job socle-integration de la CI ; aucun Docker dans la routine qui a écrit ce fichier :
// aucun résultat n'est annoncé ici). Modèle : apps/api/src/auth/keycloak.int.test.ts. Données générées, aucun mot de passe écrit.
journalEchecs(import.meta.url);

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const conteneur = () => docker("ps", "-q", "--filter", "label=com.docker.compose.project=socle", "--filter", "label=com.docker.compose.service=keycloak");
const modele = '{{(index .NetworkSettings.Networks "socle_interne").IPAddress}}';
const BASE = process.env["SOCLE_KEYCLOAK"] ?? `http://${docker("inspect", "-f", modele, conteneur())}:8080`;
const environnement = new Map(
  (JSON.parse(docker("inspect", "-f", "{{json .Config.Env}}", conteneur())) as string[]).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
);
const lireEnv = (nom: string) => environnement.get(nom) ?? "";
const OIDC = (royaume: string) => `${BASE}/realms/${royaume}/protocol/openid-connect`;
const ORIGINE_PORTAIL = lireEnv("KC_ORIGINE_PORTAIL");
const RAPPEL = `${ORIGINE_PORTAIL}/api/auth/rappel`;
const essai = JSON.parse(readFileSync(new URL("../../../../ops/socle/keycloak/essai/royaume-clients-essai.json", import.meta.url), "utf8")) as object;

type Json = Record<string, unknown>;
const formulaire = (champs: Record<string, string>) => new URLSearchParams(champs);

let admin = "";
async function jetonAdmin(): Promise<string> {
  const r = await fetch(`${OIDC("master")}/token`, {
    method: "POST",
    body: formulaire({ grant_type: "password", client_id: "admin-cli", username: lireEnv("KC_BOOTSTRAP_ADMIN_USERNAME"), password: lireEnv("KC_BOOTSTRAP_ADMIN_PASSWORD") }),
  });
  return ((await r.json()) as { access_token: string }).access_token;
}
const api = (chemin: string, init: RequestInit & { json?: unknown } = {}) =>
  fetch(`${BASE}/admin/realms${chemin}`, {
    ...init,
    headers: { authorization: `Bearer ${admin}`, ...(init.json === undefined ? {} : { "content-type": "application/json" }) },
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  });
const idDe = (r: Response) => (r.headers.get("location") ?? "").split("/").at(-1) ?? "";

interface Compte { nom: string; motDePasse: string; id: string }
async function creerCompte(royaume: string): Promise<Compte> {
  const nom = `essai.${randomBytes(4).toString("hex")}@exemple.fr`;
  const c: Compte = { nom, motDePasse: randomBytes(12).toString("hex"), id: "" };
  const r = await api(`/${royaume}/users`, {
    method: "POST",
    json: { username: nom, email: nom, firstName: "Essai", lastName: "Compte", enabled: true, emailVerified: true, requiredActions: [], credentials: [{ type: "password", value: c.motDePasse, temporary: false }] },
  });
  expect(r.status).toBe(201);
  c.id = idDe(r);
  return c;
}

// Jeton par octroi direct du client d'essai (jamais ouvert au client portail réel).
const jetonEssai = (royaume: string, c: Compte) =>
  fetch(`${OIDC(royaume)}/token`, { method: "POST", body: formulaire({ grant_type: "password", client_id: "essai-direct", username: c.nom, password: c.motDePasse, scope: "openid" }) });

const partie = (jeton: string, i: 0 | 1) => JSON.parse(Buffer.from(jeton.split(".")[i] ?? "", "base64url").toString("utf8")) as Json;

beforeAll(async () => {
  admin = await jetonAdmin();
  // Surcouche d'essai : le client d'octroi direct n'existe que dans cette base jetable, par import partiel.
  expect((await api("/clients/partialImport", { method: "POST", json: { ifResourceExists: "OVERWRITE", ...essai } })).status).toBe(200);
}, 120_000);

describe("Keycloak réel : royaume des clients", { timeout: 60_000 }, () => {
  it("[LOT6-connexion] Keycloak émet roles_portail et organisations signés pour un compte d'essai", async () => {
    const organisation = randomUUID();
    const [parent] = (await (await api("/clients/groups?search=organisations&exact=true")).json()) as { id: string }[];
    expect(parent?.id, "groupe parent « organisations » du royaume").toBeTruthy();
    const g = await api(`/clients/groups/${parent?.id}/children`, { method: "POST", json: { name: organisation } });
    expect(g.status).toBe(201);
    const compte = await creerCompte("clients");
    expect((await api(`/clients/users/${compte.id}/groups/${idDe(g)}`, { method: "PUT" })).status).toBe(204);
    const [portail] = (await (await api("/clients/clients?clientId=portail")).json()) as { id: string }[];
    const role = (await (await api(`/clients/clients/${portail?.id}/roles/comptable`)).json()) as { id: string; name: string };
    expect((await api(`/clients/users/${compte.id}/role-mappings/clients/${portail?.id}`, { method: "POST", json: [role] })).status).toBe(204);

    const r = await jetonEssai("clients", compte);
    expect(r.status, await r.clone().text()).toBe(200);
    const jetons = (await r.json()) as { access_token: string; id_token: string };
    for (const jeton of [jetons.access_token, jetons.id_token]) {
      const charge = partie(jeton, 1);
      expect(charge["roles_portail"], "revendication roles_portail").toEqual(["comptable"]);
      expect(charge["organisations"], "revendication organisations").toEqual([`/organisations/${organisation}`]);
      // Signature RS256 vérifiée avec la clé publiée par le royaume : la charge n'est pas modifiable.
      const entete = partie(jeton, 0);
      const cles = ((await (await fetch(`${OIDC("clients")}/certs`)).json()) as { keys: (Json & { kid: string })[] }).keys;
      const cle = cles.find((k) => k.kid === entete["kid"]);
      expect(cle, "clé de signature du royaume").toBeDefined();
      const [e, c, s] = jeton.split(".");
      const v = createVerify("sha256").update(`${e}.${c}`);
      expect(v.verify(createPublicKey({ key: cle as never, format: "jwk" }), Buffer.from(s ?? "", "base64url"))).toBe(true);
    }
    expect(partie(jetons.access_token, 1)["aud"]).toContain("api-clients");
  });

  it("[LOT6-connexion] un compte du royaume de l'équipe n'obtient aucun jeton du royaume clients", async () => {
    const membre = await creerCompte("equipe");
    // Mêmes identifiants, mauvais royaume : le compte n'existe pas dans « clients ».
    const r = await jetonEssai("clients", membre);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(((await r.json()) as Json)["access_token"]).toBeUndefined();
    const reel = await fetch(`${OIDC("clients")}/token`, {
      method: "POST",
      body: formulaire({ grant_type: "password", client_id: "portail", client_secret: lireEnv("KC_SECRET_PORTAIL"), username: membre.nom, password: membre.motDePasse }),
    });
    expect(((await reel.json()) as Json)["access_token"]).toBeUndefined();
  });

  it("[LOT6-connexion] redirect_uri étrangère refusée par Keycloak au point d'autorisation du client portail", async () => {
    const demande = (redirection: string) =>
      fetch(`${OIDC("clients")}/auth?${formulaire({ client_id: "portail", response_type: "code", scope: "openid", redirect_uri: redirection, state: "s", code_challenge: "C".repeat(43), code_challenge_method: "S256" })}`, { redirect: "manual" });
    expect(ORIGINE_PORTAIL, "KC_ORIGINE_PORTAIL dans l'environnement de Keycloak").toMatch(/^https:\/\//);
    const bonne = await demande(RAPPEL);
    expect(bonne.status, "l'adresse de rappel du portail est acceptée").toBe(200);
    expect(await bonne.text()).toContain("kc-form-login");
    for (const etrangere of ["https://etranger.test/api/auth/rappel", `${ORIGINE_PORTAIL}.etranger.test/api/auth/rappel`, `${ORIGINE_PORTAIL}/autre`]) {
      const r = await demande(etrangere);
      expect(r.status, etrangere).toBe(400);
      expect(await r.text()).not.toContain("kc-form-login");
      expect(r.headers.get("location")).toBeNull();
    }
  });

  it("[LOT6-connexion] octroi direct refusé au client portail réel, même avec son secret", async () => {
    const compte = await creerCompte("clients");
    const r = await fetch(`${OIDC("clients")}/token`, {
      method: "POST",
      body: formulaire({ grant_type: "password", client_id: "portail", client_secret: lireEnv("KC_SECRET_PORTAIL"), username: compte.nom, password: compte.motDePasse }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("unauthorized_client");
  });
});
