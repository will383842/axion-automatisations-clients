import type { Pool } from "pg";
import { avecClient } from "../../db/connexion.ts";
import { DELAI_GRACE_MS } from "../intention.ts";
import type { Bail, BoiteEnvoi, Intention } from "../ports.ts";

type Etat = Intention["etat"];

// Boîte d'envoi sur la table intentions, pour un seul client. La clé est unique PAR client : c'est l'anti-doublon de dernier recours.
// Chaque méthode est une transaction terminée à son retour : l'intention est donc validée en base AVANT l'appel du connecteur (A-316).
// Aucune migration (ADR 0102) : la table ne garde ni bail ni détail de l'appel. Le bail en mémoire ne vaut que dans ce processus (une seule boîte par client et par processus).
// Entre deux processus, l'âge de l'intention (cree_le) tient lieu de bail : une intention « ecrite » qu'on n'a pas créée et plus récente que le délai de l'étape + la marge
// est tenue par un autre travailleur (occupée : l'étape est reportée, le connecteur n'est ni vérifié ni appelé). Plus vieille, la garantie du connecteur tranche
// (même clé, vérification après coup, ou « à trancher »). Limite : l'âge se mesure avec l'horloge du processus contre celle de la base.
export class BoitePostgres implements BoiteEnvoi {
  #baux = new Map<string, Bail>();
  #connues = new Map<string, Omit<Intention, "etat" | "bail">>();
  // Clés dont l'appel a fini sur un échec connu dans ce processus : l'effet n'a pas eu lieu, un nouvel essai ici n'est pas « occupé ».
  #rendues = new Map<string, number>();  // clé -> fin du bail rendu : passé cet instant, la fenêtre d'âge a de toute façon fini

  // graceMs : la marge après le délai de l'étape (60 s par défaut), réglable pour les tests.
  constructor(
    private pool: Pool,
    private tenantId: string,
    private options: { graceMs?: number } = {},
  ) {}

  async ecrire(i: Omit<Intention, "etat" | "bail">, bail: Bail, maintenant: number) {
    const lue = await avecClient(this.pool, this.tenantId, async (c) => {
      const exec = await c.query<{ debut: Date }>("SELECT debut FROM executions WHERE tenant_id = $1 AND id = $2 AND instance_id = $3", [this.tenantId, i.executionId, i.instanceId]);
      if (!exec.rows[0]) throw new Error("execution_inconnue");
      const ajout = await c.query(
        "INSERT INTO intentions (tenant_id, id, execution_id, debut_execution, cle_intention, garantie) SELECT x.tenant_id, gen_random_uuid(), x.id, x.debut, $4::text, $5::garantie_intention FROM executions x WHERE x.tenant_id = $1 AND x.id = $2 AND x.instance_id = $3 ON CONFLICT (tenant_id, cle_intention) DO NOTHING",
        [this.tenantId, i.executionId, i.instanceId, i.cle, i.garantie],
      );
      const x = await c.query<{ etat: Etat; garantie: Intention["garantie"]; cree_le: Date }>("SELECT etat, garantie, cree_le FROM intentions WHERE tenant_id = $1 AND cle_intention = $2", [this.tenantId, i.cle]);
      return { creee: ajout.rowCount === 1, etat: x.rows[0]!.etat, garantie: x.rows[0]!.garantie, creeLe: new Date(x.rows[0]!.cree_le).getTime() };
    });
    // Une même clé reprise avec une autre action : l'action connue de ce processus l'emporte (la table ne garde pas l'action), le noyau refuse alors « cle_en_conflit ».
    // Mémoire bornée : seules les intentions encore « ecrite » en base se retiennent, les baux échus et les échecs anciens se purgent.
    this.#purger(maintenant);
    const connue = this.#connues.get(i.cle);
    if (!connue && lue.etat === "ecrite") this.#connues.set(i.cle, i);
    const actuel = this.#baux.get(i.cle);
    const bailAutre = actuel !== undefined && actuel.proprietaire !== bail.proprietaire && actuel.jusqua > maintenant;
    // Fenêtre = délai de l'étape + marge, CONSTANTE : elle ne dépend pas de la part de l'étape déjà écoulée chez le lanceur actuel (sinon un effet atteint tard dans l'étape raccourcirait la fenêtre).
    const fenetre = bail.delaiEtapeMs + (this.options.graceMs ?? DELAI_GRACE_MS);
    const recente = !lue.creee && maintenant - lue.creeLe < fenetre && !this.#rendues.has(i.cle) && !(actuel && actuel.proprietaire === bail.proprietaire);
    const occupee = lue.etat === "ecrite" && (bailAutre || recente);
    // Fin de l'occupation : la plus tardive des deux causes (bail d'un autre dans ce processus, âge de l'intention en base).
    const libreA = Math.max(bailAutre ? actuel!.jusqua : 0, recente ? lue.creeLe + fenetre : 0);
    if (lue.etat === "ecrite" && !occupee) {
      this.#baux.set(i.cle, bail);
      this.#rendues.delete(i.cle);
    }
    return { intention: { ...i, action: connue?.action ?? i.action, garantie: lue.garantie, etat: lue.etat, ...(this.#baux.has(i.cle) ? { bail: this.#baux.get(i.cle)! } : {}) } as Intention, creee: lue.creee, occupee, ...(occupee ? { libreA } : {}) };
  }

  // Pour les tests : de quoi la boîte se souvient.
  get tailles() {
    return { connues: this.#connues.size, rendues: this.#rendues.size, baux: this.#baux.size };
  }

  #purger(maintenant: number) {
    for (const [cle, bail] of this.#baux) {
      if (bail.jusqua <= maintenant) this.#baux.delete(cle);
    }
    // Un échec connu ne sert plus une fois la fenêtre passée : l'âge de l'intention fait alors foi.
    for (const [cle, fin] of this.#rendues) {
      if (fin <= maintenant) this.#rendues.delete(cle);
    }
    for (const cle of this.#connues.keys()) {
      if (!this.#baux.has(cle) && !this.#rendues.has(cle)) this.#connues.delete(cle);
    }
  }

  async lire(cle: string) {
    const { rows } = await avecClient(this.pool, this.tenantId, (c) =>
      c.query<{ etat: Etat; garantie: Intention["garantie"]; execution_id: string }>("SELECT etat, garantie, execution_id FROM intentions WHERE tenant_id = $1 AND cle_intention = $2", [this.tenantId, cle]),
    );
    const r = rows[0];
    if (!r) return undefined;
    const connue = this.#connues.get(cle);
    // Les détails de l'appel ne sont pas en base : vides pour une intention écrite par un autre processus.
    return { cle, instanceId: connue?.instanceId ?? "", executionId: r.execution_id, etape: connue?.etape ?? "", element: connue?.element ?? "", action: connue?.action ?? "", garantie: r.garantie, etat: r.etat } satisfies Intention;
  }

  marquerFaite(cle: string, proprietaire: string) {
    return this.#changer(cle, proprietaire, "faite");
  }
  marquerATrancher(cle: string, proprietaire: string) {
    return this.#changer(cle, proprietaire, "a_trancher");
  }
  async liberer(cle: string, proprietaire: string) {
    if (this.#baux.get(cle)?.proprietaire !== proprietaire) return;
    this.#rendues.set(cle, this.#baux.get(cle)!.jusqua);
    this.#baux.delete(cle);
  }

  async #changer(cle: string, proprietaire: string, etat: "faite" | "a_trancher") {
    if (this.#baux.get(cle)?.proprietaire !== proprietaire) return false;
    // Comparer-et-échanger en base : seulement depuis « ecrite ».
    const r = await avecClient(this.pool, this.tenantId, (c) => c.query("UPDATE intentions SET etat = $3 WHERE tenant_id = $1 AND cle_intention = $2 AND etat = 'ecrite'", [this.tenantId, cle, etat]));
    // Fini en base : plus rien à tenir en mémoire (la boîte vit autant que le processus).
    this.#baux.delete(cle);
    this.#connues.delete(cle);
    this.#rendues.delete(cle);
    return r.rowCount === 1;
  }
}

