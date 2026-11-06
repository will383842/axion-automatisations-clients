import type { JournalEtapes } from "../noyau/ports.ts";
import { importerParBlocs, type EcrivainBloc, type RapportImport } from "./blocs.ts";
import type { Dedoublonneur } from "./dedoublonner.ts";
import type { ListesExclusion } from "./exclusion.ts";
import { MAX_OCTETS, type Ligne } from "./lecteur.ts";

export { MAX_OCTETS };
// Aiguillage (A-269) : un gros fichier part dans la file `imports`, de faible priorité, pour ne pas ralentir les autres clients.
export const SEUIL_LIGNES = 10_000;
export const SEUIL_OCTETS = 50 * 1024 * 1024;
export const aiguiller = (f: { lignes: number; octets: number }): "imports" | "cellule" => (f.lignes > SEUIL_LIGNES || f.octets > SEUIL_OCTETS ? "imports" : "cellule");

// Un seul import en cours par client (A-272) : le suivant attend, sans être perdu.
export class ImportsParClient {
  readonly #en_cours = new Map<string, string>();
  readonly #attente = new Map<string, string[]>();
  readonly #reserve = new Set<string>();
  demarrer(clientId: string, importId: string): "demarre" | "en_attente" {
    if (this.#reserve.delete(`${clientId}|${importId}`)) return "demarre";
    if (this.#en_cours.has(clientId)) { this.#attente.set(clientId, [...(this.#attente.get(clientId) ?? []), importId]); return "en_attente"; }
    this.#en_cours.set(clientId, importId);
    return "demarre";
  }
  // Rend l'import à lancer ensuite, s'il y en a un.
  terminer(clientId: string, importId: string): string | undefined {
    if (this.#en_cours.get(clientId) !== importId) return undefined;
    this.#en_cours.delete(clientId);
    const suite = this.#attente.get(clientId)?.shift();
    // L'import rendu est réservé : aucun autre ne passe devant, et demarrer() le laisse partir.
    if (suite !== undefined) { this.#en_cours.set(clientId, suite); this.#reserve.add(`${clientId}|${suite}`); }
    return suite;
  }
}

export interface Ecrivain extends EcrivainBloc { existe(cle: string): Promise<boolean> }
export interface PortsImport {
  verrou: ImportsParClient;
  journal: JournalEtapes;
  // La base d'écriture ne dépend que du client : jamais d'un champ du fichier.
  ecrivainPour(tenantId: string): Ecrivain;
  dedoublonneurPour(tenantId: string): Dedoublonneur;
  exclusions: ListesExclusion;
}
export interface DemandeImport { tenantId: string; importId: string; instanceId: string; executionId: string; lignes: AsyncIterable<Ligne> }
export type ResultatImport = { statut: "termine"; rapport: RapportImport; suivant?: string | undefined } | { statut: "en_attente" };

export async function executerImport(d: DemandeImport, ports: PortsImport): Promise<ResultatImport> {
  if (ports.verrou.demarrer(d.tenantId, d.importId) === "en_attente") return { statut: "en_attente" };
  try {
    const rapport = await importerParBlocs({ instanceId: d.instanceId, executionId: d.executionId, lignes: d.lignes, journal: ports.journal, ecrivain: ports.ecrivainPour(d.tenantId), dedoublonneur: ports.dedoublonneurPour(d.tenantId), exclusions: ports.exclusions });
    return { statut: "termine", rapport, suivant: ports.verrou.terminer(d.tenantId, d.importId) };
  } catch (e) {
    const suivant = ports.verrou.terminer(d.tenantId, d.importId);
    throw new ImportEchoue(e, suivant);
  }
}
// L'échec garde l'import suivant : l'appelant doit le lancer, sinon il resterait réservé pour toujours.
export class ImportEchoue extends Error {
  constructor(override readonly cause: unknown, readonly suivant: string | undefined) { super(cause instanceof Error ? cause.message : String(cause)); this.name = "ImportEchoue"; }
}
