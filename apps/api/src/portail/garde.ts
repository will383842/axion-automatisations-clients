import type { FastifyInstance, FastifyRequest } from "fastify";
import { ErreurApi } from "../plugins/erreurs.js";
import { autorise, rubriqueDe, RACINE_PORTAIL } from "./roles.ts";
import type { SessionApiPortail } from "./session.ts";

// Garde unique de l'API du portail (T6-02b), branchée AVANT toute route. Elle filtre sur le chemin DÉCLARÉ (routeOptions.url), jamais sur l'adresse brute.
// Ordre : règle absente → 403 ; session absente ou refusée → 401 ; rôle refusé → 403 ; ressource hors périmètre → 404 (corps identique à une ressource absente).
export interface DepsGardePortail { session(requete: FastifyRequest): Promise<SessionApiPortail> }

const sessions = new WeakMap<FastifyRequest, SessionApiPortail>();
export const sessionDe = (requete: FastifyRequest): SessionApiPortail | undefined => sessions.get(requete);

// Clés interdites en sortie (A-004) : liste FERMÉE, non exhaustive par nature (règle 9.4) ; comparaison sans casse ni séparateur.
const INTERDITES = new Set(["executeur", "executeurid", "cellule", "celluleid", "versionmodule", "versionmoduleid", "moduleversion", "moduleversionid"]);
const normaliser = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
function contientCleInterdite(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(contientCleInterdite);
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => INTERDITES.has(normaliser(k)) || contientCleInterdite(x));
  return false;
}

export function brancherGardePortail(serveur: FastifyInstance, d: DepsGardePortail): void {
  serveur.addHook("preHandler", async (requete) => {
    const url = requete.routeOptions.url ?? "";
    if (!url.startsWith(RACINE_PORTAIL)) return;
    if (!rubriqueDe(url)) throw new ErreurApi("action_interdite", "Action interdite.");
    const session = await d.session(requete);
    if (!autorise(session.roleClient, requete.method, url)) throw new ErreurApi("action_interdite", "Action interdite.");
    const instance = (requete.params as { instance?: unknown } | undefined)?.instance;
    if (typeof instance === "string" && session.automatisations && !session.automatisations.includes(instance)) throw new ErreurApi("introuvable", "Ressource introuvable.");
    sessions.set(requete, session);
  });
  serveur.addHook("onSend", async (requete, reponse, charge) => {
    if (!(requete.routeOptions.url ?? "").startsWith(RACINE_PORTAIL) || typeof charge !== "string" || !String(reponse.getHeader("content-type") ?? "").includes("json")) return charge;
    let objet: unknown;
    try { objet = JSON.parse(charge); } catch { return charge; }
    if (!contientCleInterdite(objet)) return charge;
    reponse.status(500);
    return JSON.stringify({ erreur: { code: "erreur_interne", message: "Erreur interne.", id_trace: requete.id } });
  });
}
