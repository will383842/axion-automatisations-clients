import { ErreurApi } from "../plugins/erreurs.js";
import { DELAI_PILOTE_JOURS, etapesRequises, passagePermis, type Interrupteurs, type Statut } from "./cycle-de-vie.js";
import type { DemandePassage, DemandePreuve } from "./procedure.js";

// Machine d'états d'une version, côté serveur (T4-27b, ADR 0122). Une seule transaction par passage, sous console_equipe, avec app.acteur et JAMAIS app.tenant_id.
// Le statut change SEUL (catalogue_garde refuse toute autre colonne) ; ce qui est posé au passage va dans passages_version, les preuves dans preuves_procedure.
export interface VersionVerrouillee { id: string; statut: Statut; empreinte: string; automatisationId: string; module: string; semver: string; schemaConfigurationVide: boolean }
export interface PreuveARanger { versionId: string; etape: number; empreinte: string; reference: string | null; mesureMs: number | null; contenu: Record<string, unknown> }
export interface PassageARanger { versionId: string; depart: Statut; arrivee: Statut; empreinte: string; finAnnonceeLe: string | null; remplacanteId: string | null; prevenanceLe: string | null }
export interface Tx {
  /** SELECT … FOR UPDATE : la version reste verrouillée jusqu'à la fin de la transaction. */
  verrouiller(versionId: string): Promise<VersionVerrouillee | undefined>;
  /** Étapes qui ont une preuve de CETTE empreinte, créée au plus tard à `borne` : null = maintenant (heure du serveur) ; un état = passe_le du dernier passage vers cet état (aucun passage : aucune étape). */
  etapesProuvees(versionId: string, empreinte: string, borne: Statut | null): Promise<number[]>;
  /** Dernière ligne recette → pilote de cette empreinte (sans retour en brouillon depuis) : début du pilote et 7 jours révolus, comptés par l'heure du SERVEUR. */
  delaiPilote(versionId: string, empreinte: string): Promise<{ debut: Date; ecoule: boolean } | undefined>;
  remplacante(versionId: string): Promise<{ statut: Statut; automatisationId: string } | undefined>;
  /** Date du jour du serveur, AAAA-MM-JJ. */
  dateServeur(): Promise<string>;
  /** false si une preuve existe déjà pour (version, étape, empreinte). */
  ranger(preuve: PreuveARanger): Promise<boolean>;
  /** Seul appelant : le dépôt d'une preuve de l'étape 4 (rapport du harnais), pendant la recette. */
  ecrireModelesTestes(versionId: string, modeles: string[]): Promise<void>;
  ecrirePassage(passage: PassageARanger): Promise<void>;
  /** UPDATE du statut seul. */
  changerStatut(versionId: string, arrivee: Statut): Promise<void>;
}
export interface DepotCycle { transaction<T>(acteur: string, fn: (tx: Tx) => Promise<T>): Promise<T> }
// Erreurs `definitive` du pilote (C-249) : l'adaptateur réel attend le lot 1-B ou 8a ; aucune lecture d'une base de client ici.
export interface ErreursPilote { compterDefinitives(versionId: string, depuis: Date): Promise<number> }
export interface JournalCycle { ecrire(entree: { action: "passage_version"; parQui: string; motif: string }): Promise<void> }

const regle = (message: string) => new ErreurApi("regle_metier", message);

export function creerCycle(o: { depot: DepotCycle; erreursPilote: ErreursPilote; journal: JournalCycle; interrupteurs: Interrupteurs }) {
  return {
    async passer(versionId: string, d: DemandePassage, acteur: string): Promise<{ versionId: string; statut: Statut }> {
      if (!passagePermis(d.depart, d.vers)) throw regle("Passage non permis.");
      await o.depot.transaction(acteur, async (tx) => {
        const v = await tx.verrouiller(versionId);
        if (!v) throw new ErreurApi("introuvable", "Version introuvable.");
        if (v.statut !== d.depart) throw regle("L'état de départ ne correspond pas à l'état de la version.");
        if (v.empreinte !== d.empreinte) throw regle("L'empreinte ne correspond pas à celle de la version.");
        if (d.vers === "depreciee" && !d.finAnnonceeLe) throw regle("La date de fin est obligatoire.");
        if (d.vers === "retiree") await verifierRetrait(tx, v, d);
        const manquantes = new Set<number>();
        const exiger = async (arrivee: Statut, borne: Statut | null) => {
          const prouvees = new Set(await tx.etapesProuvees(v.id, v.empreinte, borne));
          for (const e of etapesRequises(arrivee, o.interrupteurs)) if (!prouvees.has(e)) manquantes.add(e);
        };
        // Chaque porte franchie est revérifiée : ses preuves comptent si elles existaient au moment de ce passage-là (cree_le <= passe_le), jamais rangées après coup.
        if (d.vers === "recette") await exiger("recette", null);
        if (d.vers === "pilote") { await exiger("recette", "recette"); await exiger("pilote", null); }
        if (d.vers === "publiee") { await exiger("recette", "recette"); await exiger("pilote", "pilote"); }
        if (["recette", "pilote", "publiee"].includes(d.vers) && v.schemaConfigurationVide) manquantes.add(3);
        if (d.vers === "publiee") {
          const pilote = await tx.delaiPilote(v.id, v.empreinte);
          if (!pilote?.ecoule || (await o.erreursPilote.compterDefinitives(v.id, pilote.debut)) > 0) manquantes.add(9);
          if (!d.signatureProduction) manquantes.add(10);
        }
        if (manquantes.size) throw regle(`Étapes manquantes : ${[...manquantes].sort((a, b) => a - b).join(", ")}.`);
        await tx.ecrirePassage({ versionId: v.id, depart: d.depart, arrivee: d.vers, empreinte: v.empreinte, finAnnonceeLe: d.finAnnonceeLe, remplacanteId: d.remplacanteId, prevenanceLe: d.prevenanceLe });
        await tx.changerStatut(v.id, d.vers);
        // Étape 10 (C-250) : dans la même transaction que le passage ; si elle échoue, tout est annulé.
        if (d.vers === "publiee") await tx.ranger({ versionId: v.id, etape: 10, empreinte: v.empreinte, reference: d.signatureProduction, mesureMs: null, contenu: { rapport_mensuel: true } });
      });
      // Le déclencheur de la base trace déjà chaque ligne : un échec du journal ne défait pas un passage validé.
      await o.journal.ecrire({ action: "passage_version", parQui: acteur, motif: `${d.depart}>${d.vers}` }).catch(() => undefined);
      return { versionId, statut: d.vers };
    },

    async deposer(versionId: string, d: DemandePreuve, acteur: string): Promise<{ etape: number }> {
      await o.depot.transaction(acteur, async (tx) => {
        const v = await tx.verrouiller(versionId);
        if (!v) throw new ErreurApi("introuvable", "Version introuvable.");
        // Une version publiée ne se modifie pas (A-306) : on ne range une preuve qu'en brouillon ou en recette.
        if (v.statut !== "brouillon" && v.statut !== "recette") throw regle("La version est figée : une preuve ne se range qu'en brouillon ou en recette.");
        if (v.empreinte !== d.empreinte) throw regle("L'empreinte ne correspond pas à celle de la version.");
        if (d.etape === 4) {
          if (v.statut !== "recette") throw regle("Le rapport du harnais se range pendant la recette.");
          if (!d.rapport?.vert || d.rapport.module !== v.module || d.rapport.version !== v.semver) throw regle("Le rapport du harnais n'est pas vert ou ne correspond pas à la version.");
        }
        if (!(await tx.ranger({ versionId: v.id, etape: d.etape, empreinte: v.empreinte, reference: d.reference, mesureMs: d.mesureMs, contenu: d.contenu }))) throw new ErreurApi("identifiant_deja_pris", "Cette preuve est déjà rangée.");
        // modeles_testes (C-202) : seule cette voie l'écrit, depuis le rapport, en UPDATE séparé de tout changement de statut.
        if (d.etape === 4 && d.modeles) await tx.ecrireModelesTestes(v.id, d.modeles);
      });
      return { etape: d.etape };
    },
  };
}
export type Cycle = ReturnType<typeof creerCycle>;

// Retrait (B-462, A-307) : remplaçante = version PUBLIÉE de la MÊME automatisation, autre que la version elle-même ; prévenance passée, jugée sur la date du serveur.
async function verifierRetrait(tx: Tx, v: VersionVerrouillee, d: DemandePassage): Promise<void> {
  if (!d.remplacanteId) throw regle("La remplaçante est obligatoire.");
  if (!d.prevenanceLe) throw regle("La date de prévenance est obligatoire.");
  const r = d.remplacanteId === v.id ? undefined : await tx.remplacante(d.remplacanteId);
  if (r?.statut !== "publiee") throw regle("La remplaçante doit être une version publiée.");
  if (r.automatisationId !== v.automatisationId) throw regle("La remplaçante doit être de la même automatisation.");
  if (d.prevenanceLe > (await tx.dateServeur())) throw regle("La date de prévenance n'est pas passée.");
}

type Requete = (sql: string, valeurs: unknown[]) => Promise<Record<string, unknown>[]>;
// Dépôt PostgreSQL : `transaction` ouvre BEGIN, pose app.acteur (jamais app.tenant_id) et valide ou annule. Les 7 jours sont comptés ici, en SQL, sur now() du serveur.
export function depotSqlCycle(transaction: <T>(acteur: string, fn: (q: Requete) => Promise<T>) => Promise<T>): DepotCycle {
  return {
    transaction: (acteur, fn) =>
      transaction(acteur, (q) =>
        fn({
          async verrouiller(id) {
            const l = (await q(
              `SELECT v.id, v.statut, v.empreinte_sha256 AS empreinte, v.automatisation_id, a.nom AS module, v.semver, (v.schema_configuration = '{}'::jsonb) AS schema_vide
                 FROM versions_automatisation v JOIN automatisations a ON a.id = v.automatisation_id WHERE v.id = $1 FOR UPDATE OF v`,
              [id],
            ))[0];
            return l ? { id: String(l["id"]), statut: l["statut"] as Statut, empreinte: String(l["empreinte"]), automatisationId: String(l["automatisation_id"]), module: String(l["module"]), semver: String(l["semver"]), schemaConfigurationVide: l["schema_vide"] === true } : undefined;
          },
          async etapesProuvees(id, empreinte, borne) {
            const l = await q(
              `SELECT DISTINCT p.etape FROM preuves_procedure p WHERE p.version_id = $1 AND p.empreinte_sha256 = $2
                 AND p.cree_le <= COALESCE(CASE WHEN $3::text IS NULL THEN now()
                   ELSE (SELECT max(g.passe_le) FROM passages_version g WHERE g.version_id = $1 AND g.empreinte_sha256 = $2 AND g.statut_arrivee::text = $3::text) END, '-infinity'::timestamptz)`,
              [id, empreinte, borne],
            );
            return l.map((r) => Number(r["etape"]));
          },
          async delaiPilote(id, empreinte) {
            const l = (await q(
              `SELECT p.passe_le AS debut, (now() >= p.passe_le + make_interval(days => $3)) AS ecoule FROM passages_version p
                 WHERE p.version_id = $1 AND p.empreinte_sha256 = $2 AND p.statut_depart = 'recette' AND p.statut_arrivee = 'pilote'
                   AND NOT EXISTS (SELECT 1 FROM passages_version r WHERE r.version_id = p.version_id AND r.statut_arrivee = 'brouillon' AND r.passe_le > p.passe_le)
                 ORDER BY p.passe_le DESC LIMIT 1`,
              [id, empreinte, DELAI_PILOTE_JOURS],
            ))[0];
            return l ? { debut: l["debut"] as Date, ecoule: l["ecoule"] === true } : undefined;
          },
          async remplacante(id) {
            const l = (await q("SELECT statut, automatisation_id FROM versions_automatisation WHERE id = $1", [id]))[0];
            return l ? { statut: l["statut"] as Statut, automatisationId: String(l["automatisation_id"]) } : undefined;
          },
          async dateServeur() {
            return String((await q("SELECT to_char(current_date, 'YYYY-MM-DD') AS d", []))[0]?.["d"]);
          },
          async ranger(p) {
            const l = await q(
              `INSERT INTO preuves_procedure (version_id, etape, empreinte_sha256, reference, mesure_ms, contenu, auteur) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
                 ON CONFLICT (version_id, etape, empreinte_sha256) DO NOTHING RETURNING id`,
              [p.versionId, p.etape, p.empreinte, p.reference, p.mesureMs, JSON.stringify(p.contenu), acteur],
            );
            return l.length === 1;
          },
          async ecrireModelesTestes(id, modeles) {
            await q("UPDATE versions_automatisation SET modeles_testes = $2::text[] WHERE id = $1", [id, modeles]);
          },
          async ecrirePassage(p) {
            await q(
              `INSERT INTO passages_version (version_id, statut_depart, statut_arrivee, empreinte_sha256, fin_annoncee_le, remplacante_id, prevenance_le, auteur) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [p.versionId, p.depart, p.arrivee, p.empreinte, p.finAnnonceeLe, p.remplacanteId, p.prevenanceLe, acteur],
            );
          },
          async changerStatut(id, arrivee) {
            await q("UPDATE versions_automatisation SET statut = $2::statut_version WHERE id = $1", [id, arrivee]);
          },
        }),
      ),
  };
}
