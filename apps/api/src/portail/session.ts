import type { FastifyRequest } from "fastify";
import type { Verificateur } from "../auth/oidc.js";
import { ErreurApi } from "../plugins/erreurs.js";
import { ROLES_CLIENT, type RoleClient } from "./roles.ts";
import { calculerPerimetre, type PerimetreMembre } from "./perimetre.ts";

// Session de l'API du portail : tout vient du jeton SIGNÉ du royaume des clients (organisation et rôle) ; rien n'est lu dans un en-tête, un paramètre, le corps ou un cookie.
export interface SessionApiPortail { tenantId: string; role: "client"; roleClient: RoleClient; acteur: string; etablissements: string[]; automatisations: string[] | null }
export interface DepsSessionPortail {
  verifier: Verificateur; // émetteur du royaume clients, audience api-clients
  azp: string; // client OIDC attendu (« portail »)
  statutOrganisation(organisation: string): Promise<string | undefined>;
  etablissements(tenantId: string): Promise<string[]>;
  perimetre(tenantId: string, acteur: string): Promise<PerimetreMembre | undefined>;
}
const GROUPE = /^\/organisations\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const STATUT_ACTIF = "client";
const non401 = () => new ErreurApi("signature_invalide", "Connexion requise.");
const non403 = () => new ErreurApi("action_interdite", "Action interdite.");

export function creerSessionPortail(d: DepsSessionPortail): (requete: FastifyRequest) => Promise<SessionApiPortail> {
  return async (requete) => {
    const jeton = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(requete.headers.authorization ?? "")?.[1];
    if (!jeton) throw non401();
    let c;
    try { c = await d.verifier(jeton); } catch { throw non401(); }
    if (c["azp"] !== d.azp || typeof c.sub !== "string" || !c.sub) throw non401();
    const roles = c["roles_portail"];
    const roleClient = Array.isArray(roles) && roles.length === 1 ? ROLES_CLIENT.find((r) => r === roles[0]) : undefined;
    const groupes = c["organisations"];
    const tenantId = Array.isArray(groupes) && groupes.length === 1 && typeof groupes[0] === "string" ? GROUPE.exec(groupes[0])?.[1] : undefined;
    if (!roleClient || !tenantId) throw non403();
    if ((await d.statutOrganisation(tenantId)) !== STATUT_ACTIF) throw non403();
    const p = calculerPerimetre(roleClient, await d.etablissements(tenantId), roleClient === "utilisateur" ? await d.perimetre(tenantId, c.sub) : undefined);
    return { tenantId, role: "client", roleClient, acteur: c.sub, etablissements: p.etablissements, automatisations: p.automatisations };
  };
}
