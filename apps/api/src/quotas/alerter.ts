import { ErreurApi } from "../plugins/erreurs.js";
import { dateParis } from "../commercial/lire-niveaux.js";
import type { Mesures } from "./mesurer.js";
import type { Quotas } from "./paliers.js";

// Alerte à 70 % (A-247) et blocage doux à 100 % (A-248, V1). Le passage sur un serveur dédié et le stockage supplémentaire facturé sont de la V2 : rien ici ne facture.
// À 100 % : refus des NOUVEAUX imports seulement. Ce module n'a aucun accès à une suppression ni à un arrêt d'automatisation.
export type NomQuota = "base" | "fichiers" | "personnes";
export const SEUIL_ALERTE_BPS = 7000;
export const SEUIL_ATTEINT_BPS = 10000;
export type Seuil = 70 | 100;
export type TypeAlerteQuota = "quota_70" | "quota_atteint";
// Une alerte ne porte que son type, l'identifiant console du client, le seuil, les quotas touchés et le mois : ni nom de client, ni mesure.
export interface AlerteQuota {
  type: TypeAlerteQuota;
  clientId: string;
  seuil: Seuil;
  quotas: NomQuota[];
  mois: string;
}
export interface PortsAlerte {
  dejaEnvoyee(tenantId: string, seuil: Seuil, mois: string): Promise<boolean>;
  marquer(tenantId: string, seuil: Seuil, mois: string): Promise<void>;
  envoyer(alerte: AlerteQuota): Promise<void>;
  maintenant(): Date;
}

// Pourcentage en points de base, arrondi vers le bas, en bigint : aucun flottant, aucune perte au-delà de 2^53.
const bps = (mesure: number, quota: number): number => Number((BigInt(mesure) * 10000n) / BigInt(quota));
export function pourcentagesBps(m: Pick<Mesures, "baseOctets" | "fichiersOctets" | "personnes">, q: Quotas): Record<NomQuota, number> {
  return { base: bps(m.baseOctets, q.baseOctets), fichiers: bps(m.fichiersOctets, q.fichiersOctets), personnes: bps(m.personnes, q.personnes) };
}
const touches = (p: Record<NomQuota, number>, minimum: number, maximum: number): NomQuota[] => (Object.keys(p) as NomQuota[]).filter((k) => p[k] >= minimum && p[k] < maximum);

// Une alerte par seuil et par mois (et par client), pas à chaque mesure. Si l'envoi échoue, rien n'est marqué : l'alerte repart à la mesure suivante.
export async function alerter(ports: PortsAlerte, tenantId: string, mesures: Mesures, quotas: Quotas): Promise<TypeAlerteQuota | undefined> {
  const p = pourcentagesBps(mesures, quotas);
  const atteints = touches(p, SEUIL_ATTEINT_BPS, Infinity);
  const proches = touches(p, SEUIL_ALERTE_BPS, SEUIL_ATTEINT_BPS);
  const [type, seuil, concernes] = atteints.length > 0 ? (["quota_atteint", 100, atteints] as const) : proches.length > 0 ? (["quota_70", 70, proches] as const) : [undefined, 0, []] as const;
  if (!type) return undefined;
  const mois = dateParis(ports.maintenant()).slice(0, 7);
  if (await ports.dejaEnvoyee(tenantId, seuil, mois)) return undefined;
  await ports.envoyer({ type, clientId: tenantId, seuil, quotas: [...concernes], mois });
  await ports.marquer(tenantId, seuil, mois);
  return type;
}

// Refus `regle_metier`, motif `quota_atteint`. Le message ne dit ni mesure, ni quota, ni client.
export class QuotaAtteint extends ErreurApi {
  readonly motif = "quota_atteint";
  constructor() { super("regle_metier", "Le quota de votre offre est atteint : de nouveaux imports ne sont pas possibles pour le moment. Vos données et vos automatisations ne sont pas touchées."); }
}
export function verifierImportAutorise(mesures: Pick<Mesures, "baseOctets" | "fichiersOctets" | "personnes">, quotas: Quotas): void {
  const p = pourcentagesBps(mesures, quotas);
  if (Object.values(p).some((v) => v >= SEUIL_ATTEINT_BPS)) throw new QuotaAtteint();
}
