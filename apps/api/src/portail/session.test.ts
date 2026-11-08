import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { creerSessionPortail, type DepsSessionPortail } from "./session.ts";
import { ErreurApi } from "../plugins/erreurs.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ETAB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const claims = (o: Record<string, unknown> = {}) => ({ sub: "u1", azp: "portail", roles_portail: ["comptable"], organisations: [`/organisations/${ORG_A}`], ...o });
const requete = (jeton?: string, entetes: Record<string, string> = {}) => ({ headers: { ...(jeton ? { authorization: `Bearer ${jeton}` } : {}), ...entetes } }) as unknown as FastifyRequest;
function deps(c: Record<string, unknown> | Error, statut = "client", perimetre?: DepsSessionPortail["perimetre"]): DepsSessionPortail {
  return {
    verifier: async () => { if (c instanceof Error) throw c; return c as never; },
    azp: "portail",
    statutOrganisation: async (id) => (id === ORG_A || id === ORG_B ? statut : undefined),
    etablissements: async (t) => (t === ORG_A ? [ETAB_A] : []),
    perimetre: perimetre ?? (async () => undefined),
  };
}
const code = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as ErreurApi | undefined)?.code;

describe("session du portail", () => {
  it("[B-128] jeton d'accès du royaume de l'équipe : 401", async () => {
    expect(await code(creerSessionPortail(deps(new Error("iss")))(requete("x")))).toBe("signature_invalide");
    expect(await code(creerSessionPortail(deps(claims()))(requete()))).toBe("signature_invalide");
  });

  it("[LOT6-roles] jeton d'un autre client OIDC du royaume (azp différent de portail) : 401", async () => {
    expect(await code(creerSessionPortail(deps(claims({ azp: "autre" })))(requete("x")))).toBe("signature_invalide");
    expect(await code(creerSessionPortail(deps(claims({ azp: undefined })))(requete("x")))).toBe("signature_invalide");
  });

  it("[LOT6-roles] « dirigeant » ou un deuxième rôle ajouté au jeton : aucune route", async () => {
    expect(await code(creerSessionPortail(deps(claims({ roles_portail: ["dirigeant"] })))(requete("x")))).toBe("action_interdite");
    expect(await code(creerSessionPortail(deps(claims({ roles_portail: ["comptable", "administrateur"] })))(requete("x")))).toBe("action_interdite");
    expect(await code(creerSessionPortail(deps(claims({ organisations: [`/organisations/${ORG_A}`, `/organisations/${ORG_B}`] })))(requete("x")))).toBe("action_interdite");
  });

  it("[LOT6-roles] organisation au statut prospect, en_signature ou ancien_client : 403", async () => {
    for (const s of ["prospect", "en_signature", "ancien_client", "inconnu"]) expect(await code(creerSessionPortail(deps(claims(), s))(requete("x")))).toBe("action_interdite");
  });

  it("[LOT6-roles] utilisateur sans périmètre : aucune automatisation, établissements vides", async () => {
    const s = await creerSessionPortail(deps(claims({ roles_portail: ["utilisateur"] })))(requete("x"));
    expect(s.automatisations).toEqual([]);
    expect(s.etablissements).toEqual([]);
    const l = await creerSessionPortail(deps(claims({ roles_portail: ["utilisateur"] }), "client", async () => ({ automatisations: [AUTO], etablissements: [ETAB_A] })))(requete("x"));
    expect(l.automatisations).toEqual([AUTO]);
  });

  it("[LOT6-roles] administrateur : établissements = ceux de la base du client, jamais ceux d'un autre", async () => {
    const a = await creerSessionPortail(deps(claims({ roles_portail: ["administrateur"] })))(requete("x"));
    expect(a).toMatchObject({ tenantId: ORG_A, role: "client", roleClient: "administrateur", acteur: "u1", etablissements: [ETAB_A], automatisations: null });
    const b = await creerSessionPortail(deps(claims({ roles_portail: ["administrateur"], organisations: [`/organisations/${ORG_B}`] })))(requete("x"));
    expect(b.etablissements).toEqual([]);
  });

  it("[LOT6-roles] en-tête x-organisation, paramètre organisationId et corps tenantId de B ignorés : la session reste celle de A", async () => {
    const r = { ...requete("x", { "x-organisation": ORG_B }), query: { organisationId: ORG_B }, body: { tenantId: ORG_B } } as unknown as FastifyRequest;
    expect((await creerSessionPortail(deps(claims()))(r)).tenantId).toBe(ORG_A);
  });
});
