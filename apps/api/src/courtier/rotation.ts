import { ErreurApi } from "../plugins/erreurs.js";
import type { SessionEquipe } from "../gel/gel.js";
import { nomBaseDe, nomsRoles, type Sql } from "../provisionnement/etapes-base.js";
import type { LigneBase, Verrou } from "../provisionnement/machine.js";
import { ErreurCourtier, type Journal } from "./identifiants-base.js";
import { ESSAIS_REVOCATION, type BilanRevocation } from "./acces-humain.js";

// Rotation du mot de passe de cli_<id>_app puis de cli_<id>_lecture (A-169, A-209). Choix de l'ADR 0046 (« Rotation ») : un seul rôle fixe, VALID UNTIL comme filet, jamais deux rôles alternés.
// Ordre : le coffre reçoit le nouveau mot de passe (nouvelle version KV), PUIS le rôle reçoit l'empreinte et la version notée. Le rôle n'est jamais recréé (A-417).
export const PERIODE_DEFAUT_JOURS = 30;
export const DELAI_GRACE_MS = 10 * 60_000;
const JOUR_MS = 86_400_000;
const EMPREINTE = /^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;
export const ESSAIS_ROTATION = 5;
const OPTIONS = { attempts: ESSAIS_ROTATION, backoff: { type: "exponential" as const, delay: 5000 }, removeOnComplete: true } as const;

export function periodeDe(date: Date, jours: number): number {
  if (!Number.isInteger(jours) || jours < 1) throw new Error("période invalide");
  return Math.floor(date.getTime() / (jours * JOUR_MS));
}
// Pas de deux-points dans un jobId BullMQ ; une tâche par base et par période.
export const idTacheRotation = (tenantId: string, periode: number): string => `rotation-${nomBaseDe(tenantId.toLowerCase())}-${periode}`;

export interface FileRotation {
  getJob(id: string): Promise<{ getState(): Promise<string>; remove(): Promise<void> } | undefined>;
  add(nom: string, donnees: { tenantId: string }, options: Record<string, unknown>): Promise<unknown>;
}
// La charge ne porte que le tenantId : jamais un mot de passe ni un chemin de coffre.
export async function deposerRotation(file: FileRotation, tenantId: string, maintenant: Date, jours: number): Promise<void> {
  const id = idTacheRotation(tenantId, periodeDe(maintenant, jours));
  const existante = await file.getJob(id);
  if (existante) {
    const etat = await existante.getState();
    if (etat !== "failed" && etat !== "completed") return;
    await existante.remove();
  }
  await file.add("rotation", { tenantId: tenantId.toLowerCase() }, { ...OPTIONS, jobId: id });
}

export interface AdminRotation { changerMotDePasse(role: string, empreinte: string, version: number, validJusqua: Date): Promise<void> }
export interface SessionsBase {
  couper(nomBase: string, role: string): Promise<void>;
  // Filet, lecture seule : membres de cli_<id>_lecture encore capables de se connecter et sessions ouvertes de ces membres. Il observe, il n'agit pas.
  restants(nomBase: string): Promise<{ membres: number; sessions: number }>;
}
export interface PortsRotation {
  // Coupe les sessions ouvertes de la base (PgBouncer puis base), pour la rotation immédiate.
  sessions(grappe: string): SessionsBase;
  // Alerte vers l'équipe : un code et des identifiants, jamais une valeur secrète.
  alerte: { envoyer(e: { evenement: string; tenantId: string; base: string; essais: number; code: string }): Promise<void> };
  base(tenantId: string): Promise<{ etat: LigneBase["etat"]; grappe: string; nomBase: string } | undefined>;
  admin(grappe: string): AdminRotation;
  coffre: { ranger(chemin: string, valeur: string): Promise<number> };
  bouncer(grappe: string): { reconnecter(nomBase: string): Promise<void> };
  verrou: Verrou;
  // Rotation immédiate : révoque tous les baux humains de CE client (revoquerTousBauxHumains, jeton HUMAINS). Obligatoire : jamais d'oubli silencieux.
  humains: { revoquerTous(tenantId: string): Promise<BilanRevocation> };
  motDePasse(): string;
  empreinte(motDePasse: string): string;
  journal: Journal;
  maintenant(): Date;
  periodeJours: number;
}

// Adaptateur SQL (connexion directe, jamais PgBouncer) : ALTER ROLE seulement. Un rôle absent est refusé, jamais créé ; les limites posées par la recette restent.
export function adminRotationPg(sql: Pick<Sql, "requete">): AdminRotation {
  return {
    async changerMotDePasse(role, empreinte, version, validJusqua) {
      if (!/^cli_[0-9a-f]{12}_(app|lecture)$/.test(role) || !EMPREINTE.test(empreinte) || !Number.isInteger(version) || version < 1 || version > 999999999 || Number.isNaN(validJusqua.getTime())) throw new Error("refusé");
      if ((await sql.requete("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).length === 0) throw new ErreurCourtier("role_absent");
      const q = (await sql.requete<{ q: string }>("SELECT quote_ident($1) AS q", [role]))[0]!.q;
      const lit = async (v: string) => (await sql.requete<{ lit: string }>("SELECT quote_literal($1) AS lit", [v]))[0]!.lit;
      await sql.requete(`ALTER ROLE ${q} PASSWORD ${await lit(empreinte)} VALID UNTIL ${await lit(validJusqua.toISOString())}`);
      await sql.requete(`COMMENT ON ROLE ${q} IS 'secret:v${version}'`);
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOM_BASE = /^cli_[0-9a-f]{12}$/;
// Connexion directe à la grappe (pg_terminate_backend) et console d'administration de PgBouncer (KILL puis RESUME). Noms validés avant tout ordre ; la base n'est jamais laissée en pause.
// Sont coupés : le rôle _app, le rôle _lecture (donc aussi les lectures en cours de la console) et les rôles dynamiques (accès humain) rattachés à cli_<id>_lecture.
export function sessionsPg(grappe: Pick<Sql, "requete">, bouncer: Pick<Sql, "requete">): SessionsBase {
  return {
    async couper(nomBase, role) {
      if (!NOM_BASE.test(nomBase) || role !== `${nomBase}_app`) throw new Error("nom refusé");
      // Les deux coupures sont toujours tentées et RESUME aussi (la base n'est jamais laissée en pause) ; la première erreur remonte.
      let echec: { e: unknown } | undefined;
      try { await bouncer.requete(`KILL ${nomBase}`); } catch (e) { echec = { e }; }
      try {
        await grappe.requete(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND (usename = $1 OR usename = $2 OR usename IN (SELECT m.rolname FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE r.rolname = $2))",
          [role, `${nomBase}_lecture`],
        );
      } catch (e) {
        echec ??= { e };
      } finally {
        try { await bouncer.requete(`RESUME ${nomBase}`); } catch (e) { echec ??= { e }; }
      }
      if (echec) throw echec.e;
    },
    // Lecture seule, requête paramétrée. Seuls comptent les membres qui peuvent hériter ou prendre le rôle : un membre ADMIN seul (gestionnaire d'OpenBao, provisionneur) n'ouvre aucun accès aux données.
    async restants(nomBase) {
      if (!NOM_BASE.test(nomBase)) throw new Error("nom refusé");
      const membres = "SELECT m.rolname FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE r.rolname = $1 AND m.rolcanlogin AND (a.inherit_option OR a.set_option)";
      const lignes = await grappe.requete<{ membres: number | string; sessions: number | string }>(
        `SELECT (SELECT count(*) FROM (${membres}) x)::int AS membres, (SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND usename IN (${membres}))::int AS sessions`,
        [`${nomBase}_lecture`],
      );
      return { membres: Number(lignes[0]?.membres ?? 0), sessions: Number(lignes[0]?.sessions ?? 0) };
    },
  };
}

export function creerRotation(p: PortsRotation) {
  // Coupe les sessions (_app et _lecture, même coupure) ; trace le résultat, jamais de mot de passe. Renvoie vrai si la coupure a réussi.
  async function couper(id: string, grappe: string, acteur: string): Promise<boolean> {
    try {
      await p.sessions(grappe).couper(nomBaseDe(id), nomsRoles(id).app);
    } catch {
      p.journal.tracer({ evenement: "sessions_non_coupees", tenantId: id, acteur });
      try {
        await p.alerte.envoyer({ evenement: "sessions_non_coupees", tenantId: id, base: nomBaseDe(id), essais: 0, code: "coupure_echouee" });
      } catch {
        p.journal.tracer({ evenement: "alerte_non_envoyee", tenantId: id });
      }
      return false;
    }
    p.journal.tracer({ evenement: "sessions_coupees", tenantId: id, acteur });
    return true;
  }
  // Rotation immédiate, SOUS LE VERROU : révocation de tous les baux humains du client (seule voie d'action : le coffre ; NOLOGIN et REVOKE sur un rôle dynamique demandent l'option ADMIN), puis filet en lecture seule.
  // Rend vrai si quelque chose reste ouvert ou n'a pu être vérifié : trace (nombres seulement) et alerte (code seul, ni nom de rôle ni bail). Le pivot n'est jamais annulé.
  async function fermerAccesHumains(id: string, grappe: string): Promise<boolean> {
    const nomBase = nomBaseDe(id);
    let bilan: BilanRevocation;
    try {
      bilan = await p.humains.revoquerTous(id);
    } catch {
      bilan = { revoques: 0, etrangers: 0, echecs: 1, complet: false };
    }
    let restants = 0;
    let verifie = true;
    try {
      const r = await p.sessions(grappe).restants(nomBase);
      restants = r.membres + r.sessions;
    } catch {
      verifie = false;
    }
    const incomplet = !bilan.complet || !verifie || restants > 0;
    if (incomplet) {
      p.journal.tracer({ evenement: "roles_dynamiques_restants", tenantId: id, nombre: restants, echecs: bilan.echecs });
      try {
        await p.alerte.envoyer({ evenement: "roles_dynamiques_restants", tenantId: id, base: nomBase, essais: ESSAIS_REVOCATION, code: "revocation_incomplete" });
      } catch {
        p.journal.tracer({ evenement: "alerte_non_envoyee", tenantId: id });
      }
    }
    return incomplet;
  }
  // `incident` : rotation immédiate. Si un rôle échoue après que _app a été touché, les sessions ouvertes sont coupées quand même, sous le verrou, puis l'échec d'origine remonte.
  async function executer(tenantId: string, file: Pick<FileRotation, "add">, incident?: { acteur: string }): Promise<"occupe" | { coupee: boolean; incomplet: boolean }> {
    const id = tenantId.toLowerCase();
    const nomBase = nomBaseDe(id);
    const ligne = await p.base(id);
    // Une base à l'écart ou gelée se renouvelle aussi (incident) ; une base en création ou effacée, jamais.
    if (!ligne || !["active", "gelee", "a_l_ecart", "exportee"].includes(ligne.etat)) throw new ErreurCourtier("base_non_pivotable");
    const rendre = await p.verrou.prendre(id);
    if (!rendre) return "occupe";
    try {
      // Chaque rôle a son secret, sa version notée et son VALID UNTIL. Ordre : _app puis _lecture, sous le même verrou ; coffre d'abord, rôle ensuite.
      // Filet : sans nouvelle rotation, le mot de passe s'éteint seul au bout de deux périodes.
      const validJusqua = new Date(p.maintenant().getTime() + 2 * p.periodeJours * JOUR_MS);
      const roles = nomsRoles(id);
      let version = 0;
      let appTouche = false;
      try {
        for (const genre of ["app", "lecture"] as const) {
          const motDePasse = p.motDePasse();
          const v = await p.coffre.ranger(`technique/donnees/${nomBase}/${genre}`, motDePasse).catch(() => { throw new ErreurCourtier("coffre_indisponible"); });
          if (genre === "app") version = v;
          // Dès l'ordre envoyé pour _app, l'ancien identifiant peut ne plus valoir : on le suppose changé.
          if (genre === "app") appTouche = true;
          await p.admin(ligne.grappe).changerMotDePasse(roles[genre], p.empreinte(motDePasse), v, validJusqua).catch((e: unknown) => {
            if (genre === "app" && e instanceof ErreurCourtier && e.code === "role_absent") appTouche = false;
            throw new ErreurCourtier(e instanceof ErreurCourtier ? e.code : "role_echoue");
          });
        }
      } catch (e) {
        if (incident && appTouche) {
          // Échec partiel : les sessions portent peut-être l'ancien identifiant. Coupure et reconnexion en file, puis l'échec d'origine remonte (la base n'est jamais laissée en pause).
          await couper(id, ligne.grappe, incident.acteur);
          await fermerAccesHumains(id, ligne.grappe);
          await file.add("reconnecter", { tenantId: id }, { jobId: `reconnect-${nomBase}-${version}`, delay: DELAI_GRACE_MS, removeOnComplete: true }).catch(() => undefined);
        }
        throw e;
      }
      // Incident, toujours sous le verrou : coupure des sessions (échec visible, jamais silencieux), puis baux humains, puis filet. Un bail émis entre-temps est refusé par ouvrirAccesHumain (même verrou).
      // Rotation planifiée : rien de tout cela. Les baux humains d'une heure expirent seuls, et la planifiée n'a pas de motif d'incident.
      const apres = incident ? { coupee: await couper(id, ligne.grappe, incident.acteur), incomplet: await fermerAccesHumains(id, ligne.grappe) } : { coupee: true, incomplet: false };
      // Grâce : les connexions déjà ouvertes durent 10 minutes, puis PgBouncer reconnecte la base (tâche différée, une par version).
      await file.add("reconnecter", { tenantId: id }, { jobId: `reconnect-${nomBase}-${version}`, delay: DELAI_GRACE_MS, removeOnComplete: true });
      p.journal.tracer({ evenement: "rotation_faite", tenantId: id, base: nomBase, version });
      return apres;
    } finally {
      await rendre().catch(() => undefined);
    }
  }
  return {
    async pourBase(tenantId: string, file: Pick<FileRotation, "add">, incident?: { acteur: string }): Promise<"faite" | "occupe"> {
      return (await executer(tenantId, file, incident)) === "occupe" ? "occupe" : "faite";
    },
    async reconnecter(tenantId: string): Promise<void> {
      const id = tenantId.toLowerCase();
      const ligne = await p.base(id);
      if (!ligne) throw new ErreurCourtier("base_non_pivotable");
      await p.bouncer(ligne.grappe).reconnecter(nomBaseDe(id));
    },
    // Incident : équipe réauthentifiée (T1A-08), client actif de la session, personne identifiée, motif écrit. La trace ne porte aucune valeur.
    async immediate(tenantId: string, motif: string, s: SessionEquipe, file: Pick<FileRotation, "add">): Promise<"faite" | "occupe" | "revocation_incomplete"> {
      if (!s.reauthentifie) throw new ErreurApi("reauthentification_requise", "Reconnectez-vous pour continuer.");
      if (s.role !== "administrateur") throw new ErreurApi("action_interdite", "Action réservée à l'administrateur.");
      const acteur = s.acteur.trim();
      if (s.clientActifId.toLowerCase() !== tenantId.toLowerCase() || acteur === "" || acteur.toLowerCase() === "systeme") throw new ErreurApi("action_interdite", "Action interdite.");
      const m = typeof motif === "string" ? motif.trim() : "";
      if (m === "" || m.length > 500) throw new ErreurApi("schema_invalide", "Requête invalide.");
      p.journal.tracer({ evenement: "rotation_immediate", tenantId: tenantId.toLowerCase(), acteur, motif: m });
      const r = await executer(tenantId, file, { acteur });
      if (r === "occupe") {
        // Une rotation planifiée tient le verrou : rien n'a changé, donc couper maintenant ne servirait à rien (l'ancien mot de passe reste valable). La demande échoue de façon visible : trace, alerte, code.
        const id = tenantId.toLowerCase();
        p.journal.tracer({ evenement: "rotation_immediate_non_faite", tenantId: id, acteur });
        try {
          await p.alerte.envoyer({ evenement: "rotation_immediate_non_faite", tenantId: id, base: nomBaseDe(id), essais: 0, code: "rotation_occupee" });
        } catch {
          p.journal.tracer({ evenement: "alerte_non_envoyee", tenantId: id });
        }
        throw new ErreurCourtier("rotation_occupee");
      }
      // Les sessions ouvertes avant le changement ont été coupées et les baux humains révoqués sous le verrou (échec de coupure : visible, jamais silencieux).
      if (!r.coupee) throw new ErreurCourtier("coupure_echouee");
      return r.incomplet ? "revocation_incomplete" : "faite";
    },
    // Écouteur « failed » de la file : après le dernier essai, une alerte part (code seul). Une alerte qui échoue est tracée et lève : la panne reste visible.
    async surEchec(tache: { name?: string; data?: { tenantId?: unknown }; attemptsMade: number; opts: { attempts?: number } }, erreur: unknown): Promise<void> {
      if (tache.name !== "rotation" || tache.attemptsMade < (tache.opts.attempts ?? ESSAIS_ROTATION)) return;
      // Un tenantId absent ou mal formé ne doit jamais faire perdre l'alerte : nomBaseDe lèverait hors du try.
      const brut = (tache.data as { tenantId?: unknown } | undefined)?.tenantId;
      const valide = typeof brut === "string" && UUID.test(brut.toLowerCase());
      const tenantId = valide ? brut.toLowerCase() : "invalide";
      const code = erreur instanceof ErreurCourtier || (typeof erreur === "object" && erreur !== null && typeof (erreur as { code?: unknown }).code === "string") ? String((erreur as { code: string }).code) : "inconnu";
      try {
        await p.alerte.envoyer({ evenement: "rotation_echec_definitif", tenantId, base: valide ? nomBaseDe(tenantId) : "inconnue", essais: tache.attemptsMade, code: /^[a-z0-9_.-]{1,64}$/.test(code) ? code : "inconnu" });
      } catch {
        p.journal.tracer({ evenement: "alerte_non_envoyee", tenantId });
        throw new ErreurCourtier("alerte_non_envoyee");
      }
    },
  };
}
