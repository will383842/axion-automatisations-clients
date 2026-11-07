import { ErreurApi } from "../plugins/erreurs.js";
import type { SessionDonnees } from "../donnees/service.js";
import { ouvrirVueClient, type DepsVue, type VueRangee } from "../donnees/vue-client.js";

// Registre des vues (T3-08a, B-066), en mémoire du processus comme celui de T2-37 : UNE vue vivante par acteur (tous clients confondus), jamais renouvelée en silence.
// Limite : un seul processus d'API. Avec deux processus, une vue ouverte sur l'un serait invisible pour la garde de l'autre (dette E3, spec/preuves/lot-3-t3-08a.md).
export interface RegistreVues {
  vueDe(acteur: string): VueRangee | undefined;
  vueRangee(acteur: string, tenantId: string): VueRangee | undefined;
  ranger(vue: VueRangee): void;
  fermer(acteur: string): VueRangee | undefined;
  reserver(acteur: string): boolean;
  liberer(acteur: string): void;
}

export function creerRegistreVues(maintenant: () => Date): RegistreVues {
  const vues = new Map<string, VueRangee>();
  const enCours = new Set<string>();
  // Expiration lue sur l'horloge du serveur, comparaison stricte : à la fin exacte, la vue n'existe plus.
  const vueDe = (acteur: string): VueRangee | undefined => {
    const v = vues.get(acteur);
    if (v && !(maintenant() < v.expireLe)) { vues.delete(acteur); return undefined; }
    return v ? { ...v } : undefined;
  };
  return {
    vueDe,
    vueRangee: (acteur, tenantId) => { const v = vueDe(acteur); return v && v.tenantId === tenantId ? v : undefined; },
    ranger: (vue) => { vues.set(vue.acteur, { ...vue }); },
    fermer: (acteur) => { const v = vueDe(acteur); vues.delete(acteur); return v; },
    // Réservation SYNCHRONE : prise avant tout await, donc deux ouvertures simultanées ne passent jamais ensemble.
    reserver: (acteur) => { if (enCours.has(acteur) || vueDe(acteur)) return false; enCours.add(acteur); return true; },
    liberer: (acteur) => { enCours.delete(acteur); },
  };
}

// Ouvre la vue de T2-37 (rôle, accord, fin d'intervention, 60 minutes, « pas de trace, pas de vue ») et la range dans le registre. Une vue qui vit, ou qui s'ouvre déjà : 422.
export async function ouvrirVue(registre: RegistreVues, deps: Omit<DepsVue, "ranger">, session: SessionDonnees, tenantId: string, motif: string, roleEquipe: string | undefined): Promise<SessionDonnees> {
  if (!registre.reserver(session.acteur)) throw new ErreurApi("regle_metier", "Une vue est déjà ouverte.");
  try {
    return await ouvrirVueClient({ ...deps, ranger: (v) => registre.ranger(v) }, session, tenantId, motif, roleEquipe);
  } finally {
    registre.liberer(session.acteur);
  }
}
