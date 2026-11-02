// Machine à états du provisionnement d'une base client (A-213, A-224). L'état vit dans bases_client (T2-30) : la tâche BullMQ ne porte que le tenantId.
// Chaque étape se rejoue : dejaFait lit l'état RÉEL (base, rôles, secrets, PgBouncer), le numéro enregistré ne suffit pas.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ESSAIS_MAX = 5;
// BullMQ refuse un jobId à deux-points (sauf trois parties) : tiret à la place de « provision: ».
export const OPTIONS_TACHE = { attempts: ESSAIS_MAX, backoff: { type: "exponential" as const, delay: 5000 }, removeOnComplete: true } as const;
export function idTacheProvisionnement(tenantId: string): string {
  if (!UUID.test(tenantId)) throw new Error("tenantId invalide");
  return `provision-${tenantId}`;
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
export interface AlertesProvisionnement {
  envoyer(alerte: AlerteProvisionnement): Promise<void>;
}
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
}
export type Resultat = "a_jour" | "ignore" | "ligne_absente";

export function creerMachine<C>(o: OptionsMachine<C>) {
  async function echec(tenantId: string, code: string): Promise<void> {
    await o.registre.noterErreur(tenantId, code);
    await o.alertes.envoyer({ type: "provisionnement_echec", clientId: tenantId, code });
  }
  return {
    async executer(tenantId: string): Promise<Resultat> {
      if (!UUID.test(tenantId)) throw new Error("tenantId invalide");
      const ligne = await o.registre.lire(tenantId);
      if (!ligne) {
        await o.alertes.envoyer({ type: "provisionnement_echec", clientId: tenantId, code: "ligne_absente" });
        return "ligne_absente";
      }
      // Une base déjà active (bon de commande complémentaire) ne relance aucune création.
      if (ligne.etat !== "en_creation") return "ignore";
      const ctx = o.contexte(tenantId, ligne);
      try {
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
    },
  };
}
