import type { Pool } from "pg";
import { avecEquipe } from "../db/client-actif.ts";
import { ErreurApi } from "../plugins/erreurs.js";
import { ErreurKeycloak, type KeycloakAdmin } from "./keycloak-admin.ts";
import type { TraceSessions } from "./trace.ts";

// Sessions de l'équipe (T3-07b, B-026 et B-027). Le sujet d'un membre (membres_equipe.sujet) est son identifiant Keycloak : il ne sort jamais dans une réponse.
// Valeurs du royaume « equipe » (écrites une fois) : session de 8 h au plus, 30 min d'inactivité.
const DUREE_MAX_MS = 8 * 3_600_000;
const INACTIVITE_MS = 30 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MembreSession { id: string; sujet: string; role: string }
export interface DepsSessions {
  maintenant(): number;
  membres: { actifs(): Promise<MembreSession[]>; actif(id: string): Promise<MembreSession | undefined> };
  keycloak: Pick<KeycloakAdmin, "sessionsDe" | "facteursDe" | "fermerSession">;
  trace: TraceSessions;
}
export interface MembreAvecSessions {
  membre_id: string;
  role: string;
  facteurs: string[];
  sessions: { id: string; ouverte_le: string; derniere_activite: string; fin_prevue: string }[];
}

// Une panne de Keycloak ne montre aucun détail : 503 « porte_fermee ».
const panne = (e: unknown): never => {
  if (e instanceof ErreurApi) throw e;
  throw new ErreurApi("porte_fermee", "Service indisponible.");
};
const absente = () => new ErreurApi("introuvable", "Ressource introuvable.");
const iso = (ms: number) => new Date(ms).toISOString();

export async function listerSessions(d: DepsSessions): Promise<MembreAvecSessions[]> {
  const membres = await d.membres.actifs();
  return Promise.all(membres.map(async (m) => {
    if (!UUID.test(m.sujet)) return { membre_id: m.id, role: m.role, facteurs: [], sessions: [] };
    try {
      const [sessions, facteurs] = await Promise.all([
        d.keycloak.sessionsDe(m.sujet).catch((e: unknown) => (e instanceof ErreurKeycloak && e.code === "introuvable" ? [] : Promise.reject(e))),
        d.keycloak.facteursDe(m.sujet).catch((e: unknown) => (e instanceof ErreurKeycloak && e.code === "introuvable" ? [] : Promise.reject(e))),
      ]);
      return {
        membre_id: m.id, role: m.role, facteurs: [...facteurs],
        sessions: sessions.map((s) => ({ id: s.id, ouverte_le: iso(s.ouverteLe), derniere_activite: iso(s.derniereActivite), fin_prevue: iso(Math.min(s.ouverteLe + DUREE_MAX_MS, s.derniereActivite + INACTIVITE_MS)) })),
      };
    } catch (e) {
      return panne(e);
    }
  }));
}

// La session doit appartenir à CE membre : jamais de fermeture par identifiant aveugle (404 identique pour absente, d'un autre membre ou d'un autre royaume).
export async function revoquerSession(d: DepsSessions, o: { acteur: string; membreId: string; sessionId: string }): Promise<void> {
  const membre = await d.membres.actif(o.membreId);
  if (!membre || !UUID.test(membre.sujet)) throw absente();
  let sessions;
  try {
    sessions = await d.keycloak.sessionsDe(membre.sujet);
  } catch (e) {
    if (e instanceof ErreurKeycloak && e.code === "introuvable") throw absente();
    return panne(e);
  }
  if (!sessions.some((s) => s.id === o.sessionId)) throw absente();
  try {
    await d.keycloak.fermerSession(o.sessionId);
  } catch (e) {
    if (e instanceof ErreurKeycloak && e.code === "introuvable") throw absente();
    return panne(e);
  }
  // Fermée dans Keycloak : la trace suit. Un échec de trace n'est pas masqué (500) ; un rejeu rend 404 sans effet ni trace en double.
  await d.trace.revocation({ acteur: o.acteur, membreId: o.membreId, sessionId: o.sessionId });
}

// Lecture des membres actifs par console_equipe (lecture seule). Aucune écriture ici.
export function creerMembresSessions(poolEquipe: Pool): DepsSessions["membres"] {
  const lire = (filtre: string, valeurs: unknown[]) => avecEquipe(poolEquipe, (c) => c.query<MembreSession>(`SELECT id, sujet, role FROM membres_equipe WHERE actif ${filtre} ORDER BY cree_le LIMIT 1000`, valeurs));
  return {
    actifs: async () => (await lire("", [])).rows,
    actif: async (id) => (UUID.test(id) ? (await lire("AND id = $1::uuid", [id])).rows[0] : undefined),
  };
}
