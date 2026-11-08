import type { Pool, PoolClient } from "pg";
import { cleDIntention } from "../../../../packages/contrats/src/commun/idempotence.js";
import { deposer, transactionOuverte } from "../canaux/boite-envoi.js";
import { avecClient, type Appelant } from "../db/client-actif.js";
import { clientC1 } from "../hub/client-c1.js";
import { normaliser } from "../provisionnement/machine.js";
import type { GelLitige } from "../retention/purger.js";
import type { AlerteFin, Dossier, JourPreavis } from "./machine.js";
import type { PlanHub } from "./clore-plans.js";

// Adaptateurs SQL de la fin de contrat (T2-44b-b). Chaque requête passe par avecClient (RLS) ET filtre tenant_id = $1 ; aucune suppression, aucune réécriture d'une valeur déjà posée.
// Aucun appel à l'horloge du système : l'heure est injectée.
export interface Requeteur { query(texte: string, valeurs?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> }
export type Avec = <T>(tenantId: string, fn: (c: Requeteur) => Promise<T>, appelant?: Appelant) => Promise<T>;
export const depuisPool = (pool: Pool): Avec => (tenantId, fn, appelant) => avecClient(pool, tenantId, (c: PoolClient) => fn(c), appelant);
const ACTEUR_SYSTEME: Appelant = { acteur: "systeme-fin-de-contrat" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const tenant = (brut: string): string => {
  const t = normaliser(brut);
  if (!UUID.test(t)) throw new Error("tenantId invalide");
  return t;
};
// Colonnes des préavis : table FERMÉE, jamais une valeur de l'appel collée dans le texte SQL.
const COLONNES = {
  1: { envoye: "preavis_j1_envoye_le", accuse: "preavis_j1_accuse" },
  20: { envoye: "preavis_j20_envoye_le", accuse: "preavis_j20_accuse" },
  27: { envoye: "preavis_j27_envoye_le", accuse: "preavis_j27_accuse" },
} as const;
const colonnes = (jour: JourPreavis) => {
  const c = Object.hasOwn(COLONNES, jour) ? COLONNES[jour] : undefined;
  if (!c) throw new Error("jour de préavis inconnu");
  return c;
};

// Port lancer de la route : UNE ligne par client (contrainte fins_de_contrat_une_par_client, migration 0030). La planification vient APRÈS la validation, seulement si lancee.
export function lancerEnBase(o: { avec: Avec; planifier(tenantId: string, dateFin: string, maintenant: Date): Promise<void>; maintenant(): Date }) {
  return async (d: { tenantId: string; dateFin: string; acteur: string }): Promise<"lancee" | "deja_lancee" | "autre_date"> => {
    const t = tenant(d.tenantId);
    const etat = await o.avec(
      t,
      async (c) => {
        const r = await c.query("INSERT INTO fins_de_contrat (tenant_id, id, organisation_id, date_fin) VALUES ($1, gen_random_uuid(), $1, $2) ON CONFLICT (tenant_id) DO NOTHING RETURNING id", [t, d.dateFin]);
        if (r.rows.length > 0) return "lancee" as const;
        // Le perdant relit dans une nouvelle instruction : la date du gagnant décide.
        const lu = await c.query("SELECT date_fin::text AS d FROM fins_de_contrat WHERE tenant_id = $1", [t]);
        return lu.rows[0]?.["d"] === d.dateFin ? ("deja_lancee" as const) : ("autre_date" as const);
      },
      { acteur: d.acteur },
    );
    if (etat === "lancee") {
      await o.planifier(t, d.dateFin, o.maintenant());
    }
    return etat;
  };
}

export const dossierEnBase = (avec: Avec) => async (brut: string): Promise<Dossier | undefined> => {
  const t = tenant(brut);
  const l = (await avec(t, (c) => c.query(`SELECT date_fin::text AS date_fin, export_reference, export_telecharge_le, ${Object.values(COLONNES).flatMap((x) => [x.envoye, x.accuse]).join(", ")} FROM fins_de_contrat WHERE tenant_id = $1`, [t]))).rows[0];
  if (!l) return undefined;
  const preavis = (jour: JourPreavis) => ({ envoyeLe: (l[COLONNES[jour].envoye] as Date | null) ?? null, accuse: (l[COLONNES[jour].accuse] as string | null) ?? null });
  return { dateFin: l["date_fin"] as string, exportReference: (l["export_reference"] as string | null) ?? null, exportTelechargeLe: (l["export_telecharge_le"] as Date | null) ?? null, preavis: { 1: preavis(1), 20: preavis(20), 27: preavis(27) } };
};

// Fonction pure : un plan est clos si la ligne de clôture est « envoye » (jamais reponse_recue ni derniere_erreur). Une phase déposée (plan:<phase>) mais jamais liée rend idPlan null.
export function planDepuisLignes(tenantId: string, phases: { id: string; idPlanHub: string | null }[], lignes: { cle: string; etat: string }[]): PlanHub[] {
  const etatDe = new Map(lignes.map((l) => [l.cle, l.etat]));
  const plans = new Map<string, PlanHub>();
  const nonLies: PlanHub[] = [];
  for (const p of phases) {
    if (p.idPlanHub !== null) {
      const etat = etatDe.get(cleDIntention("hub", JSON.stringify([tenantId, `clore:${p.idPlanHub}`])));
      plans.set(p.idPlanHub, { idPlan: p.idPlanHub, reponseRecue: etat === "envoye", enEchec: etat === "echec" });
    } else if (etatDe.has(cleDIntention("hub", JSON.stringify([tenantId, `plan:${p.id}`])))) nonLies.push({ idPlan: null, reponseRecue: false, enEchec: false });
  }
  return [...plans.values(), ...nonLies];
}
const cleClore = (t: string, idPlan: string) => cleDIntention("hub", JSON.stringify([t, `clore:${idPlan}`]));
export const plansEnBase = (avec: Avec) => async (brut: string): Promise<PlanHub[]> => {
  const t = tenant(brut);
  return avec(t, async (c) => {
    const rows = (await c.query("SELECT id::text AS id, id_plan_hub FROM phases_plan WHERE tenant_id = $1", [t])).rows as { id: string; id_plan_hub: string | null }[];
    const phases = rows.map((r) => ({ id: r.id, idPlanHub: r.id_plan_hub }));
    if (phases.length === 0) return [];
    const cles = phases.map((p) => (p.idPlanHub !== null ? cleClore(t, p.idPlanHub) : cleDIntention("hub", JSON.stringify([t, `plan:${p.id}`]))));
    const lignes = (await c.query("SELECT cle_anti_doublon::text AS cle, etat::text AS etat FROM boite_envoi WHERE tenant_id = $1 AND destination = 'hub' AND cle_anti_doublon = ANY($2::uuid[])", [t, cles])).rows as { cle: string; etat: string }[];
    return planDepuisLignes(t, phases, lignes);
  });
};

// Dépôt de la clôture par la porte signée (clientC1.clore, motif fin_de_contrat), dans la transaction du client ; redéposer ne crée rien de plus.
export const deposerCloreEnBase = (avec: Avec) => async (brut: string, idPlan: string, dateFin: string): Promise<void> => {
  const t = tenant(brut);
  await avec(
    t,
    async (c) => {
      const tx = transactionOuverte(c as Pick<PoolClient, "query">);
      await clientC1({ tx: c, deposer: (depot) => deposer(tx, depot) }).clore({ idPlan, dateFin, motif: "fin_de_contrat" });
    },
    ACTEUR_SYSTEME,
  );
};

// La première référence d'export gagne.
export const enregistrerExportEnBase = (avec: Avec) => async (brut: string, reference: string, expireLe: Date): Promise<void> => {
  const t = tenant(brut);
  await avec(t, (c) => c.query("UPDATE fins_de_contrat SET export_reference = $2, export_expire_le = $3 WHERE tenant_id = $1 AND export_reference IS NULL", [t, reference, expireLe]), ACTEUR_SYSTEME);
};
// La première date gagne.
export const marquerPreavisEnBase = (avec: Avec) => async (brut: string, jour: JourPreavis, quand: Date): Promise<void> => {
  const t = tenant(brut);
  const col = colonnes(jour).envoye;
  await avec(t, (c) => c.query(`UPDATE fins_de_contrat SET ${col} = $2 WHERE tenant_id = $1 AND ${col} IS NULL`, [t, quand]), ACTEUR_SYSTEME);
};
// Le premier accusé gagne, et seulement pour un préavis envoyé.
export const enregistrerAccuseEnBase = (avec: Avec) => async (brut: string, jour: JourPreavis, preuve: string): Promise<boolean> => {
  const t = tenant(brut);
  const { envoye, accuse } = colonnes(jour);
  const r = await avec(t, (c) => c.query(`UPDATE fins_de_contrat SET ${accuse} = $2 WHERE tenant_id = $1 AND ${envoye} IS NOT NULL AND ${accuse} IS NULL RETURNING 1 AS ok`, [t, preuve]), ACTEUR_SYSTEME);
  return r.rows.length > 0;
};

// Alerte à clé stable <type>:<code> : une seule alerte en cours par client et par clé (index partiel alertes_une_ouverte_par_cle, migration 0029). Que des codes, jamais un texte libre.
const CRITIQUES = new Set(["cloture_en_echec", "plan_non_lie"]);
export const alerterEnBase = (avec: Avec) => async (a: AlerteFin): Promise<void> => {
  const t = tenant(a.clientId);
  if (!CODE.test(a.type) || !CODE.test(a.code)) throw new Error("alerte : type et code attendus");
  await avec(
    t,
    (c) => c.query(
      "INSERT INTO alertes (tenant_id, id, organisation_id, type, gravite, regle, cle_regroupement) VALUES ($1, gen_random_uuid(), $1, $2, $3, $4, $5) ON CONFLICT (tenant_id, cle_regroupement) WHERE cle_regroupement IS NOT NULL AND etat IN ('ouverte', 'acquittee') DO NOTHING",
      [t, a.type, CRITIQUES.has(a.code) ? "critique" : "avertissement", a.code, `${a.type}:${a.code}`],
    ),
    ACTEUR_SYSTEME,
  );
};

// Port gel de la machine : relais du gel pour litige (C-609), jamais une valeur par défaut.
export const gelEnBase = (gel: Pick<GelLitige, "gelActif">): Pick<GelLitige, "gelActif"> => ({ gelActif: (brut) => gel.gelActif(tenant(brut)) });
