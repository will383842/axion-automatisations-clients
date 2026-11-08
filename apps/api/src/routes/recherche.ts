import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { entetesDebitDepasse, RETRY_AFTER_MAX_SECONDES } from "../../../../packages/contrats/src/commun/debit.js";
import { autorise } from "../droits/matrice.js";
import type { MembreDroits } from "../droits/exiger-droit.js";
import { ErreurApi } from "../plugins/erreurs.js";
import { normaliserTerme, rechercher, type DepotRecherche } from "../recherche/index.js";

// Recherche globale (T3-09a, ADR 0133) : lecture seule, réservée à l'équipe. La route n'existe que si serveur.ts la reçoit ; elle répond 503 tant que `ouvert()` est faux (fermé par défaut).
// Ordre des contrôles : porte, équipe, terme, membre (actif, droit « lire »), débit par membre, portée, dépôt. Aucune lecture avant la fin de ces contrôles. Le terme n'est jamais journalisé ni renvoyé.
export interface DepsRecherche {
  ouvert(): boolean;
  exigerEquipe: preHandlerAsyncHookHandler;
  membre(requete: FastifyRequest): Promise<MembreDroits | undefined>;
  depot: DepotRecherche;
  // Débit par membre, en mémoire du processus (limite connue : un compteur par processus, dette T3-09-dette-debit-processus).
  debit: { parMembre: number; fenetreMs: number };
  maintenant?: () => number;
}

// Liste fermée : tout autre paramètre, ou un « q » répété, est refusé.
const Requete = z.strictObject({
  q: z.string(),
  limite: z.string().regex(/^\d{1,2}$/).transform(Number).pipe(z.number().int().min(1).max(20)).optional(),
});
const LIMITE_PAR_DEFAUT = 5;
const PURGE_AU_DELA = 1000;

export function routeRecherche(serveur: FastifyInstance, d: DepsRecherche): void {
  const maintenant = d.maintenant ?? Date.now;
  const compteurs = new Map<string, { debut: number; n: number }>();
  // Un membre de plus = une entrée de plus : les fenêtres échues sont purgées quand la table grossit.
  const compter = (sujet: string): number | undefined => {
    const t = maintenant();
    if (compteurs.size > PURGE_AU_DELA) for (const [s, c] of compteurs) if (t - c.debut >= d.debit.fenetreMs) compteurs.delete(s);
    const c = compteurs.get(sujet);
    if (!c || t - c.debut >= d.debit.fenetreMs) { compteurs.set(sujet, { debut: t, n: 1 }); return undefined; }
    if (c.n >= d.debit.parMembre) return Math.min(RETRY_AFTER_MAX_SECONDES, Math.max(1, Math.ceil((c.debut + d.debit.fenetreMs - t) / 1000)));
    c.n++;
    return undefined;
  };

  const porteEtEquipe: preHandlerAsyncHookHandler = async function (requete, reponse) {
    if (!d.ouvert()) throw new ErreurApi("porte_fermee", "Service indisponible.");
    return d.exigerEquipe.call(this, requete, reponse);
  };

  serveur.get("/api/console/v1/recherche", { preHandler: porteEtEquipe }, async (requete, reponse) => {
    const p = Requete.safeParse(requete.query);
    const terme = p.success ? normaliserTerme(p.data.q) : undefined;
    if (!p.success || terme === undefined) throw new ErreurApi("schema_invalide", "Requête invalide.");
    const membre = await d.membre(requete).catch(() => undefined);
    if (!membre?.actif || !autorise(membre.role, "lire")) throw new ErreurApi("action_interdite", "Action non permise.");
    const attente = compter(membre.sujet);
    if (attente !== undefined) {
      reponse.headers(entetesDebitDepasse(attente));
      throw new ErreurApi("debit_depasse", "Trop de requêtes.");
    }
    return rechercher(d.depot, membre, terme, p.data.limite ?? LIMITE_PAR_DEFAUT, (type) => requete.log.warn({ type }, "recherche : ligne hors portée écartée"));
  });
}
