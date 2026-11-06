import type { FileMinimale } from "../../files/files.js";
import { deposer } from "../../files/files.js";

// Relève horaire d'une base cli_<id> (A-263) : métadonnées seulement, aucune ligne de travail du client lue, aucune écriture dans la base du client.
// Chaque lecture est un port ; les adaptateurs SQL (rôle donnees_supervision) viennent avec le branchement.
export interface BaseARelever {
  tenantId: string;
  nomBase: string;
}
export interface MesureBase {
  base: string;
  debut: Date;
  tailleOctets: number;
  quotaOctets: number | null;
  connexions: number;
  limiteConnexions: number; // non rangée (mesures_bases n'a pas la colonne) : sert aux alertes de la même relève
  requetesLentes: number;
  lignesMortes: number;
  versionStructure: string;
  ageSauvegardeS: number | null;
  ageTestRestaurationS: number | null;
}
export interface PortsReleve {
  tailleBase(nomBase: string): Promise<number>; // pg_database_size
  quotaOctets(tenantId: string): Promise<number | null>;
  connexions(nomBase: string): Promise<{ actives: number; limite: number }>; // pg_stat_database / pg_database
  lignesMortes(nomBase: string): Promise<number>; // pg_stat_user_tables.n_dead_tup, sommé
  requetesLentes(nomBase: string): Promise<number>;
  versionStructure(nomBase: string): Promise<string>;
  ageSauvegardeS(tenantId: string): Promise<number | null>;
  ageTestRestaurationS(tenantId: string): Promise<number | null>;
  ecrire(tenantId: string, mesure: MesureBase): Promise<void>;
  maintenant(): Date;
}

// Droits du rôle de supervision (à poser par l'exploitation de la grappe « données ») : statistiques seulement, aucune table de client.
export const DROITS_SUPERVISION: readonly string[] = ["GRANT pg_monitor TO donnees_supervision", "GRANT CONNECT ON DATABASE <base cli_<id>> TO donnees_supervision"];

export const SQL_INSERT_MESURE =
  "INSERT INTO mesures_bases (tenant_id, id, debut, base, taille_octets, quota_octets, connexions, requetes_lentes, lignes_mortes, version_structure, age_sauvegarde_s, age_test_restauration_s) " +
  "VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)";

const FORME_BASE = /^cli_[a-z0-9_]{1,59}$/;
const entier = (v: number | null, nom: string): number | null => {
  if (v !== null && (!Number.isSafeInteger(v) || v < 0)) throw new Error(`mesure invalide : ${nom}`);
  return v;
};

export async function releverBase(ports: PortsReleve, base: BaseARelever): Promise<MesureBase> {
  if (!FORME_BASE.test(base.nomBase)) throw new Error("nom de base refusé (forme cli_<id> attendue)");
  const n = base.nomBase;
  const [taille, quota, cx, mortes, lentes, version, sauvegarde, restauration] = await Promise.all([
    ports.tailleBase(n), ports.quotaOctets(base.tenantId), ports.connexions(n), ports.lignesMortes(n), ports.requetesLentes(n),
    ports.versionStructure(n), ports.ageSauvegardeS(base.tenantId), ports.ageTestRestaurationS(base.tenantId),
  ]);
  // Une mesure douteuse n'est jamais écrite : elle fausserait les alertes.
  const mesure: MesureBase = {
    base: n, debut: ports.maintenant(), tailleOctets: entier(taille, "taille")!, quotaOctets: entier(quota, "quota"), connexions: entier(cx.actives, "connexions")!,
    limiteConnexions: entier(cx.limite, "limite")!, requetesLentes: entier(lentes, "requetes lentes")!, lignesMortes: entier(mortes, "lignes mortes")!,
    versionStructure: version, ageSauvegardeS: entier(sauvegarde, "age sauvegarde"), ageTestRestaurationS: entier(restauration, "age restauration"),
  };
  await ports.ecrire(base.tenantId, mesure);
  return mesure;
}

// Une base en échec n'arrête pas la relève des autres.
export async function releverLot(ports: PortsReleve, bases: BaseARelever[]): Promise<{ relevees: number; echecs: string[] }> {
  const echecs: string[] = [];
  let relevees = 0;
  for (const b of bases) {
    try {
      await releverBase(ports, b);
      relevees += 1;
    } catch {
      echecs.push(b.nomBase);
    }
  }
  return { relevees, echecs };
}

export const TYPE_TACHE_RELEVE = "releve_base";
// Même base, même heure (UTC) → même jobId : BullMQ garde une seule tâche par heure.
export function deposerReleve(file: FileMinimale, base: BaseARelever, maintenant: Date): Promise<void> {
  return deposer(file, { tenantId: base.tenantId, type: TYPE_TACHE_RELEVE, cle: `${base.nomBase}|${maintenant.toISOString().slice(0, 13)}` }, { nomBase: base.nomBase });
}
