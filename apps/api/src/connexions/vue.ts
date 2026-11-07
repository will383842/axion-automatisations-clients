// Vue des connexions d'un client (T3-17a, ADR 0134). Seule forme que l'API rend : jamais reference_coffre, portee ni organisation_id (le coffre reste au coffre).
// console_equipe lit tous les clients : le filtre « tenant_id = $1 » figure sur CHAQUE table de la requête, jointures comprises (seconde barrière d'isolation).
export interface Requeteur {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}
export interface LigneConnexion {
  id: string;
  outil: string;
  connecteur: string;
  etat: string;
  expire_le: Date | string | null;
  dernier_test_le: Date | string | null;
  automatisation_code: string | null;
  automatisation_nom: string | null;
  contact_nom: string | null;
  contact_role: string | null;
}
export interface ConnexionVue {
  id: string;
  outil: string;
  connecteur: string;
  etat: string;
  expire_le: string | null;
  dernier_test: { le: string | null; resultat: "ok" | "echec" | null; code: null };
  automatisations: { code: string; nom: string }[];
  a_contacter: { nom: string; role: string } | null;
}

// Requête constante, colonnes nommées. La personne à joindre : contact technique le plus ancien, sinon principal le plus ancien (nom et rôle seulement, jamais l'e-mail).
export const REQUETE_CONNEXIONS = `SELECT c.id, c.outil, c.connecteur, c.etat, c.expire_le, c.dernier_test_le,
  a.code AS automatisation_code, a.nom AS automatisation_nom, k.nom AS contact_nom, k.role AS contact_role
FROM connexions c
LEFT JOIN connexions_instances ci ON ci.tenant_id = $1 AND ci.connexion_id = c.id AND ci.delie_le IS NULL
LEFT JOIN instances i ON i.tenant_id = $1 AND i.id = ci.instance_id
LEFT JOIN automatisations a ON a.code = i.code_automatisation
LEFT JOIN LATERAL (
  SELECT ct.nom, ct.role FROM contacts ct
  WHERE ct.tenant_id = $1 AND ct.role IN ('technique', 'principal')
  ORDER BY (ct.role = 'technique') DESC, ct.cree_le, ct.id LIMIT 1
) k ON true
WHERE c.tenant_id = $1
ORDER BY c.outil, c.id, a.code`;

export async function lireLignesConnexions(tx: Requeteur, clientId: string): Promise<LigneConnexion[]> {
  return (await tx.query(REQUETE_CONNEXIONS, [clientId])).rows as LigneConnexion[];
}

// ISO UTC tronqué à la minute (2026-11-07T10:42Z) ; null ou date illisible : null.
function alaMinute(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : `${d.toISOString().slice(0, 16)}Z`;
}
// Le code du dernier test n'a pas de colonne (ADR 0134, E1) : toujours null d'ici là.
const resultatDe = (etat: string): "ok" | "echec" | null => (etat === "active" ? "ok" : etat === "en_echec" || etat === "expiree" ? "echec" : null);

// Projection clé par clé : aucune clé de la ligne brute ne sort sans être nommée ici (jamais d'étalement).
export function versVues(lignes: readonly LigneConnexion[]): ConnexionVue[] {
  const vues = new Map<string, ConnexionVue>();
  for (const l of lignes) {
    let v = vues.get(l.id);
    if (!v) {
      v = {
        id: l.id, outil: l.outil, connecteur: l.connecteur, etat: l.etat,
        expire_le: alaMinute(l.expire_le),
        dernier_test: { le: alaMinute(l.dernier_test_le), resultat: resultatDe(l.etat), code: null },
        automatisations: [],
        a_contacter: l.contact_nom !== null && l.contact_role !== null ? { nom: l.contact_nom, role: l.contact_role } : null,
      };
      vues.set(l.id, v);
    }
    if (l.automatisation_code !== null && l.automatisation_nom !== null && !v.automatisations.some((a) => a.code === l.automatisation_code)) v.automatisations.push({ code: l.automatisation_code, nom: l.automatisation_nom });
  }
  return [...vues.values()];
}
