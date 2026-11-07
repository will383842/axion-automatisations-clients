import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifierRoyaume } from "../../../../scripts/garde-royaumes.ts";

const texte = readFileSync(new URL("../../../../ops/socle/keycloak/royaume-clients.json", import.meta.url), "utf8");
type Mappeur = { protocolMapper: string; config: Record<string, string> };
const royaume = JSON.parse(texte) as { clients: Array<{ clientId: string; redirectUris?: string[]; webOrigins?: string[]; attributes: Record<string, string>; protocolMappers: Mappeur[] }>; roles?: { client?: Record<string, Array<{ name: string }>> }; groups?: Array<{ name: string; subGroups?: unknown[] }>; users?: unknown };
const portail = royaume.clients.find((c) => c.clientId === "portail");

describe("royaume des clients", () => {
  it("[C-487] le royaume des clients déclare exactement les quatre rôles du client portail", () => {
    expect((royaume.roles?.client?.["portail"] ?? []).map((r) => r.name).sort()).toEqual(["administrateur", "comptable", "lecture_seule", "utilisateur"]);
  });

  it("[LOT6-connexion] client portail : redirectUris et post.logout sur KC_ORIGINE_PORTAIL, mappeurs roles_portail et organisations dans les deux jetons, aucun utilisateur, aucun sous-groupe d'organisation, verifierRoyaume vide", () => {
    expect(portail?.redirectUris).toEqual(["${KC_ORIGINE_PORTAIL}/api/auth/rappel"]);
    expect(portail?.webOrigins).toEqual([]);
    expect(portail?.attributes["post.logout.redirect.uris"]).toBe("${KC_ORIGINE_PORTAIL}/");
    const par = (claim: string) => portail?.protocolMappers.find((m) => m.config["claim.name"] === claim);
    const roles = par("roles_portail");
    const orgs = par("organisations");
    expect(roles?.protocolMapper).toBe("oidc-usermodel-client-role-mapper");
    expect(roles?.config["usermodel.clientRoleMapping.clientId"]).toBe("portail");
    expect(orgs?.protocolMapper).toBe("oidc-group-membership-mapper");
    expect(orgs?.config["full.path"]).toBe("true");
    for (const m of [roles, orgs]) expect([m?.config["access.token.claim"], m?.config["id.token.claim"]]).toEqual(["true", "true"]);
    expect(royaume.users).toBeUndefined();
    const parent = royaume.groups?.find((g) => g.name === "organisations");
    expect(parent).toBeDefined();
    expect(parent?.subGroups ?? []).toEqual([]);
    expect(verifierRoyaume("royaume-clients.json", texte)).toEqual([]);
  });
});
