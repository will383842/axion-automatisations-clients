import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { avecEquipe } from "../../db/client-actif.js";
import { ErreurApi } from "../../plugins/erreurs.js";
import { attribuer, clore, commenter, ErreurCycle, type DepotCycle } from "./cycle.js";
import { ErreurRegles, GRAVITES_REGLE, reglerRegle, type DepotRegles } from "./regles.js";

// File d'alertes de l'équipe (T5-04c, B-030, B-031) : cinq routes, équipe SEULE, fermées (503) tant que `ouvert` est faux (SUPERVISION_ALERTES_OUVERTE).
// Ordre fixe : porte (503), équipe (403), rôle d'écriture (403), paramètres (400), alerte inconnue (404), puis le métier (422).
// Le client d'une alerte est TOUJOURS lu en base (tenantDe), jamais pris du corps, d'un en-tête ou de l'adresse. Aucune ligne ne porte de contenu : codes, compteur, dates.
export interface LigneAlerte {
  id: string;
  client: string;
  type: string;
  gravite: string;
  cause: string | null;
  responsable: string | null;
  etat: string;
  cree_le: string;
  occurrences: number;
}
export interface CurseurAlerte {
  creeLe: string;
  tenantId: string;
  id: string;
}
export interface FiltreAlertes {
  gravite?: string | undefined;
  client?: string | undefined;
  responsable?: string | undefined;
  etat?: string | undefined;
  limite: number;
  curseur?: CurseurAlerte;
}
export interface LectureAlertes {
  liste(filtre: FiltreAlertes): Promise<LigneAlerte[]>;
  tenantDe(alerteId: string): Promise<string | null>;
}
export interface DepsFileAlertes {
  ouvert: boolean;
  authentifier(requete: FastifyRequest): Promise<{ acteur: string; role: string }>;
  lire: LectureAlertes;
  cycle: DepotCycle;
  regles: DepotRegles;
}

const ROLES_LECTURE_SEULE = new Set(["lecteur"]);
const Gravite = z.enum(GRAVITES_REGLE);
const Requete = z.strictObject({
  gravite: Gravite.optional(),
  client: z.uuid().optional(),
  responsable: z.string().min(1).max(200).optional(),
  etat: z.enum(["ouverte", "acquittee", "close"]).optional(),
  limite: z.coerce.number().int().min(1).max(100).default(50),
  curseur: z.string().max(400).optional(),
});
const Curseur = z.strictObject({ c: z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/), t: z.uuid(), i: z.uuid() });
const Id = z.strictObject({ id: z.uuid() });
const CorpsVide = z.strictObject({});
const CorpsClore = z.strictObject({ raison: z.string().max(64).optional() });
const CorpsCommentaire = z.strictObject({ texte: z.string().optional() });
const CorpsRegle = z
  .strictObject({ gravite: Gravite.optional(), seuil: z.number().int().optional(), fenetre_s: z.number().int().optional(), active: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0);

const lire = <T>(s: z.ZodType<T>, v: unknown): T => {
  const r = s.safeParse(v);
  if (!r.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
  return r.data;
};
// Projection explicite : seuls ces champs sortent, quoi que rende la lecture.
const projeter = (l: LigneAlerte): LigneAlerte => ({ id: l.id, client: l.client, type: l.type, gravite: l.gravite, cause: l.cause, responsable: l.responsable, etat: l.etat, cree_le: l.cree_le, occurrences: l.occurrences });
const encoder = (l: LigneAlerte): string => Buffer.from(JSON.stringify({ c: l.cree_le, t: l.client, i: l.id })).toString("base64url");
function decoder(texte: string): CurseurAlerte {
  try {
    const v = lire(Curseur, JSON.parse(Buffer.from(texte, "base64url").toString("utf8")));
    return { creeLe: v.c, tenantId: v.t, id: v.i };
  } catch {
    throw new ErreurApi("schema_invalide", "Requête invalide.");
  }
}
const regleMetier = (e: unknown): never => {
  if (e instanceof ErreurCycle) throw new ErreurApi("regle_metier", e.code === "alerte_close" ? "Alerte déjà close." : e.code === "raison_invalide" ? "Motif de clôture invalide." : "Commentaire invalide (1 à 500 caractères).");
  if (e instanceof ErreurRegles && e.code === "valeur_invalide") throw new ErreurApi("regle_metier", "Valeur de règle invalide.");
  throw e;
};

export function routeFileAlertes(serveur: FastifyInstance, d: DepsFileAlertes): void {
  void serveur.register(async (s) => {
    const preparer = async (requete: FastifyRequest, ecriture: boolean) => {
      if (!d.ouvert) throw new ErreurApi("porte_fermee", "Service indisponible.");
      const session = await d.authentifier(requete);
      if (ecriture && ROLES_LECTURE_SEULE.has(session.role)) throw new ErreurApi("action_interdite", "Action interdite.");
      return session.acteur;
    };
    // Une écriture sur une alerte : identifiant valide, client lu en base (404 sinon), corps vérifié, puis le métier.
    const surAlerte = async <C>(requete: FastifyRequest, corps: z.ZodType<C>, fn: (o: { tenantId: string; id: string; acteur: string; corps: C }) => Promise<unknown>) => {
      const acteur = await preparer(requete, true);
      const { id } = lire(Id, requete.params);
      const tenantId = await d.lire.tenantDe(id);
      if (!tenantId) throw new ErreurApi("introuvable", "Ressource introuvable.");
      const c = lire(corps, requete.body ?? {});
      try {
        await fn({ tenantId, id, acteur, corps: c });
      } catch (e) {
        regleMetier(e);
      }
      return id;
    };

    s.get("/api/console/v1/alertes", async (requete) => {
      await preparer(requete, false);
      const q = lire(Requete, requete.query);
      const { curseur, ...reste } = q;
      const lignes = await d.lire.liste({ ...reste, limite: q.limite + 1, ...(curseur ? { curseur: decoder(curseur) } : {}) });
      const page = lignes.slice(0, q.limite);
      return { alertes: page.map(projeter), curseur_suivant: lignes.length > q.limite ? encoder(page[page.length - 1]!) : null };
    });
    s.post("/api/console/v1/alertes/:id/attribuer", async (requete) => {
      const id = await surAlerte(requete, CorpsVide, (o) => attribuer(d.cycle, o.tenantId, o.id, o.acteur)); // l'acteur vient de la session, jamais du corps
      return { alerte_id: id, etat: "acquittee" };
    });
    s.post("/api/console/v1/alertes/:id/commenter", async (requete, reponse) => {
      const id = await surAlerte(requete, CorpsCommentaire, (o) => commenter(d.cycle, o.tenantId, o.id, o.corps.texte as string, o.acteur));
      return reponse.status(201).send({ alerte_id: id });
    });
    s.post("/api/console/v1/alertes/:id/clore", async (requete) => {
      const id = await surAlerte(requete, CorpsClore, (o) => clore(d.cycle, o.tenantId, o.id, o.corps.raison ?? "", o.acteur)); // sans motif : refusé par clore (422)
      return { alerte_id: id, etat: "close" };
    });
    s.put("/api/console/v1/regles-alertes/:id", async (requete) => {
      const acteur = await preparer(requete, true);
      const { id } = lire(Id, requete.params);
      const reglage = lire(CorpsRegle, requete.body);
      try {
        const r = await reglerRegle(d.regles, id, reglage, acteur);
        if (!r) throw new ErreurApi("introuvable", "Ressource introuvable.");
        return r;
      } catch (e) {
        return regleMetier(e);
      }
    });
  });
}

// Lecture SQL par l'équipe (rôle console_equipe, toutes les organisations) ; la date est lue en texte à la microseconde pour que le curseur n'omette ni ne répète aucune ligne.
export function depotSqlLecture(poolEquipe: Pool): LectureAlertes {
  const CREE_LE = `to_char(a.cree_le AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  return {
    liste: (f) =>
      avecEquipe(poolEquipe, async (c) => {
        const p: unknown[] = [];
        const ou: string[] = [];
        const ajoute = (cond: string, ...v: unknown[]) => (ou.push(cond.replace(/\?/g, () => `$${p.push(v.shift()) }`)));
        if (f.gravite) ajoute("a.gravite = ?", f.gravite);
        if (f.client) ajoute("a.tenant_id = ?", f.client);
        if (f.responsable) ajoute("a.assignee_a = ?", f.responsable);
        if (f.etat) ajoute("a.etat = ?", f.etat);
        if (f.curseur) ajoute("(a.cree_le, a.tenant_id, a.id) > (?::timestamptz, ?::uuid, ?::uuid)", f.curseur.creeLe, f.curseur.tenantId, f.curseur.id);
        p.push(f.limite);
        const r = await c.query(
          `SELECT a.id, a.tenant_id AS client, a.type, a.gravite, a.cause, a.assignee_a AS responsable, a.etat, ${CREE_LE} AS cree_le, ` +
            `(SELECT count(*)::int FROM occurrences_alertes o WHERE o.tenant_id = a.tenant_id AND o.alerte_id = a.id) AS occurrences ` +
            `FROM alertes a ${ou.length ? `WHERE ${ou.join(" AND ")} ` : ""}ORDER BY a.cree_le, a.tenant_id, a.id LIMIT $${p.length}`,
          p,
        );
        return r.rows as LigneAlerte[];
      }),
    tenantDe: (alerteId) =>
      avecEquipe(poolEquipe, async (c) => {
        const r = await c.query("SELECT tenant_id FROM alertes WHERE id = $1 LIMIT 2", [alerteId]);
        return r.rows.length === 1 ? (r.rows[0] as { tenant_id: string }).tenant_id : null; // 0 ou 2 : introuvable
      }),
  };
}
