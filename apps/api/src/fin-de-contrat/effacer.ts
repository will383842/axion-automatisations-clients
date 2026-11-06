import { exigerAucunGel, GelPourLitige } from "../gel/garde.js";
import type { GelLitige } from "../retention/purger.js";
import { doubleValidationAtteinte, type Validation } from "./mettre-a-l-ecart.js";

// Effacement exceptionnel d'un client (C-623, C-715). Aucune route directe, aucune étape planifiée par date : ce gestionnaire ne part que d'un événement
// d'acceptation mis en file par un clic de Will (decision-proposition.ts, demande-effacement.ts). Livré FERME : `actif` vient de EFFACEMENT_ACTIF (config.ts).
// Les factures, contrats, preuves, journaux de connexion et le journal d'audit ne sont jamais touchés.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Ce que le gestionnaire relit EN BASE au moment d'agir : le client vient de cette ligne, jamais du message de la file.
export interface Source { genre: "proposition" | "demande"; id: string; tenantId: string; etat: string; validations: Validation[]; exportRemis: boolean }
export interface TxEffacement {
  source(genre: "proposition" | "demande", id: string): Promise<Source | undefined>;
  etatBase(tenantId: string): Promise<string | undefined>;
  gelActif(tenantId: string): Promise<boolean>;
}
type Pas = (tenantId: string) => Promise<void>;
// Chaque pas est rejouable (provisionneur, stockage d'objets, coffre, rôles). `executee` n'est posé qu'après tous les pas.
export interface PortsEffacement {
  actif(): boolean;
  gel: Pick<GelLitige, "gelActif">;
  transaction<T>(fn: (tx: TxEffacement) => Promise<T>): Promise<T>;
  supprimerBase: Pas;
  retirerCompartiment: Pas;
  detruireCleClient: Pas;
  purgerCoffre: Pas;
  supprimerRoles: Pas;
  marquerEffacee: Pas;
  marquerExecutee(s: { genre: "proposition" | "demande"; id: string }): Promise<void>;
  tracer(e: Record<string, unknown>): Promise<void>;
}

export function gestionnaireEffacement(p: PortsEffacement) {
  return async (job: { genre: "proposition" | "demande"; id: string }): Promise<"efface" | "refuse"> => {
    if (!p.actif()) {
      await p.tracer({ type: "effacement_refuse_interrupteur_ferme", genre: job.genre, id: job.id });
      return "refuse";
    }
    const refuser = async (motif: string): Promise<"refuse"> => { await p.tracer({ type: "effacement_refuse", genre: job.genre, id: job.id, motif }); return "refuse"; };
    if ((job.genre !== "proposition" && job.genre !== "demande") || !UUID.test(job.id)) return refuser("job_invalide");
    // UNE transaction de contrôle : l'état « acceptee » est relu ici, le client est celui de la ligne relue.
    const s = await p.transaction(async (tx) => {
      const x = await tx.source(job.genre, job.id);
      if (!x || x.genre !== job.genre || x.id !== job.id || x.etat !== "acceptee" || !UUID.test(x.tenantId)) return "source_non_acceptee";
      if ((await tx.etatBase(x.tenantId)) !== "a_l_ecart") return "base_non_a_l_ecart";
      if (await tx.gelActif(x.tenantId)) return "gel";
      if (!doubleValidationAtteinte(x.tenantId, x.validations)) return "double_validation_absente";
      if (!x.exportRemis) return "export_non_remis";
      return x;
    });
    if (typeof s === "string") return refuser(s);
    try {
      await exigerAucunGel(p.gel, s.tenantId, "effacement");
    } catch (e) {
      if (e instanceof GelPourLitige) return refuser("gel");
      throw e;
    }
    for (const pas of [p.supprimerBase, p.retirerCompartiment, p.detruireCleClient, p.purgerCoffre, p.supprimerRoles, p.marquerEffacee]) await pas(s.tenantId);
    await p.marquerExecutee({ genre: s.genre, id: s.id });
    await p.tracer({ type: "effacement_execute", genre: s.genre, id: s.id, tenantId: s.tenantId });
    return "efface";
  };
}
