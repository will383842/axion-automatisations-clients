import type { Pool } from "pg";
import { avecEquipe } from "../db/client-actif.js";
import { PLATEFORME_ID } from "../db/schema/aides.js";
import type { DepotRecherche, LigneRecherche, ParametresRecherche, TypeResultat } from "./index.js";

// Dépôt SQL de la recherche (T3-09a) : le SEUL pool reçu est celui du rôle console_equipe ; une transaction en lecture seule (avecEquipe) par recherche ; une requête par source, toujours les cinq.
// Texte SQL CONSTANT (aucune interpolation) ; le terme, la portée, la plateforme et la limite sont des paramètres liés. Aucune base de client, aucun montant, jamais reference_texte.
// Tables lues : organisations, contacts, factures, demandes, instances, automatisations.
const BARRE = String.raw`'\'`;
const plat = (colonne: string, parametre: number): string => `lower(public.sans_accent(${colonne})) LIKE lower(public.sans_accent($${parametre}::text)) ESCAPE ${BARRE}`;
const egal = (colonne: string, parametre: number): string => `lower(public.sans_accent(${colonne})) = lower(public.sans_accent($${parametre}::text))`;
// $1 plateforme, $2 « tous », $3 clients, $4 motif, $5 début, $6 terme, $7 identifiant (siren ou UUID de demande, ou null), $8 limite.
const PORTEE = (alias: string): string => `o.id <> $1::uuid AND ($2::boolean OR ${alias}.tenant_id = ANY($3::uuid[]))`;
const ORDRE = (libelle: string, tri: string): string => `ORDER BY (${egal(libelle, 6)}) DESC, (${plat(libelle, 5)}) DESC, ${tri}`;
const DATE = (c: string): string => `to_char(${c}, 'YYYY-MM-DD')`;
const HORODATE = (c: string): string => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const REQUETES: Record<TypeResultat, string> = {
  client: `SELECT o.id::text AS id, o.id::text AS client_id, o.raison_sociale AS libelle, o.statut::text AS statut
FROM organisations o
WHERE ${PORTEE("o")} AND (${plat("o.raison_sociale", 4)} OR o.siren = $7::text)
${ORDRE("o.raison_sociale", "o.id")}
LIMIT $8::int`,
  contact: `SELECT x.id::text AS id, o.id::text AS client_id, o.raison_sociale AS client_nom, x.nom AS libelle, x.email AS email, x.role::text AS role
FROM contacts x
JOIN organisations o ON o.tenant_id = x.tenant_id AND o.id = x.organisation_id
WHERE ${PORTEE("x")} AND (${plat("x.nom", 4)} OR ${plat("x.email", 4)})
${ORDRE("x.nom", "x.id")}
LIMIT $8::int`,
  facture: `SELECT x.id::text AS id, o.id::text AS client_id, o.raison_sociale AS client_nom, x.numero AS libelle, x.statut::text AS statut, ${DATE("x.periode_debut")} AS periode_debut, ${DATE("x.periode_fin")} AS periode_fin
FROM factures x
JOIN organisations o ON o.tenant_id = x.tenant_id AND o.id = x.organisation_id
WHERE ${PORTEE("x")} AND ${plat("x.numero", 4)}
${ORDRE("x.numero", "x.id")}
LIMIT $8::int`,
  // $7 vaut NULL sauf si le terme a la forme d'un UUID : l'erreur « syntaxe UUID invalide » de PostgreSQL recopierait le terme.
  demande: `SELECT x.id::text AS id, o.id::text AS client_id, o.raison_sociale AS client_nom, x.categorie AS libelle, x.statut::text AS statut, ${HORODATE("x.cree_le")} AS cree_le
FROM demandes x
JOIN organisations o ON o.tenant_id = x.tenant_id AND o.id = x.organisation_id
WHERE ${PORTEE("x")} AND (${plat("x.categorie", 4)} OR x.id = $7::uuid)
${ORDRE("x.categorie", "x.id")}
LIMIT $8::int`,
  instance: `SELECT x.id::text AS id, o.id::text AS client_id, o.raison_sociale AS client_nom, x.code_automatisation AS libelle, a.nom AS automatisation_nom, x.etat::text AS etat
FROM instances x
JOIN organisations o ON o.tenant_id = x.tenant_id AND o.id = x.organisation_id
LEFT JOIN automatisations a ON a.id = x.automatisation_id
WHERE ${PORTEE("x")} AND (${plat("x.code_automatisation", 4)} OR ${plat("a.nom", 4)})
${ORDRE("x.code_automatisation", "x.id")}
LIMIT $8::int`,
};

// Un paramètre inutilisé par une requête n'est pas envoyé (PostgreSQL refuse un nombre de paramètres différent) : seules les positions citées partent, renumérotées.
function lier(texte: string, valeurs: unknown[]): { texte: string; params: unknown[] } {
  const utilises = [...new Set([...texte.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const nouveau = new Map(utilises.map((n, i) => [n, i + 1]));
  return { texte: texte.replace(/\$(\d+)/g, (_m, n: string) => `$${nouveau.get(Number(n))}`), params: utilises.map((n) => valeurs[n - 1]) };
}

export function creerDepotRechercheSql(poolEquipe: Pool): DepotRecherche {
  return {
    async chercher(p: ParametresRecherche): Promise<LigneRecherche[]> {
      return avecEquipe(poolEquipe, async (client) => {
        const lignes: LigneRecherche[] = [];
        for (const type of Object.keys(REQUETES) as TypeResultat[]) {
          const { texte, params } = lier(REQUETES[type], [PLATEFORME_ID, p.tous, p.clients, p.motif, p.debut, p.terme, type === "client" ? p.siren : p.idDemande, p.limite]);
          const { rows } = await client.query(texte, params);
          for (const r of rows as Record<string, unknown>[]) lignes.push({ ...r, type } as unknown as LigneRecherche);
        }
        return lignes;
      });
    },
  };
}
