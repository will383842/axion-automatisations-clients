// Machine à états du provisionnement d'une base client (A-213, A-224). L'état vit dans bases_client (T2-30) : la tâche BullMQ ne porte que le tenantId.
// Chaque étape se rejoue : dejaFait lit l'état RÉEL (base, rôles, secrets, PgBouncer), le numéro enregistré ne suffit pas.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ESSAIS_MAX = 5;
// BullMQ refuse un jobId à deux-points (sauf trois parties) : tiret à la place de « provision: ».
export const OPTIONS_TACHE = { attempts: ESSAIS_MAX, backoff: { type: "exponential" as const, delay: 5000 }, removeOnComplete: true } as const;
// Un UUID en majuscules est le même client : on range tout en minuscules avant de valider (sinon l'erreur sortirait avant le try, sans code ni alerte).
export const normaliser = (tenantId: unknown): string => (typeof tenantId === "string" ? tenantId.toLowerCase() : "");
export function idTacheProvisionnement(tenantId: string): string {
  const id = normaliser(tenantId);
  if (!UUID.test(id)) throw new Error("tenantId invalide");
  return `provision-${id}`;
}
// Verrou par client tenu pendant toute l'exécution : une tâche « stalled » reprise par un autre travailleur ne chevauche pas la première.
export interface Verrou { prendre(tenantId: string): Promise<(() => Promise<void>) | undefined> }
// Adaptateur PostgreSQL : verrou consultatif de SESSION sur une connexion dédiée (jamais PgBouncer en mode transaction), rendu par pg_advisory_unlock ou à la mort de la connexion.
export function verrouConsultatif(ouvrir: () => Promise<{ query(texte: string, valeurs: unknown[]): Promise<{ rows: { ok: boolean }[] }>; release(): void }>): Verrou {
  return {
    async prendre(tenantId) {
      const c = await ouvrir();
      try {
        const cle = `provision-${tenantId}`;
        if ((await c.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [cle])).rows[0]?.ok !== true) { c.release(); return undefined; }
        return async () => { try { await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS ok", [cle]); } finally { c.release(); } };
      } catch (e) { c.release(); throw e; }
    },
  };
}

export interface LigneBase {
  etat: "en_creation" | "active" | "gelee" | "exportee" | "a_l_ecart" | "effacee";
  etape: number;
  grappe: string;
  nomBase: string;
}
export interface Registre {
  lire(tenantId: string): Promise<LigneBase | undefined>;
  enregistrerEtape(tenantId: string, numero: number): Promise<void>;
  noterErreur(tenantId: string, code: string): Promise<void>;
}
export interface AlerteProvisionnement {
  type: "provisionnement_echec";
  clientId: string;
  code: string;
}
export interface AlertesProvisionnement { envoyer(alerte: AlerteProvisionnement): Promise<void> }
export interface Etape<C> {
  numero: number;
  nom: string;
  faire(ctx: C): Promise<void>;
  dejaFait(ctx: C): Promise<boolean>;
}
// Seul le code d'une ErreurEtape est rangé et alerté ; le texte de toute autre erreur (qui pourrait contenir une valeur) ne sort jamais.
export class ErreurEtape extends Error {
  constructor(readonly code: string) {
    super(code);
    if (!/^[a-z0-9_.-]{1,64}$/.test(code)) throw new Error("code d'erreur invalide");
  }
}

export interface OptionsMachine<C> {
  etapes: Etape<C>[];
  registre: Registre;
  alertes: AlertesProvisionnement;
  contexte(tenantId: string, ligne: LigneBase): C;
  verrou?: Verrou;
}
export type Resultat = "a_jour" | "ignore" | "ligne_absente" | "occupe";

export function creerMachine<C>(o: OptionsMachine<C>) {
  async function echec(tenantId: string, code: string): Promise<void> {
    await o.registre.noterErreur(tenantId, code);
    await o.alertes.envoyer({ type: "provisionnement_echec", clientId: tenantId, code });
  }
  return {
    async executer(brut: string): Promise<Resultat> {
      const tenantId = normaliser(brut);
      if (!UUID.test(tenantId)) throw new Error("tenantId invalide");
      const rendre = o.verrou ? await o.verrou.prendre(tenantId) : async () => undefined;
      if (!rendre) return "occupe";
      try {
        return await executerSousVerrou(tenantId);
      } finally {
        await rendre().catch(() => undefined);
      }
    },
  };
  async function executerSousVerrou(tenantId: string): Promise<Resultat> {
    const ligne = await o.registre.lire(tenantId);
    if (!ligne) {
      await o.alertes.envoyer({ type: "provisionnement_echec", clientId: tenantId, code: "ligne_absente" });
      return "ligne_absente";
    }
    // Une base déjà active (bon de commande complémentaire) ne relance aucune création.
    if (ligne.etat !== "en_creation") return "ignore";
    try {
      const ctx = o.contexte(tenantId, ligne);
      for (const etape of o.etapes) {
        if (!(await etape.dejaFait(ctx))) await etape.faire(ctx);
        await o.registre.enregistrerEtape(tenantId, etape.numero);
      }
    } catch (erreur) {
      const code = erreur instanceof ErreurEtape ? erreur.code : "erreur_inattendue";
      await echec(tenantId, code);
      throw new ErreurEtape(code);
    }
    return "a_jour";
  }
}
