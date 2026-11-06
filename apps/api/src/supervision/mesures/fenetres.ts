// Taux de succès glissant (B-382, B-487) calculé sur les exécutions terminées déjà rangées : aucune requête vers l'exécuteur (B-381).
// Résultat en points de base (entier). Une fenêtre sans exécution terminée est « sans objet », jamais 0 %.
export interface ExecutionTerminee {
  id: string;
  tenantId: string;
  instanceId: string;
  automatisationId: string | null;
  statut: "reussie" | "echec" | "en_cours" | "annulee";
  finLe: Date;
}
export type Taux = { etat: "sans_objet" } | { etat: "mesure"; pointsDeBase: number; total: number; echecs: number };

export const FENETRE_24H_MS = 86_400_000;
export const FENETRE_7J_MS = 7 * FENETRE_24H_MS;

export function tauxSucces(executions: ExecutionTerminee[], maintenant: Date, fenetreMs: number): Taux {
  const vues = new Set<string>();
  let total = 0;
  let echecs = 0;
  for (const e of executions) {
    if (e.statut !== "reussie" && e.statut !== "echec") continue;
    const age = maintenant.getTime() - e.finLe.getTime();
    if (age < 0 || age >= fenetreMs) continue;
    const cle = `${e.tenantId}/${e.id}`; // un événement rejoué ne compte qu'une fois
    if (vues.has(cle)) continue;
    vues.add(cle);
    total += 1;
    if (e.statut === "echec") echecs += 1;
  }
  if (total === 0) return { etat: "sans_objet" };
  return { etat: "mesure", pointsDeBase: Math.floor(((total - echecs) * 10_000 + total / 2) / total), total, echecs };
}

function parGroupe(executions: ExecutionTerminee[], maintenant: Date, fenetreMs: number, cle: (e: ExecutionTerminee) => string | null): Map<string, Taux> {
  const groupes = new Map<string, ExecutionTerminee[]>();
  for (const e of executions) {
    const k = cle(e);
    if (k === null) continue;
    groupes.set(k, [...(groupes.get(k) ?? []), e]);
  }
  return new Map([...groupes].map(([k, l]) => [k, tauxSucces(l, maintenant, fenetreMs)]));
}

export const tauxParInstance = (l: ExecutionTerminee[], maintenant: Date, fenetreMs: number) => parGroupe(l, maintenant, fenetreMs, (e) => e.instanceId);
export const tauxParAutomatisation = (l: ExecutionTerminee[], maintenant: Date, fenetreMs: number) => parGroupe(l, maintenant, fenetreMs, (e) => e.automatisationId);
export const tauxParClient = (l: ExecutionTerminee[], maintenant: Date, fenetreMs: number) => parGroupe(l, maintenant, fenetreMs, (e) => e.tenantId);
