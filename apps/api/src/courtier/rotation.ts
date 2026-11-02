import { ErreurApi } from "../plugins/erreurs.js";
import type { SessionEquipe } from "../gel/gel.js";
import { nomBaseDe, nomsRoles, type Sql } from "../provisionnement/etapes-base.js";
import type { LigneBase, Verrou } from "../provisionnement/machine.js";
import { ErreurCourtier, type Journal } from "./identifiants-base.js";

// Rotation du mot de passe de cli_<id>_app (A-169). Choix de l'ADR 0046 (« Rotation ») : un seul rôle fixe, VALID UNTIL comme filet, jamais deux rôles alternés.
// Ordre : le coffre reçoit le nouveau mot de passe (nouvelle version KV), PUIS le rôle reçoit l'empreinte et la version notée. Le rôle n'est jamais recréé (A-417).
export const PERIODE_DEFAUT_JOURS = 30;
export const DELAI_GRACE_MS = 10 * 60_000;
const JOUR_MS = 86_400_000;
const EMPREINTE = /^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;
const OPTIONS = { attempts: 5, backoff: { type: "exponential" as const, delay: 5000 }, removeOnComplete: true } as const;

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
export interface PortsRotation {
  base(tenantId: string): Promise<{ etat: LigneBase["etat"]; grappe: string; nomBase: string } | undefined>;
  admin(grappe: string): AdminRotation;
  coffre: { ranger(chemin: string, valeur: string): Promise<number> };
  bouncer(grappe: string): { reconnecter(nomBase: string): Promise<void> };
  verrou: Verrou;
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
      if (!/^cli_[0-9a-f]{12}_app$/.test(role) || !EMPREINTE.test(empreinte) || !Number.isInteger(version) || version < 1 || version > 999999999 || Number.isNaN(validJusqua.getTime())) throw new Error("refusé");
      if ((await sql.requete("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).length === 0) throw new ErreurCourtier("role_absent");
      const q = (await sql.requete<{ q: string }>("SELECT quote_ident($1) AS q", [role]))[0]!.q;
      const lit = async (v: string) => (await sql.requete<{ lit: string }>("SELECT quote_literal($1) AS lit", [v]))[0]!.lit;
      await sql.requete(`ALTER ROLE ${q} PASSWORD ${await lit(empreinte)} VALID UNTIL ${await lit(validJusqua.toISOString())}`);
      await sql.requete(`COMMENT ON ROLE ${q} IS 'secret:v${version}'`);
    },
  };
}

export function creerRotation(p: PortsRotation) {
  async function pivoter(tenantId: string, file: Pick<FileRotation, "add">): Promise<"faite" | "occupe"> {
    const id = tenantId.toLowerCase();
    const nomBase = nomBaseDe(id);
    const ligne = await p.base(id);
    // Une base à l'écart ou gelée se renouvelle aussi (incident) ; une base en création ou effacée, jamais.
    if (!ligne || !["active", "gelee", "a_l_ecart", "exportee"].includes(ligne.etat)) throw new ErreurCourtier("base_non_pivotable");
    const rendre = await p.verrou.prendre(id);
    if (!rendre) return "occupe";
    try {
      const motDePasse = p.motDePasse();
      const version = await p.coffre.ranger(`technique/donnees/${nomBase}/app`, motDePasse).catch(() => { throw new ErreurCourtier("coffre_indisponible"); });
      // Filet : sans nouvelle rotation, le mot de passe s'éteint seul au bout de deux périodes.
      const validJusqua = new Date(p.maintenant().getTime() + 2 * p.periodeJours * JOUR_MS);
      await p.admin(ligne.grappe).changerMotDePasse(nomsRoles(id).app, p.empreinte(motDePasse), version, validJusqua).catch((e: unknown) => { throw new ErreurCourtier(e instanceof ErreurCourtier ? e.code : "role_echoue"); });
      // Grâce : les connexions déjà ouvertes durent 10 minutes, puis PgBouncer reconnecte la base (tâche différée, une par version).
      await file.add("reconnecter", { tenantId: id }, { jobId: `reconnect-${nomBase}-${version}`, delay: DELAI_GRACE_MS, removeOnComplete: true });
      p.journal.tracer({ evenement: "rotation_faite", tenantId: id, base: nomBase, version });
      return "faite";
    } finally {
      await rendre().catch(() => undefined);
    }
  }
  return {
    pourBase: pivoter,
    async reconnecter(tenantId: string): Promise<void> {
      const id = tenantId.toLowerCase();
      const ligne = await p.base(id);
      if (!ligne) throw new ErreurCourtier("base_non_pivotable");
      await p.bouncer(ligne.grappe).reconnecter(nomBaseDe(id));
    },
    // Incident : équipe réauthentifiée (T1A-08), client actif de la session, personne identifiée, motif écrit. La trace ne porte aucune valeur.
    async immediate(tenantId: string, motif: string, s: SessionEquipe, file: Pick<FileRotation, "add">): Promise<"faite" | "occupe"> {
      if (!s.reauthentifie) throw new ErreurApi("reauthentification_requise", "Reconnectez-vous pour continuer.");
      if (s.role !== "administrateur") throw new ErreurApi("action_interdite", "Action réservée à l'administrateur.");
      const acteur = s.acteur.trim();
      if (s.clientActifId.toLowerCase() !== tenantId.toLowerCase() || acteur === "" || acteur.toLowerCase() === "systeme") throw new ErreurApi("action_interdite", "Action interdite.");
      const m = typeof motif === "string" ? motif.trim() : "";
      if (m === "" || m.length > 500) throw new ErreurApi("schema_invalide", "Requête invalide.");
      p.journal.tracer({ evenement: "rotation_immediate", tenantId: tenantId.toLowerCase(), acteur, motif: m });
      return pivoter(tenantId, file);
    },
  };
}
