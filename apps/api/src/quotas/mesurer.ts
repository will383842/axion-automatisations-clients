import type { FileMinimale } from "../files/files.js";
import { deposer } from "../files/files.js";
import type { Connexion, RoleConnexion, SessionDonnees } from "../donnees/service.js";

// Mesure de l'occupation RÉELLE d'un client (A-247) : taille de la base, taille du compartiment (somme des objets), nombre de personnes.
// Une tâche BullMQ par base et par heure (jobId dérivé de la base et de l'heure). Chaque mesure est un port : les adaptateurs viennent avec le branchement.
export interface Mesures {
  baseOctets: number;
  fichiersOctets: number;
  personnes: number;
  mesureLe: Date;
}
export interface BaseMesuree {
  tenantId: string;
  nomBase: string;
}
export interface PortsMesure {
  // pg_database_size lit le disque : AVEC LE RÔLE DE LECTURE, jamais en ouvrant la base en écriture.
  tailleBase(nomBase: string): Promise<number>;
  tailleFichiers(tenantId: string): Promise<number>;
  personnes(tenantId: string): Promise<number>;
  // Écrit bases_client.taille_octets et les mesures de fichiers et de personnes.
  ecrire(tenantId: string, mesures: Mesures): Promise<void>;
  maintenant(): Date;
}

const entierSur = (v: number, nom: string): number => {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`mesure invalide : ${nom}`);
  return v;
};

export async function mesurer(ports: PortsMesure, base: BaseMesuree): Promise<Mesures> {
  const [baseOctets, fichiersOctets, personnes] = await Promise.all([ports.tailleBase(base.nomBase), ports.tailleFichiers(base.tenantId), ports.personnes(base.tenantId)]);
  // Une mesure douteuse n'est jamais écrite : elle fausserait l'alerte et le blocage.
  const mesures: Mesures = { baseOctets: entierSur(baseOctets, "base"), fichiersOctets: entierSur(fichiersOctets, "fichiers"), personnes: entierSur(personnes, "personnes"), mesureLe: ports.maintenant() };
  await ports.ecrire(base.tenantId, mesures);
  return mesures;
}

export const SQL_TAILLE_BASE = "SELECT pg_database_size(current_database())::float8 AS octets";
export function tailleBaseParLecture(ouvrir: (nomBase: string, role: RoleConnexion) => Promise<Connexion>): (nomBase: string) => Promise<number> {
  return async (nomBase) => {
    const connexion = await ouvrir(nomBase, "lecture");
    try {
      const lignes = await connexion.requete(SQL_TAILLE_BASE, []);
      return Number(lignes[0]?.["octets"]);
    } finally {
      await connexion.fermer();
    }
  };
}

// Le nombre de personnes passe par la requête de la liste blanche (T2-37), en équipe : métadonnées seulement, jamais une vue « comme le client ».
export function personnesParListeBlanche(service: { executer(session: SessionDonnees, nom: string, parametres: unknown): Promise<unknown[]> }): (tenantId: string) => Promise<number> {
  return async (tenantId) => {
    const lignes = (await service.executer({ tenantId, role: "equipe", acteur: "quotas", etablissements: [] }, "compterPersonnes", {})) as Record<string, unknown>[];
    return Number(lignes[0]?.["total"]);
  };
}

export const TYPE_TACHE_MESURE = "mesurer_quotas";
// Même base, même heure (UTC) → même cle → même jobId : BullMQ garde une seule tâche.
export const cleHeure = (nomBase: string, instant: Date): string => `${nomBase}|${instant.toISOString().slice(0, 13)}`;
export function deposerMesure(file: FileMinimale, base: BaseMesuree, maintenant: Date): Promise<void> {
  return deposer(file, { tenantId: base.tenantId, type: TYPE_TACHE_MESURE, cle: cleHeure(base.nomBase, maintenant) }, { nomBase: base.nomBase });
}
