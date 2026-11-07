import { nomBaseDe } from "../provisionnement/etapes-base.js";
import type { Verrou } from "../provisionnement/machine.js";
import { ErreurCourtier, type Journal } from "./identifiants-base.js";

// Accès humain exceptionnel (A-211) : identifiant dynamique d'OpenBao (moteur database/), un rôle dynamique PAR CLIENT (humain-lecture-cli_<id>) rattaché à cli_<id>_lecture seul,
// une heure au plus, ouvert seulement avec une intervention valide de visibilite_acces (T2-30) : période en cours, accord écrit du client, intervenant = demandeur.
// Le jeton de ce chemin (HUMAINS) n'est pas celui de l'exécuteur (DONNEES). Le bail est révoqué à la fin de l'intervention.
export const DUREE_MAX_S = 3600;
export interface Intervention { perimetre: string; intervenant: string; debut: Date; fin: Date; accords: string[] }
export interface BailHumain { utilisateur: string; motDePasse: string; dureeSecondes: number; bail: string }
export interface PortsAccesHumain {
  intervention(tenantId: string): Promise<Intervention | undefined>;
  // MÊME instance et MÊME clé que PortsRotation.verrou au branchement : une rotation qui tient le verrou refuse toute émission (rotation_en_cours).
  verrou: Verrou;
  creds: { emettre(tenantId: string): Promise<BailHumain> };
  bail: {
    programmerRevocation(tenantId: string, bail: string, delaiMs: number): Promise<void>;
    revoquer(tenantId: string, bail: string): Promise<void>;
  };
  journal: Journal;
  maintenant(): Date;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LECTURE_SEULE = /[ée]cri|modif|suppr|admin/i;
const nomRole = (tenantId: string): string => `humain-lecture-${nomBaseDe(tenantId)}`;
// Un bail n'est valable que s'il vient du rôle dynamique de CE client.
const bailDe = (tenantId: string, bail: unknown): bail is string => typeof bail === "string" && bail.startsWith(`database/creds/${nomRole(tenantId)}/`) && /^[A-Za-z0-9/_-]{1,200}$/.test(bail) && !bail.includes("..") && /^[A-Za-z0-9]{8,64}$/.test(bail.slice(`database/creds/${nomRole(tenantId)}/`.length));

export async function ouvrirAccesHumain(p: PortsAccesHumain, tenantBrut: string, qui: string, motif: string): Promise<{ utilisateur: string; motDePasse: string; expire: Date; lectureSeule: true }> {
  const tenantId = typeof tenantBrut === "string" ? tenantBrut.toLowerCase() : "";
  const q = typeof qui === "string" ? qui.trim() : "";
  const m = typeof motif === "string" ? motif.trim() : "";
  if (!UUID.test(tenantId) || q === "" || q.length > 200 || m === "" || m.length > 500) throw new ErreurCourtier("demande_invalide");
  const maintenant = p.maintenant();
  const refuser = (code: string): never => {
    p.journal.tracer({ evenement: "acces_humain_refuse", tenantId, qui: q, motif: m, code });
    throw new ErreurCourtier(code);
  };
  const i = await p.intervention(tenantId);
  if (!i || i.accords.length === 0 || i.debut.getTime() > maintenant.getTime() || i.fin.getTime() <= maintenant.getTime()) return refuser("accord_absent");
  // Le demandeur est l'intervenant nommé par la ligne d'accord, pas une autre personne de l'équipe.
  if (typeof i.intervenant !== "string" || i.intervenant.trim().toLowerCase() !== q.toLowerCase()) return refuser("intervenant_different");
  const perimetre = typeof i.perimetre === "string" ? i.perimetre.trim() : "";
  if (perimetre === "" || perimetre.length > 500 || LECTURE_SEULE.test(perimetre)) return refuser("perimetre_hors_lecture");
  // Pas de « contrôle puis action » : on PREND le verrou autour de l'émission et de la programmation. Une rotation en cours (qui révoque tous les baux) le tient : refus, jamais un bail qui lui échapperait.
  const rendre = await p.verrou.prendre(tenantId);
  if (!rendre) return refuser("rotation_en_cours");
  try {
    const c = await p.creds.emettre(tenantId);
    // Tout identifiant émis est révoqué si la suite échoue : jamais un bail sans fin connue.
    const annuler = async (code: string): Promise<never> => {
      if (bailDe(tenantId, c.bail)) await p.bail.revoquer(tenantId, c.bail).catch(() => undefined);
      throw new ErreurCourtier(code);
    };
    if (!bailDe(tenantId, c.bail)) throw new ErreurCourtier("coffre_indisponible");
    if (!Number.isFinite(c.dureeSecondes) || c.dureeSecondes < 1) return annuler("coffre_indisponible");
    if (c.dureeSecondes > DUREE_MAX_S) return annuler("duree_excessive");
    // Le bail s'éteint seul à l'heure ; si l'intervention finit avant, une révocation est posée à cette fin. L'échéance annoncée ne dépasse jamais la fin de l'intervention.
    const finBail = Math.min(maintenant.getTime() + c.dureeSecondes * 1000, i.fin.getTime());
    try {
      await p.bail.programmerRevocation(tenantId, c.bail, finBail - maintenant.getTime());
    } catch {
      return annuler("revocation_impossible");
    }
    const expire = new Date(finBail);
    p.journal.tracer({ evenement: "acces_humain_ouvert", tenantId, qui: q, motif: m, expire: expire.toISOString() });
    return { utilisateur: c.utilisateur, motDePasse: c.motDePasse, expire, lectureSeule: true };
  } finally {
    await rendre().catch(() => undefined);
  }
}

// Tâche différée de fin d'intervention : révoque le bail de CE client (un bail d'un autre rôle est refusé).
export async function revoquerBailHumain(p: Pick<PortsAccesHumain, "bail" | "journal">, tenantBrut: string, bail: string): Promise<void> {
  const tenantId = typeof tenantBrut === "string" ? tenantBrut.toLowerCase() : "";
  if (!UUID.test(tenantId) || !bailDe(tenantId, bail)) throw new ErreurCourtier("demande_invalide");
  await p.bail.revoquer(tenantId, bail);
  p.journal.tracer({ evenement: "acces_humain_revoque", tenantId });
}

// Rôle dynamique d'OpenBao d'un client (déclaré à la création du client, jamais par le jeton d'émission) : dérivé du seul UUID.
// NOINHERIT + CONNECTION LIMIT + statement_timeout positif + lecture seule ; rattaché à cli_<id>_lecture de ce client seul. La fin du bail coupe les sessions, retire les droits, supprime le rôle.
export function definitionRoleHumain(tenantId: string) {
  const base = nomBaseDe(tenantId);
  return {
    nom: `humain-lecture-${base}`,
    db_name: "donnees-1",
    creation_statements: [
      `CREATE ROLE "{{name}}" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}' NOINHERIT NOBYPASSRLS CONNECTION LIMIT 2;`,
      `ALTER ROLE "{{name}}" SET statement_timeout = '30s';`,
      `ALTER ROLE "{{name}}" SET default_transaction_read_only = on;`,
      `GRANT CONNECT ON DATABASE "${base}" TO "{{name}}";`,
      `GRANT "${base}_lecture" TO "{{name}}" WITH INHERIT TRUE;`,
    ],
    // Ordre : le rôle perd d'abord LOGIN (il ne peut plus se reconnecter, même si la suite échoue), puis ses sessions sont coupées, ses droits retirés, le rôle supprimé.
    revocation_statements: [
      `ALTER ROLE "{{name}}" NOLOGIN;`,
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '{{name}}';`,
      `REVOKE ALL ON DATABASE "${base}" FROM "{{name}}";`,
      `DROP ROLE IF EXISTS "{{name}}";`,
    ],
    default_ttl: "1h",
    max_ttl: "1h",
  };
}

// OpenBao : le chemin du rôle du client demandé et celui des baux de ce rôle. Le corps d'une réponse en erreur n'est jamais repris.
export function credsHumainOpenBao(o: { url: string; jeton: string; fetch?: typeof fetch }): PortsAccesHumain["creds"] & { revoquer(tenantId: string, bail: string): Promise<void> } {
  const appel = (chemin: string, methode: "GET" | "PUT") => (o.fetch ?? fetch)(`${o.url}/v1/${chemin}`, { method: methode, headers: { "X-Vault-Token": o.jeton }, redirect: "error", signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  const id = (t: string): string => {
    const tenantId = typeof t === "string" ? t.toLowerCase() : "";
    if (!UUID.test(tenantId)) throw new ErreurCourtier("demande_invalide");
    return tenantId;
  };
  return {
    async emettre(t) {
      const tenantId = id(t);
      const r = await appel(`database/creds/${nomRole(tenantId)}`, "GET");
      if (!r?.ok) throw new ErreurCourtier("coffre_indisponible");
      const c = (await r.json().catch(() => ({}))) as { lease_id?: unknown; lease_duration?: unknown; data?: { username?: unknown; password?: unknown } };
      const { username, password } = c.data ?? {};
      if (typeof username !== "string" || typeof password !== "string" || typeof c.lease_duration !== "number" || !bailDe(tenantId, c.lease_id)) throw new ErreurCourtier("coffre_indisponible");
      return { utilisateur: username, motDePasse: password, dureeSecondes: c.lease_duration, bail: c.lease_id };
    },
    async revoquer(t, bail) {
      const tenantId = id(t);
      if (!bailDe(tenantId, bail)) throw new ErreurCourtier("demande_invalide");
      const r = await appel(`sys/leases/revoke/${bail}`, "PUT");
      if (!r?.ok) throw new ErreurCourtier("coffre_indisponible");
    },
  };
}

// ---- Révocation de tous les baux humains d'un client (rotation immédiate, A-209) ----
// File des révocations différées : le port bail.programmerRevocation dépose une tâche d'identifiant DÉRIVÉ du bail (revocation-humain-<nomBase>-<suffixe>).
// La rotation retrouve ainsi les baux vivants de CE client sans nouveau stockage. Forme structurelle d'une file BullMQ, sans importer bullmq.
export const MAX_BAUX_LISTES = 500;
export const ESSAIS_REVOCATION = 3;
export const DELAI_REVOCATION_MS = 5000;
const ETATS_ATTENTE = ["delayed", "waiting", "paused", "prioritized"];
export interface TacheRevocation { id?: string | undefined; data?: unknown; remove(): Promise<unknown> }
export interface FileRevocations {
  add(nom: string, donnees: { tenantId: string; bail: string }, options: Record<string, unknown>): Promise<unknown>;
  getJobs(types: string[], debut?: number, fin?: number): Promise<TacheRevocation[]>;
}
export interface BilanRevocation { revoques: number; etrangers: number; echecs: number; complet: boolean }
export interface PortsRevocationHumaine {
  bail: { revoquer(tenantId: string, bail: string): Promise<void> };
  taches: { lister(tenantId: string, max: number): Promise<{ taches: TacheRevocation[]; complet: boolean }> };
  journal: Journal;
}
const prefixeRevocation = (tenantId: string): string => `revocation-humain-${nomBaseDe(tenantId)}-`;
// Le suffixe du bail est [A-Za-z0-9]{8,64} : l'identifiant n'a ni deux-points, ni barre, ni point.
export function idTacheRevocationHumaine(tenantId: string, bail: string): string {
  const id = typeof tenantId === "string" ? tenantId.toLowerCase() : "";
  if (!UUID.test(id) || !bailDe(id, bail)) throw new ErreurCourtier("demande_invalide");
  return `${prefixeRevocation(id)}${bail.slice(`database/creds/${nomRole(id)}/`.length)}`;
}
export function revocationsParFile(file: FileRevocations): { programmerRevocation: PortsAccesHumain["bail"]["programmerRevocation"] } & PortsRevocationHumaine["taches"] {
  return {
    async programmerRevocation(tenantId, bail, delaiMs) {
      const jobId = idTacheRevocationHumaine(tenantId, bail);
      // La charge ne porte que le client et le bail : jamais un mot de passe.
      await file.add("revocation-humaine", { tenantId: tenantId.toLowerCase(), bail }, { jobId, delay: Math.max(0, Math.floor(delaiMs)), removeOnComplete: true });
    },
    async lister(tenantId, max) {
      const id = typeof tenantId === "string" ? tenantId.toLowerCase() : "";
      if (!UUID.test(id)) throw new ErreurCourtier("demande_invalide");
      const brut = await file.getJobs(ETATS_ATTENTE, 0, max - 1);
      const prefixe = prefixeRevocation(id);
      // Fenêtre pleine : d'autres tâches ont pu rester hors de la liste, le résultat n'est pas complet.
      return { taches: brut.filter((t) => typeof t.id === "string" && t.id.startsWith(prefixe)), complet: brut.length < max };
    },
  };
}

const borner = <T>(travail: Promise<T>): Promise<T> =>
  new Promise<T>((ok, ko) => {
    const minuteur = setTimeout(() => ko(new Error("delai")), DELAI_REVOCATION_MS);
    travail.then((v) => { clearTimeout(minuteur); ok(v); }, (e: unknown) => { clearTimeout(minuteur); ko(e); });
  });

// Révoque tous les baux humains vivants de CE client. Ne prend JAMAIS le verrou (la rotation le tient déjà). Les traces ne portent que des nombres et le tenantId.
// Chaque bail est revalidé par bailDe(tenantId, …) ET par son identifiant dérivé : une tâche d'un autre client est ignorée et tracée, jamais révoquée ni retirée.
// La tâche n'est retirée qu'après une révocation réussie. Trois passes de 5 s au plus par appel ; ensuite le bilan dit « incomplet ».
export async function revoquerTousBauxHumains(p: PortsRevocationHumaine, tenantBrut: string): Promise<BilanRevocation> {
  const tenantId = typeof tenantBrut === "string" ? tenantBrut.toLowerCase() : "";
  if (!UUID.test(tenantId)) throw new ErreurCourtier("demande_invalide");
  let liste: Awaited<ReturnType<PortsRevocationHumaine["taches"]["lister"]>>;
  try {
    liste = await p.taches.lister(tenantId, MAX_BAUX_LISTES);
  } catch {
    p.journal.tracer({ evenement: "revocation_humaine_liste_impossible", tenantId });
    return { revoques: 0, etrangers: 0, echecs: 1, complet: false };
  }
  const prefixe = prefixeRevocation(tenantId);
  let etrangers = 0;
  let restants: { bail: string; tache: TacheRevocation }[] = [];
  for (const tache of liste.taches) {
    const id = typeof tache.id === "string" ? tache.id : "";
    const bail = (tache.data as { bail?: unknown } | null | undefined)?.bail;
    if (id.startsWith(prefixe) && bailDe(tenantId, bail) && idTacheRevocationHumaine(tenantId, bail) === id) restants.push({ bail, tache });
    else {
      etrangers++;
      p.journal.tracer({ evenement: "bail_etranger", tenantId });
    }
  }
  let revoques = 0;
  for (let passe = 0; passe < ESSAIS_REVOCATION && restants.length > 0; passe++) {
    const encore: typeof restants = [];
    for (const r of restants) {
      try {
        await borner(p.bail.revoquer(tenantId, r.bail));
      } catch {
        encore.push(r);
        continue;
      }
      revoques++;
      await r.tache.remove().catch(() => p.journal.tracer({ evenement: "tache_revocation_non_retiree", tenantId }));
    }
    restants = encore;
  }
  const bilan = { revoques, etrangers, echecs: restants.length, complet: liste.complet && liste.taches.length < MAX_BAUX_LISTES && restants.length === 0 };
  p.journal.tracer({ evenement: "revocation_humaine_bilan", tenantId, revoques, etrangers, echecs: bilan.echecs, complet: bilan.complet });
  return bilan;
}
