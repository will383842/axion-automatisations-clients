import { DelayedError } from "bullmq";
import { z } from "zod";
import { normaliser, OPTIONS_TACHE, verrouConsultatif, type Verrou } from "../provisionnement/machine.js";
import type { GelLitige } from "../retention/purger.js";
import { echeance, idTacheFin, planifierTaches, TOLERANCE_RETARD_MS, type NomEtape, type ResultatFin } from "./machine.js";

// Ordonnanceur de la fin de contrat (T2-44b-b) : rappelle la machine, reporte la MÊME tâche (même jobId) par moveToDelayed puis DelayedError (le report ne consomme pas d'essai),
// et dépose les tâches après la validation de la transaction. Horloge injectée : jamais l'heure du système lue ici.
export const REESSAI_OCCUPE_MS = 60_000;
export const REESSAI_GEL_MS = 3_600_000;
const ETAPES_TACHE = ["clore_plans", "preavis_j1", "preavis_j20", "preavis_j27"] as const satisfies readonly NomEtape[];
const DonneesTache = z.strictObject({ tenantId: z.string().transform(normaliser).pipe(z.uuid()), etape: z.enum(ETAPES_TACHE) });

export interface TacheFin { data: unknown; moveToDelayed(quand: number, token?: string): Promise<void> }
export interface DepsOrdonnanceur {
  machine: { executer(tenantId: string): Promise<ResultatFin> };
  maintenant(): Date;
  gel: Pick<GelLitige, "gelActif">;
}
// Verrou par client de la fin de contrat : clé fin-<tenantId>, connexion directe (jamais PgBouncer en mode transaction).
export const verrouFin = (ouvrir: Parameters<typeof verrouConsultatif>[0]): Verrou => verrouConsultatif(ouvrir, "fin");

export async function traiterTacheFin(d: DepsOrdonnanceur, tache: TacheFin, token?: string): Promise<"termine"> {
  const donnees = DonneesTache.parse(tache.data);
  const reporter = async (quand: number): Promise<never> => {
    await tache.moveToDelayed(quand, token);
    throw new DelayedError();
  };
  const r = await d.machine.executer(donnees.tenantId);
  switch (r.etat) {
    case "attend_reponses": return reporter(d.maintenant().getTime() + r.reessayerDansMs);
    // Seule l'étape de la tâche se reporte à son échéance ; les suivantes ont leur propre tâche.
    case "attend_date": return r.etape === donnees.etape ? reporter(r.jusqua.getTime()) : "termine";
    case "occupe": return reporter(d.maintenant().getTime() + REESSAI_OCCUPE_MS);
    case "suspendu_gel": {
      // Gel relu avant de reporter : s'il est levé, la reprise est rapide.
      const encore = await d.gel.gelActif(donnees.tenantId);
      return reporter(d.maintenant().getTime() + (encore ? REESSAI_GEL_MS : REESSAI_OCCUPE_MS));
    }
    default: return "termine";
  }
}

// Dépôt des tâches (une par étape datée, jobId idTacheFin) : même forme que deposerProvisionnement. Une tâche en échec ou terminée est retirée puis redéposée ; en attente, différée ou active, laissée.
export interface FileFin {
  getJob(id: string): Promise<{ getState(): Promise<string>; remove(): Promise<void> } | undefined>;
  add(nom: string, donnees: { tenantId: string; etape: NomEtape }, options: Record<string, unknown>): Promise<unknown>;
}
export async function deposerTachesFin(file: FileFin, tenantId: string, dateFin: string, maintenant: () => Date): Promise<void> {
  for (const t of planifierTaches(tenantId, dateFin, maintenant())) {
    const id = idTacheFin(tenantId, t.etape);
    const existante = await file.getJob(id);
    if (existante) {
      const etat = await existante.getState();
      if (etat !== "failed" && etat !== "completed") continue;
      await existante.remove();
    }
    await file.add("fin_de_contrat", { tenantId: normaliser(tenantId), etape: t.etape }, { ...OPTIONS_TACHE, jobId: id, delay: t.delaiMs });
  }
}

// Relais après un arrêt entre la validation et le dépôt : redépose les fins dont la dernière échéance (préavis J+27 et sa tolérance) n'est pas passée.
export async function balayerFins(d: { fins(): Promise<{ tenantId: string; dateFin: string }[]>; deposer(tenantId: string, dateFin: string): Promise<void>; maintenant(): Date }): Promise<number> {
  let n = 0;
  for (const f of await d.fins()) {
    if (d.maintenant().getTime() > echeance(f.dateFin, 27).getTime() + TOLERANCE_RETARD_MS) continue;
    await d.deposer(f.tenantId, f.dateFin);
    n++;
  }
  return n;
}
