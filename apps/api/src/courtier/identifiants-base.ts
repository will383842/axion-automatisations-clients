import { nomBaseDe, nomsRoles, type Sql } from "../provisionnement/etapes-base.js";
import type { LigneBase } from "../provisionnement/machine.js";

// Courtier (T2-36, A-209) : sert à l'exécuteur cli_<id>_app (inchangé) ou cli_<id>_lecture (ADR 0113) de la base du client de sa tâche. Appelé par le courtier seulement (politique OpenBao « courtier »).
// Noms de base et de rôle : UNIQUEMENT de l'UUID validé (ADR 0046). Aucun paramètre de la requête ne désigne un rôle ni un genre (constante de chaque export), donc le propriétaire et le provisionneur ne sont jamais servis.
// Aucune valeur secrète dans le journal, dans les données d'une tâche ni dans une erreur : seul un code sort.
export class ErreurCourtier extends Error {
  constructor(readonly code: string) {
    super(code);
    if (!/^[a-z0-9_.-]{1,64}$/.test(code)) throw new Error("code d'erreur invalide");
  }
}
export interface Journal { tracer(evenement: Record<string, string | number | boolean>): void }
// Genres de rôle servis : liste fermée, jamais _proprietaire.
export type Genre = "app" | "lecture";
const NOM_ROLE = /^cli_[0-9a-f]{12}_(app|lecture)$/;
export interface Limites { statementTimeout: boolean; connectionLimit: number }
export interface PortsIdentifiants {
  // Client (tenant) propriétaire de l'instance de la tâche, lue au moment de l'appel ; undefined si la tâche n'existe pas.
  proprietaireTache(idTache: string): Promise<string | undefined>;
  base(tenantId: string): Promise<{ etat: LigneBase["etat"]; grappe: string } | undefined>;
  gelActif(tenantId: string): Promise<boolean>;
  hote(grappe: string): string;
  limites(role: string): Promise<Limites | undefined>;
  versionRole(role: string): Promise<number | undefined>;
  // Fin de validité réelle du mot de passe (VALID UNTIL) : null = sans limite posée, undefined = rôle absent.
  validiteRole(role: string): Promise<Date | null | undefined>;
  secret(nomBase: string, genre: Genre): Promise<{ motDePasse: string; version: number }>;
  journal: Journal;
  maintenant(): Date;
}
// expire : date où l'exécuteur DOIT redemander ses identifiants (15 minutes au plus, jamais après la fin réelle). valideJusqua : fin réelle du mot de passe (VALID UNTIL posé par la rotation), null si aucune.
export interface Identifiants { hote: string; base: string; role: string; motDePasse: string; expire: Date; valideJusqua: Date | null }
export const DUREE_SERVICE_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const identifiantsPourTache = (p: PortsIdentifiants, tenantBrut: string, idTache: string): Promise<Identifiants> => servir(p, tenantBrut, idTache, "app");
export const identifiantsLecturePourTache = (p: PortsIdentifiants, tenantBrut: string, idTache: string): Promise<Identifiants> => servir(p, tenantBrut, idTache, "lecture");

// Cœur interne, non exporté : `genre` vient du code de chaque export, jamais de la requête.
async function servir(p: PortsIdentifiants, tenantBrut: string, idTache: string, genre: Genre): Promise<Identifiants> {
  if (genre !== "app" && genre !== "lecture") throw new ErreurCourtier("demande_invalide");
  const tenantId = typeof tenantBrut === "string" ? tenantBrut.toLowerCase() : "";
  if (!UUID.test(tenantId) || typeof idTache !== "string" || idTache === "" || idTache.length > 100) throw new ErreurCourtier("demande_invalide");
  const refuser = (code: string): never => {
    p.journal.tracer({ evenement: "identifiants_refuses", tenantId, idTache, code });
    throw new ErreurCourtier(code);
  };
  const nomBase = nomBaseDe(tenantId);
  const role = nomsRoles(tenantId)[genre];
  // Seule la base de l'instance de CETTE tâche peut être servie : une tâche inconnue, d'un autre client ou passée à un autre client est refusée.
  if ((await p.proprietaireTache(idTache))?.toLowerCase() !== tenantId) return refuser("tache_etrangere");
  const base = await p.base(tenantId);
  if (!base) return refuser("base_absente");
  if (base.etat === "a_l_ecart" || base.etat === "exportee") return refuser("base_a_l_ecart"); // C-035 : rôles gardés, rien servi
  if (base.etat === "gelee") return refuser("base_gelee");
  if (base.etat !== "active") return refuser("base_non_active");
  if (await p.gelActif(tenantId)) return refuser("gel_actif");
  // A-417 : un rôle sans ses limites n'est pas servi.
  const limites = await p.limites(role);
  if (!limites || !limites.statementTimeout || limites.connectionLimit < 1) return refuser("limites_absentes");
  // Un mot de passe échu (ou dont la validité est illisible) n'est pas servi : sa fin réelle borne l'échéance annoncée.
  const valide = await p.validiteRole(role);
  const maintenant = p.maintenant();
  if (valide === undefined || (valide !== null && valide.getTime() <= maintenant.getTime())) return refuser("role_expire");
  // ADR 0113 : un _lecture ne tourne que s'il a une échéance posée par la rotation.
  if (genre === "lecture" && valide === null) return refuser("role_sans_echeance");
  const expire = new Date(Math.min(maintenant.getTime() + DUREE_SERVICE_MS, valide?.getTime() ?? Infinity));
  let secret: { motDePasse: string; version: number };
  try {
    secret = await p.secret(nomBase, genre);
  } catch (e) {
    return refuser(e instanceof ErreurCourtier ? e.code : "coffre_indisponible");
  }
  // Un secret rangé mais pas encore posé sur le rôle (rotation interrompue) n'est pas servi.
  if ((await p.versionRole(role)) !== secret.version) return refuser("secret_incoherent");
  p.journal.tracer({ evenement: "identifiants_servis", tenantId, idTache, base: nomBase, role, version: secret.version });
  return { hote: p.hote(base.grappe), base: nomBase, role, motDePasse: secret.motDePasse, expire, valideJusqua: valide };
}

// A-417 : statement_timeout=0 (ou négatif) veut dire « sans limite » : seule une valeur strictement positive compte.
function limitePositive(c: string): boolean {
  const m = /^statement_timeout=(\d+(?:\.\d+)?)\s*[a-z]*$/i.exec(c);
  return m !== null && Number(m[1]) > 0;
}

// Lecture des limites posées sur le rôle (statement_timeout et CONNECTION LIMIT, A-417) ; seuls cli_<id>_(app|lecture) sont interrogés.
export function limitesPg(sql: Pick<Sql, "requete">): (role: string) => Promise<Limites | undefined> {
  return async (role) => {
    if (!NOM_ROLE.test(role)) throw new Error("nom refusé");
    const ligne = (await sql.requete<{ rolconnlimit: number; rolconfig: string[] | null }>("SELECT rolconnlimit, rolconfig FROM pg_roles WHERE rolname = $1", [role]))[0];
    return ligne ? { statementTimeout: (ligne.rolconfig ?? []).some((c) => limitePositive(c)), connectionLimit: ligne.rolconnlimit } : undefined;
  };
}

// Fin de validité du mot de passe du rôle (rolvaliduntil) ; seuls cli_<id>_(app|lecture) sont interrogés.
export function validiteRolePg(sql: Pick<Sql, "requete">): (role: string) => Promise<Date | null | undefined> {
  return async (role) => {
    if (!NOM_ROLE.test(role)) throw new Error("nom refusé");
    const ligne = (await sql.requete<{ rolvaliduntil: Date | null }>("SELECT rolvaliduntil FROM pg_roles WHERE rolname = $1", [role]))[0];
    return ligne ? ligne.rolvaliduntil : undefined;
  };
}

// Lecteur OpenBao du courtier : un seul chemin, technique/data/donnees/cli_<12 hex>/(app|lecture), genre en liste fermée. Le corps d'une réponse en erreur n'est jamais repris.
export function coffreCourtier(o: { url: string; jeton: string; fetch?: typeof fetch }): { lire(nomBase: string, genre: Genre): Promise<{ motDePasse: string; version: number }> } {
  return {
    async lire(nomBase, genre) {
      if (!/^cli_[0-9a-f]{12}$/.test(nomBase)) throw new ErreurCourtier("chemin_refuse");
      if (genre !== "app" && genre !== "lecture") throw new ErreurCourtier("chemin_refuse");
      const r = await (o.fetch ?? fetch)(`${o.url}/v1/technique/data/donnees/${nomBase}/${genre}`, { headers: { "X-Vault-Token": o.jeton }, redirect: "error", signal: AbortSignal.timeout(5000) }).catch(() => undefined);
      if (!r?.ok) throw new ErreurCourtier("coffre_indisponible");
      const corps = (await r.json().catch(() => ({}))) as { data?: { data?: { valeur?: unknown }; metadata?: { version?: unknown } } };
      const { valeur } = corps.data?.data ?? {};
      const version = corps.data?.metadata?.version;
      if (typeof valeur !== "string" || valeur === "" || typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new ErreurCourtier("coffre_indisponible");
      return { motDePasse: valeur, version };
    },
  };
}
