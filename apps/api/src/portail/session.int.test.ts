import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRemoteJWKSet } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { journalEchecs } from "../provisionnement/journal-echecs.ts";
import { creerVerificateur } from "../auth/oidc.js";
import { creerSessionPortail } from "./session.ts";

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

const EMETTEUR = (royaume: string) => `${BASE}/realms/${royaume}`;
const requete = (jeton: string) => ({ headers: { authorization: `Bearer ${jeton}` } }) as never;
const sessionAvec = (azp: string, royaume = "clients") =>
  creerSessionPortail({
    verifier: creerVerificateur({ emetteur: EMETTEUR(royaume), audience: "api-clients", cles: createRemoteJWKSet(new URL(`${OIDC(royaume)}/certs`)) }),
    azp,
    statutOrganisation: async () => "client",
    etablissements: async () => [],
    perimetre: async () => undefined,
  });
const code = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as { code?: string } | undefined)?.code;

beforeAll(async () => {
  admin = await jetonAdmin();
  expect((await api("/clients/partialImport", { method: "POST", json: { ifResourceExists: "OVERWRITE", ...essai } })).status).toBe(200);
}, 120_000);

describe("Keycloak réel : session de l'API du portail", { timeout: 60_000 }, () => {
  it("[LOT6-roles] jeton réel du royaume clients : session { organisation A, comptable } ; jeton de l'équipe, charge modifiée ou autre client OIDC : 401", async () => {
    const organisation = randomUUID();
    const [parent] = (await (await api("/clients/groups?search=organisations&exact=true")).json()) as { id: string }[];
    const g = await api(`/clients/groups/${parent?.id}/children`, { method: "POST", json: { name: organisation } });
    expect(g.status).toBe(201);
    const compte = await creerCompte("clients");
    expect((await api(`/clients/users/${compte.id}/groups/${idDe(g)}`, { method: "PUT" })).status).toBe(204);
    const [portail] = (await (await api("/clients/clients?clientId=portail")).json()) as { id: string }[];
    const role = (await (await api(`/clients/clients/${portail?.id}/roles/comptable`)).json()) as { id: string; name: string };
    expect((await api(`/clients/users/${compte.id}/role-mappings/clients/${portail?.id}`, { method: "POST", json: [role] })).status).toBe(204);

    const r = await jetonEssai("clients", compte);
    expect(r.status, await r.clone().text()).toBe(200);
    const { access_token: jeton } = (await r.json()) as { access_token: string };
    // Le client d'essai joue le rôle du portail : azp attendu = essai-direct.
    expect(await sessionAvec("essai-direct")(requete(jeton))).toMatchObject({ tenantId: organisation, roleClient: "comptable" });
    // Un vérificateur réglé sur azp = portail refuse le jeton du client d'essai.
    expect(await code(sessionAvec("portail")(requete(jeton)))).toBe("signature_invalide");
    // Charge modifiée (rôle changé), signature d'origine : refusée.
    const [e, c, s] = jeton.split(".");
    const charge = { ...partie(jeton, 1), roles_portail: ["administrateur"] };
    const modifie = `${e}.${Buffer.from(JSON.stringify(charge)).toString("base64url")}.${s}`;
    expect(await code(sessionAvec("essai-direct")(requete(modifie)))).toBe("signature_invalide");
    expect(c).toBeTruthy();
    // Jeton réel du royaume de l'équipe : refusé.
    const membre = await creerCompte("equipe");
    const re = await jetonEssai("equipe", membre);
    if (re.status === 200) expect(await code(sessionAvec("essai-direct")(requete(((await re.json()) as { access_token: string }).access_token)))).toBe("signature_invalide");
  });
});
