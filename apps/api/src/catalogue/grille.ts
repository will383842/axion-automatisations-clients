import { z } from "zod";
import { dateParis } from "../commercial/lire-niveaux.js";
import { formuleInstance } from "../db/schema/clients.js";
import { PLATEFORME_ID } from "../db/schema/aides.js";
import { ErreurApi } from "../plugins/erreurs.js";

// Grille de prix d'une automatisation (T3-31a1, ADR 0135). Une grille est une version immuable : écrire = insérer une ligne de grilles_prix ; la grille en vigueur est la plus récente.
// Montants en centimes HT, en chaînes de chiffres (jamais de Number ni de flottant). La console ne facture jamais : aucune écriture hors grilles_prix et historique_grilles_prix.
export type Champ = "installation" | "mensuel" | "maintenance_ensuite" | "maintenance_incluse_mois";
export interface ValeursGrille { formules: string[]; installation: string; mensuel: string; maintenanceEnsuite: string; maintenanceIncluseMois: number }
export interface GrilleLue extends ValeursGrille { id: string; auteur: string; creeLe: Date }
export interface LigneAEcrire { grilleId: string; precedenteId: string | null; champ: Champ; ancienne: string | null; nouvelle: string; raison: string }
export interface LigneHistorique { grilleId: string; precedenteId: string | null; champ: Champ; ancienne: string | null; nouvelle: string; auteur: string; raison: string; creeLe: Date }
// Étapes d'une écriture, toutes dans UNE transaction (verrou, lecture de la grille en vigueur, insertions, masquage).
export interface TxGrilles {
  verrouiller(automatisationId: string): Promise<{ statut: string } | undefined>;
  grilleEnVigueur(automatisationId: string): Promise<(GrilleLue & { posterieure: boolean }) | undefined>;
  insererGrille(automatisationId: string, v: ValeursGrille, auteur: string): Promise<{ id: string; creeLe: Date }>;
  insererHistorique(lignes: LigneAEcrire[]): Promise<void>;
  masquage(date: string): Promise<string[]>;
}
export interface DepotGrilles {
  ecrire<T>(acteur: string, fn: (tx: TxGrilles) => Promise<T>): Promise<T>;
  lire(automatisationId: string): Promise<{ grille: GrilleLue | null; masquage: string[] } | undefined>;
  historique(automatisationId: string, limite: number): Promise<LigneHistorique[] | undefined>;
}

const V1 = ["abonnement"];
const CHAMPS: readonly Champ[] = ["installation", "mensuel", "maintenance_ensuite", "maintenance_incluse_mois"];
const regle = (message: string) => new ErreurApi("regle_metier", message);
const PERIME = "La grille a changé entre-temps : rechargez-la.";
const montant = z.string().regex(/^(0|[1-9][0-9]{0,11})$/);
const Saisie = z.strictObject({
  formules: z.array(z.enum(formuleInstance.enumValues)).min(1).max(3).refine((f) => new Set(f).size === f.length),
  frais_mise_en_place_ht_centimes: montant,
  prix_mensuel_ht_centimes: montant,
  maintenance_ensuite_ht_centimes: montant,
  maintenance_incluse_mois: z.number().int().min(0).max(120),
  grille_precedente_id: z.uuid().nullable(),
  motif: z.string().trim().min(1).max(500),
});
const Limite = z.number().int().min(1).max(200);

const dto = (g: GrilleLue) => ({
  id: g.id,
  formules: g.formules,
  formules_proposees: g.formules.filter((f) => V1.includes(f)),
  frais_mise_en_place_ht_centimes: g.installation,
  prix_mensuel_ht_centimes: g.mensuel,
  maintenance_incluse_mois: g.maintenanceIncluseMois,
  maintenance_ensuite_ht_centimes: g.maintenanceEnsuite,
  auteur: g.auteur,
  cree_le: g.creeLe.toISOString(),
});
const dtoLigne = (l: LigneHistorique) => ({
  grille_id: l.grilleId,
  grille_precedente_id: l.precedenteId,
  champ: l.champ,
  unite: l.champ === "maintenance_incluse_mois" ? ("mois" as const) : ("centimes" as const),
  ancienne: l.ancienne,
  nouvelle: l.nouvelle,
  auteur: l.auteur,
  raison: l.raison,
  cree_le: l.creeLe.toISOString(),
});
const valeur = (v: ValeursGrille, champ: Champ): string =>
  champ === "installation" ? v.installation : champ === "mensuel" ? v.mensuel : champ === "maintenance_ensuite" ? v.maintenanceEnsuite : String(v.maintenanceIncluseMois);
const memesFormules = (a: string[], b: string[]) => [...a].sort().join("|") === [...b].sort().join("|");

export function creerServiceGrilles(depot: DepotGrilles) {
  return {
    async lire(id: string) {
      const r = await depot.lire(id);
      if (!r) throw new ErreurApi("introuvable", "Ressource introuvable.");
      return { automatisation_id: id, grille: r.grille ? dto(r.grille) : null, masquee_par_defaut: [...r.masquage].sort() };
    },
    async historique(id: string, limite: number) {
      const l = Limite.safeParse(limite);
      if (!l.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
      const lignes = await depot.historique(id, l.data);
      if (!lignes) throw new ErreurApi("introuvable", "Ressource introuvable.");
      return lignes.map(dtoLigne);
    },
    // Règles dans l'ordre de l'ADR 0135 ; chaque refus se fait sans écriture. Les messages sont fixes : ni montant, ni valeur saisie, ni motif.
    async ecrire(id: string, acteur: string, corps: unknown) {
      if (acteur.trim() === "" || acteur.length > 128) throw new ErreurApi("action_interdite", "Action non permise.");
      const p = Saisie.safeParse(corps);
      if (!p.success) throw new ErreurApi("schema_invalide", "Requête invalide.");
      const s = p.data;
      if (s.formules.some((f) => !V1.includes(f))) throw regle("Formule non proposée en V1.");
      if (BigInt(s.prix_mensuel_ht_centimes) === 0n) throw regle("Le prix mensuel ne peut pas être nul.");
      const neuve: ValeursGrille = { formules: s.formules, installation: s.frais_mise_en_place_ht_centimes, mensuel: s.prix_mensuel_ht_centimes, maintenanceEnsuite: s.maintenance_ensuite_ht_centimes, maintenanceIncluseMois: s.maintenance_incluse_mois };
      const r = await depot.ecrire(acteur, async (tx) => {
        const auto = await tx.verrouiller(id);
        if (!auto) throw new ErreurApi("introuvable", "Ressource introuvable.");
        if (auto.statut === "archivee") throw regle("Automatisation archivée : grille non modifiable.");
        const en = await tx.grilleEnVigueur(id);
        if ((en?.id ?? null) !== s.grille_precedente_id) throw regle(PERIME);
        // now() est celui du début de la transaction : une transaction plus ancienne que la dernière grille ne doit pas écrire une grille « plus ancienne ».
        if (en && !en.posterieure) throw regle(PERIME);
        const changes = en ? CHAMPS.filter((c) => valeur(en, c) !== valeur(neuve, c)) : [...CHAMPS];
        if (en && changes.length === 0 && memesFormules(en.formules, neuve.formules)) throw regle("Grille identique : rien à enregistrer.");
        const ecrite = await tx.insererGrille(id, neuve, acteur);
        const lignes: LigneAEcrire[] = changes.map((champ) => ({ grilleId: ecrite.id, precedenteId: en?.id ?? null, champ, ancienne: en ? valeur(en, champ) : null, nouvelle: valeur(neuve, champ), raison: s.motif }));
        if (lignes.length > 0) await tx.insererHistorique(lignes);
        return { ecrite, lignes, masquage: await tx.masquage(dateParis(new Date())) };
      });
      const grille: GrilleLue = { ...neuve, id: r.ecrite.id, auteur: acteur, creeLe: r.ecrite.creeLe };
      const historique = r.lignes.map((l) => dtoLigne({ ...l, auteur: acteur, creeLe: r.ecrite.creeLe }));
      return { grille: dto(grille), historique, masquee_par_defaut: [...r.masquage].sort() };
    },
  };
}
export type ServiceGrilles = ReturnType<typeof creerServiceGrilles>;

type Requete = (sql: string, valeurs: unknown[]) => Promise<Record<string, unknown>[]>;
const EN_VIGUEUR = `SELECT id, formules_actives, montant_installation_centimes, montant_mensuel_centimes, maintenance_incluse_mois, maintenance_ensuite_centimes, auteur, cree_le, (now() > cree_le) AS posterieure
  FROM grilles_prix WHERE automatisation_id = $1 ORDER BY cree_le DESC, id DESC LIMIT 1`.replace(/\s+/g, " ");
const MASQUAGE = `SELECT DISTINCT k FROM conditions_par_defaut, LATERAL unnest(ARRAY['frais_mise_en_place_centimes','tarif_mensuel_centimes','maintenance_incluse_mois']) AS k
  WHERE tenant_id = $1 AND valeur ? k AND (valide_du IS NULL OR valide_du <= $2::date) AND (valide_au IS NULL OR valide_au > $2::date)`.replace(/\s+/g, " ");
const lue = (l: Record<string, unknown>): GrilleLue & { posterieure: boolean } => ({
  id: String(l["id"]),
  formules: Array.isArray(l["formules_actives"]) ? (l["formules_actives"] as unknown[]).filter((f): f is string => typeof f === "string") : [],
  installation: String(l["montant_installation_centimes"]),
  mensuel: String(l["montant_mensuel_centimes"]),
  maintenanceEnsuite: String(l["maintenance_ensuite_centimes"]),
  maintenanceIncluseMois: Number(l["maintenance_incluse_mois"]),
  auteur: String(l["auteur"]),
  creeLe: l["cree_le"] as Date,
  posterieure: l["posterieure"] === true,
});
const masque = async (q: Requete, date: string) => (await q(MASQUAGE, [PLATEFORME_ID, date])).map((r) => String(r["k"]));

// Dépôt PostgreSQL. `transaction` ouvre BEGIN, un lock_timeout de 5 s, pose app.acteur (jamais app.tenant_id) et valide ou annule ; `lecture` est en lecture seule.
// Le verrou FOR NO KEY UPDATE sur l'automatisation sérialise deux écritures de grille (grilles_prix n'a ni UPDATE ni verrou possible).
export function depotSqlGrilles(d: { transaction<T>(acteur: string, fn: (q: Requete) => Promise<T>): Promise<T>; lecture<T>(fn: (q: Requete) => Promise<T>): Promise<T> }): DepotGrilles {
  return {
    ecrire: (acteur, fn) =>
      d.transaction(acteur, (q) =>
        fn({
          async verrouiller(id) {
            const l = (await q("SELECT statut FROM automatisations WHERE id = $1 FOR NO KEY UPDATE", [id]))[0];
            return l ? { statut: String(l["statut"]) } : undefined;
          },
          async grilleEnVigueur(id) {
            const l = (await q(EN_VIGUEUR, [id]))[0];
            return l ? lue(l) : undefined;
          },
          async insererGrille(id, v, auteur) {
            const l = (await q(
              `INSERT INTO grilles_prix (automatisation_id, formules_actives, montant_installation_centimes, montant_mensuel_centimes, maintenance_incluse_mois, maintenance_ensuite_centimes, auteur)
                 VALUES ($1, $2::jsonb, $3::bigint, $4::bigint, $5, $6::bigint, $7) RETURNING id, cree_le`,
              [id, JSON.stringify(v.formules), v.installation, v.mensuel, v.maintenanceIncluseMois, v.maintenanceEnsuite, auteur],
            ))[0];
            if (!l) throw new Error("grille non enregistrée");
            return { id: String(l["id"]), creeLe: l["cree_le"] as Date };
          },
          async insererHistorique(lignes) {
            // auteur = acteur (politique restrictive de la table) ; un seul INSERT pour toutes les lignes.
            const auteur = `$${lignes.length * 6 + 1}`;
            const morceaux = lignes.map((_, i) => `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}::champ_grille_prix, $${i * 6 + 4}::bigint, $${i * 6 + 5}::bigint, ${auteur}, $${i * 6 + 6})`);
            await q(
              `INSERT INTO historique_grilles_prix (grille_id, grille_precedente_id, champ, ancienne_valeur_centimes, nouvelle_valeur_centimes, auteur, raison) VALUES ${morceaux.join(", ")}`,
              [...lignes.flatMap((l) => [l.grilleId, l.precedenteId, l.champ, l.ancienne, l.nouvelle, l.raison]), acteur],
            );
          },
          masquage: (date) => masque(q, date),
        }),
      ),
    lire: (id) =>
      d.lecture(async (q) => {
        if ((await q("SELECT 1 FROM automatisations WHERE id = $1", [id])).length === 0) return undefined;
        const l = (await q(EN_VIGUEUR, [id]))[0];
        return { grille: l ? lue(l) : null, masquage: await masque(q, dateParis(new Date())) };
      }),
    historique: (id, limite) =>
      d.lecture(async (q) => {
        if ((await q("SELECT 1 FROM automatisations WHERE id = $1", [id])).length === 0) return undefined;
        const lignes = await q(
          `SELECT h.grille_id, h.grille_precedente_id, h.champ, h.ancienne_valeur_centimes, h.nouvelle_valeur_centimes, h.auteur, h.raison, h.cree_le
             FROM historique_grilles_prix h JOIN grilles_prix g ON g.id = h.grille_id WHERE g.automatisation_id = $1 ORDER BY h.cree_le DESC, h.id DESC LIMIT $2`,
          [id, limite],
        );
        return lignes.map((l) => ({
          grilleId: String(l["grille_id"]),
          precedenteId: l["grille_precedente_id"] === null ? null : String(l["grille_precedente_id"]),
          champ: l["champ"] as Champ,
          ancienne: l["ancienne_valeur_centimes"] === null ? null : String(l["ancienne_valeur_centimes"]),
          nouvelle: String(l["nouvelle_valeur_centimes"]),
          auteur: String(l["auteur"]),
          raison: String(l["raison"]),
          creeLe: l["cree_le"] as Date,
        }));
      }),
  };
}
