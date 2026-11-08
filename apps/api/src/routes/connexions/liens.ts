import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { autorise } from "../../droits/matrice.js";
import { ErreurApi } from "../../plugins/erreurs.js";
import type { NouvelleConnexion } from "./depot.js";

// Créer un lien de connexion (T4-42b, B-092, A-390) : route de l'équipe, FERMÉE (non branchée dans serveur.ts, porte par outil).
// Le client actif et l'auteur viennent de la session, jamais du corps. La réponse ne porte que le lien : jamais un secret.
export interface SessionConnexions {
  acteur: string;
  role: string;
  clientActifId: string;
  reauthentifie: boolean;
}
export interface DepsLiensConnexions {
  exigerEquipe: preHandlerAsyncHookHandler;
  session(requete: FastifyRequest): Promise<SessionConnexions>;
  // Interrupteur de l'outil ouvert ET fiche de conformité signée (câblage : dette D1). Fermée par défaut.
  porte(outil: string): boolean;
  nouvelId(): string;
  creer(connexion: NouvelleConnexion): Promise<void>;
  ecrireCoffre(chemin: string, valeur: Readonly<Record<string, string>>): Promise<void>;
  emettreLien(c: { tenantId: string; connexionId: string; outil: string; locataireAttendu?: string; domaineAttendu?: string }): Promise<string>;
}

const CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const DOMAINE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const Params = z.strictObject({ id: z.uuid() });
const Corps = z
  .strictObject({
    organisation_id: z.uuid(),
    outil: z.enum(["microsoft-365", "gmail", "imap"]),
    connecteur: z.string().regex(CODE),
    portee: z.enum(["lecture", "ecriture", "lecture_ecriture"]),
    locataire_attendu: z.uuid().optional(),
    domaine_attendu: z.string().toLowerCase().regex(DOMAINE).optional(),
    application_google: z.strictObject({ client_id: z.string().min(1).max(256), client_secret: z.string().min(1).max(512) }).optional(),
    attestation_workspace: z.boolean().optional(),
  })
  .refine((c) => (c.outil === "microsoft-365") === (c.locataire_attendu !== undefined), { message: "locataire" })
  .refine((c) => c.outil === "gmail" || (c.domaine_attendu === undefined && c.application_google === undefined), { message: "google" });
const lire = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v);
  if (!r.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  return r.data;
};

// Droit sur les secrets (matrice), client actif de la session = client de l'URL, auteur identifié.
export function exigerDroitSecrets(s: SessionConnexions, tenantId: string): string {
  if (!autorise(s.role, "connexions_secrets")) throw new ErreurApi("action_interdite", "Action interdite.");
  if (s.clientActifId !== tenantId) throw new ErreurApi("action_interdite", "Client différent de la session.");
  const acteur = s.acteur.trim();
  if (acteur === "" || acteur.toLowerCase() === "systeme") throw new ErreurApi("action_interdite", "Acteur identifié requis.");
  return acteur;
}

export function routeLiensConnexions(serveur: FastifyInstance, d: DepsLiensConnexions): void {
  serveur.post("/api/console/v1/clients/:id/connexions/liens", { preHandler: d.exigerEquipe }, async (req, rep) => {
    const { id } = lire(Params, req.params);
    const c = lire(Corps, req.body);
    const acteur = exigerDroitSecrets(await d.session(req), id);
    // Google en IMAP de dépannage : l'attestation de l'administrateur Workspace est obligatoire ; sa trace est l'INSERT audité de la connexion (auteur).
    // Garde non exhaustive par nature (règle 9.4) : elle ne vérifie pas que le domaine est réellement un domaine Workspace.
    if (c.outil === "gmail" && c.connecteur === "imap" && c.attestation_workspace !== true) throw new ErreurApi("regle_metier", "Attestation de l'administrateur Workspace requise.");
    if (!d.porte(c.outil)) throw new ErreurApi("porte_fermee", "Service indisponible.");
    const connexionId = d.nouvelId();
    await d.creer({
      tenantId: id, acteur, connexionId, organisationId: c.organisation_id, outil: c.outil, connecteur: c.connecteur, portee: c.portee,
      referenceCoffre: `bao:clients/${id}/connexions/${connexionId}/jetons`,
    });
    if (c.application_google) await d.ecrireCoffre(`clients/${id}/connexions/${connexionId}/application`, c.application_google);
    const lien = await d.emettreLien({ tenantId: id, connexionId, outil: c.outil, ...(c.locataire_attendu ? { locataireAttendu: c.locataire_attendu } : {}), ...(c.domaine_attendu ? { domaineAttendu: c.domaine_attendu } : {}) });
    return rep.status(201).send({ connexion_id: connexionId, lien });
  });
}
