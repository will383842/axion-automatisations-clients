import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { ErreurApi } from "../../plugins/erreurs.js";
import type { SessionPortee } from "./fiche.js";

// Notes de la fiche client (T3-13, B-050, B-103). Même règles que la fiche : équipe seule, client dans la portée sinon 404, 503 tant que `ouvert()` est faux.
// L'auteur vient de la session, jamais du corps. Épingler ne change que « epinglee » (droit de colonne de la migration 0020).
export type TypeNote = "note" | "appel" | "echange";
export interface Note {
  id: string;
  type: TypeNote;
  texte: string;
  auteur: string;
  epinglee: boolean;
  cree_le: string;
}
export interface Trace {
  acteur: string;
  client: string;
  action: "noter_appel_clore_alerte";
  alerte_id: string;
  note_id: string;
}
export interface DepsNotes {
  ouvert(): boolean;
  exigerEquipe: preHandlerAsyncHookHandler;
  session(requete: FastifyRequest): Promise<SessionPortee>;
  lister(clientId: string): Promise<Note[]>;
  ajouter(clientId: string, acteur: string, note: { type: TypeNote; texte: string }): Promise<Note>;
  epingler(clientId: string, acteur: string, noteId: string, epinglee: boolean): Promise<Note | null>;
  // Une seule transaction côté dépôt : la note d'appel et la clôture de l'alerte réussissent ensemble ou pas du tout. null : alerte inconnue de ce client.
  // Le dépôt écrit aussi la trace (identifiants seulement) DANS cette transaction : si la trace échoue, tout est annulé (alerte ouverte, aucune note).
  noterAppelEtClore(clientId: string, acteur: string, e: { texte: string; alerteId: string }, tracer: (note: Note) => Trace): Promise<{ note: Note; alerte_close: boolean } | null>;
}

const Texte = z.string().trim().min(1).max(2000);
const Params = z.strictObject({ id: z.uuid() });
const ParamsNote = z.strictObject({ id: z.uuid(), idNote: z.uuid() });
const Ajout = z.strictObject({ type: z.enum(["note", "appel", "echange"]), texte: Texte });
const Epingle = z.strictObject({ epinglee: z.boolean() });
const Appel = z.strictObject({ texte: Texte, alerte_id: z.uuid() });
const lire = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v);
  if (!r.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  return r.data;
};

// Épinglées d'abord, puis les plus récentes.
export const ordonnerNotes = (notes: readonly Note[]): Note[] =>
  [...notes].sort((a, b) => Number(b.epinglee) - Number(a.epinglee) || Date.parse(b.cree_le) - Date.parse(a.cree_le));

export function routeNotes(serveur: FastifyInstance, d: DepsNotes): void {
  const base = "/api/console/v1/clients/:id/notes";
  const o = { preHandler: d.exigerEquipe };
  // Ordre fixe : interrupteur, forme de la requête, portée. Un client hors portée ne déclenche aucune lecture ni écriture.
  const portee = async (req: FastifyRequest, params: z.ZodType<{ id: string }>) => {
    if (!d.ouvert()) throw new ErreurApi("porte_fermee", "Service indisponible.");
    const { id } = lire(params, req.params);
    const s = await d.session(req);
    if (!s.peutVoir(id)) throw new ErreurApi("introuvable", "Ressource introuvable.");
    return { id, acteur: s.acteur };
  };
  serveur.get(base, o, async (req) => {
    const { id } = await portee(req, Params);
    return { notes: ordonnerNotes(await d.lister(id)) };
  });
  serveur.post(base, o, async (req, rep) => {
    const { id, acteur } = await portee(req, Params);
    return rep.status(201).send(await d.ajouter(id, acteur, lire(Ajout, req.body)));
  });
  serveur.post(`${base}/:idNote/epingler`, o, async (req) => {
    const { id, acteur } = await portee(req, ParamsNote);
    const { idNote } = lire(ParamsNote, req.params);
    const n = await d.epingler(id, acteur, idNote, lire(Epingle, req.body).epinglee);
    if (!n) throw new ErreurApi("introuvable", "Ressource introuvable.");
    return n;
  });
  // « Noter l'appel et clore l'alerte » : un seul geste, tracé par identifiants (jamais le texte de la note).
  serveur.post(`${base}/appel-et-cloture`, o, async (req, rep) => {
    const { id, acteur } = await portee(req, Params);
    const e = lire(Appel, req.body);
    const r = await d.noterAppelEtClore(id, acteur, { texte: e.texte, alerteId: e.alerte_id }, (note) => ({ acteur, client: id, action: "noter_appel_clore_alerte", alerte_id: e.alerte_id, note_id: note.id }));
    if (!r) throw new ErreurApi("introuvable", "Ressource introuvable.");
    return rep.status(201).send(r);
  });
}
