import type { EntreeJournal, JournalEtapes } from "../noyau/ports.ts";
import type { Dedoublonneur } from "./dedoublonner.ts";
import { classerLigne, type ListesExclusion } from "./exclusion.ts";
import type { Ligne } from "./lecteur.ts";

// Blocs de 1 000 lignes (A-270) : le numéro du dernier bloc validé est inscrit au journal d'étapes ; après une coupure on reprend au bloc suivant.
export const TAILLE_BLOC = 1000;
export interface RapportImport { importees: number; doublons: number; exclues_client: number; exclues_plateforme: number }
export interface EcrivainBloc { ecrireBloc(numero: number, lignes: Ligne[]): Promise<void> }
export interface ParamsBlocs {
  instanceId: string;
  executionId: string;
  lignes: AsyncIterable<Ligne>;
  journal: JournalEtapes;
  ecrivain: EcrivainBloc;
  dedoublonneur: Dedoublonneur;
  exclusions: ListesExclusion;
}
const ETAPE = /^bloc-(\d+)$/;

export async function importerParBlocs(p: ParamsBlocs): Promise<RapportImport> {
  const dernier = (await p.journal.lire(p.instanceId, p.executionId))
    .filter((e) => e.statut === "faite")
    .reduce((m, e) => Math.max(m, Number(ETAPE.exec(e.etape)?.[1] ?? 0)), 0);
  const rapport: RapportImport = { importees: 0, doublons: 0, exclues_client: 0, exclues_plateforme: 0 };
  let numero = 1;
  let courant: Ligne[] = [];
  let acceptees: Ligne[] = [];
  const valider = async () => {
    if (courant.length === 0) return;
    if (numero > dernier) {
      await p.ecrivain.ecrireBloc(numero, acceptees);
      const entree: EntreeJournal = { instanceId: p.instanceId, executionId: p.executionId, etape: `bloc-${numero}`, statut: "faite", essai: 1, a: "import" };
      await p.journal.inscrire(entree);
      rapport.importees += acceptees.length;
    }
    numero += 1;
    courant = [];
    acceptees = [];
  };
  for await (const ligne of p.lignes) {
    courant.push(ligne);
    if (numero > dernier) {
      const verdict = await classerLigne(ligne, p.exclusions);
      if (verdict === "exclue_client") rapport.exclues_client += 1;
      else if (verdict === "exclue_plateforme") rapport.exclues_plateforme += 1;
      else if (await p.dedoublonneur.estDoublon(ligne)) rapport.doublons += 1;
      else acceptees.push(ligne);
    }
    if (courant.length === TAILLE_BLOC) await valider();
  }
  await valider();
  return rapport;
}
