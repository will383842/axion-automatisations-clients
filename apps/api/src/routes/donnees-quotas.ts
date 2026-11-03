import type { FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { ErreurApi } from "../plugins/erreurs.js";
import { SEUIL_ALERTE_BPS, SEUIL_ATTEINT_BPS, pourcentagesBps, type NomQuota } from "../quotas/alerter.js";
import type { Mesures } from "../quotas/mesurer.js";
import { quotasEffectifs, type ConfigQuotas, type Palier, type Surcharge } from "../quotas/paliers.js";

// État des données et quotas d'un client (A-247, B-040, B-328) : tailles, quotas, pourcentages, imports en cours, dernière sauvegarde, dernier export.
// Métadonnées seulement : aucun contenu de client, aucun nom de base, aucun identifiant. Deux routes :
//   - console (équipe) : le client vient de l'URL ; un client inconnu et un client sans base donnent la même réponse « introuvable » ;
//   - portail (client) : le client vient de la SESSION, jamais de l'URL, d'un en-tête, d'un cookie ou du corps (C-536).
// Les gestionnaires sont exportés SANS enregistrement : l'inscription dans scripts/liste-routes.ts et apps/api/src/serveur.ts n'est pas dans les fichiers de la fiche (dette, voir la PR).
export const CHEMIN_CONSOLE = "/api/console/v1/clients/:id/donnees";
export const CHEMIN_PORTAIL = "/api/portail/v1/donnees";

export interface SourceEtat {
  palier: Palier;
  surcharge: Surcharge;
  mesures: Mesures | undefined;
  importsEnCours: number;
  derniereSauvegarde: Date | null;
  dernierExport: Date | null;
}
export interface DepsDonneesQuotas {
  config: ConfigQuotas;
  exigerEquipe: preHandlerAsyncHookHandler;
  session(requete: FastifyRequest): Promise<{ tenantId: string }>;
  source(tenantId: string): Promise<SourceEtat | undefined>;
}

const Params = z.strictObject({ id: z.uuid() });
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function etatDonnees(config: ConfigQuotas, s: SourceEtat) {
  const q = quotasEffectifs(config, s.palier, s.surcharge);
  const m = s.mesures;
  const p = m ? pourcentagesBps(m, q) : undefined;
  const pire = p ? Math.max(...(Object.keys(p) as NomQuota[]).map((k) => p[k])) : 0;
  return {
    palier: s.palier,
    base: { taille_octets: m?.baseOctets ?? null, quota_octets: q.baseOctets, pourcentage_bps: p?.base ?? null },
    fichiers: { taille_octets: m?.fichiersOctets ?? null, quota_octets: q.fichiersOctets, pourcentage_bps: p?.fichiers ?? null },
    personnes: { nombre: m?.personnes ?? null, quota: q.personnes, pourcentage_bps: p?.personnes ?? null },
    alerte: pire >= SEUIL_ATTEINT_BPS ? "quota_atteint" : pire >= SEUIL_ALERTE_BPS ? "quota_70" : "aucune",
    imports_en_cours: s.importsEnCours,
    derniere_sauvegarde: iso(s.derniereSauvegarde),
    dernier_export: iso(s.dernierExport),
    mesure_le: iso(m?.mesureLe ?? null),
  };
}

export function gestionnairesDonneesQuotas(d: DepsDonneesQuotas) {
  const rendre = async (tenantId: string) => {
    const s = await d.source(tenantId);
    if (!s) throw new ErreurApi("introuvable", "Ressource introuvable.");
    return etatDonnees(d.config, s);
  };
  return {
    exigerEquipe: d.exigerEquipe,
    console: async (requete: FastifyRequest) => {
      const p = Params.safeParse(requete.params);
      if (!p.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
      return rendre(p.data.id);
    },
    portail: async (requete: FastifyRequest) => rendre((await d.session(requete)).tenantId),
  };
}
