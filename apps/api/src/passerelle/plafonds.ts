import { z } from "zod";
import { validerTenant } from "../coffre/coffre.js";
import type { JournalAudit } from "../journal-audit/port.js";
import { MICRO_CENTIMES_PAR_UNITE } from "./consommation.js";

// Plafonds techniques de dépense d'IA (C-437, C-598 b) : blocage de la clé d'un client, budget global du jour, levée tracée.
// Ce n'est PAS le blocage commercial au dépassement (C-185, V2). Les erreurs ne portent qu'un code.

export type CodePlafonds =
  | "tenant_invalide" | "montant_invalide" | "motif_invalide" | "non_administrateur" | "journal_indisponible"
  | "horloge_illisible" | "cle_introuvable" | "cle_ambigue" | "client_different" | "passerelle_indisponible" | "reponse_invalide";

export class ErreurPlafonds extends Error {
  constructor(readonly code: CodePlafonds) {
    super(code);
    this.name = "ErreurPlafonds";
  }
}

export interface OptionsPlafonds {
  url: string;
  lireCleMaitre: () => Promise<string>;
  journal: JournalAudit;
  estAdministrateur: (identifiant: string) => Promise<boolean>;
  plafondCleMax: number;
  fetch?: typeof fetch;
}

const DELAI_MS = 5000;
const MOTIF_MAX = 500;
const entierSur = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);

function motifValide(motif: unknown): string {
  if (typeof motif !== "string" || motif.trim() === "" || motif.length > MOTIF_MAX) throw new ErreurPlafonds("motif_invalide");
  // Un saut de ligne ou un caractère de contrôle permettrait de fabriquer une fausse ligne de journal.
  for (const c of motif) if (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) throw new ErreurPlafonds("motif_invalide");
  return motif;
}
async function verifierAdmin(estAdministrateur: OptionsPlafonds["estAdministrateur"], parQui: unknown): Promise<string> {
  if (typeof parQui !== "string" || parQui === "" || !(await estAdministrateur(parQui).catch(() => false))) throw new ErreurPlafonds("non_administrateur");
  return parQui;
}
async function ecrire(journal: JournalAudit, entree: Parameters<JournalAudit["ecrire"]>[0]): Promise<void> {
  try {
    await journal.ecrire(entree);
  } catch {
    throw new ErreurPlafonds("journal_indisponible");
  }
}

const liste = z.object({ keys: z.array(z.object({ token: z.string().min(1), key_alias: z.string(), metadata: z.object({ tenant_id: z.string() }).optional() })) });
const info = z.object({ info: z.object({ spend: z.number().finite().nonnegative() }) });

export function creerPlafonds(o: OptionsPlafonds) {
  async function appeler(methode: "GET" | "POST", chemin: string, corps?: unknown): Promise<unknown> {
    let maitre: string;
    try {
      maitre = await o.lireCleMaitre();
    } catch {
      throw new ErreurPlafonds("passerelle_indisponible");
    }
    try {
      const r = await (o.fetch ?? fetch)(`${o.url}${chemin}`, {
        method: methode,
        headers: { Authorization: `Bearer ${maitre}`, ...(corps === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
        redirect: "error", // la clé maîtresse ne suit jamais une redirection
        signal: AbortSignal.timeout(DELAI_MS),
      });
      if (!r.ok) throw new Error();
      return await r.json();
    } catch {
      throw new ErreurPlafonds("passerelle_indisponible");
    }
  }
  // Une seule clé, dont l'alias ET le client correspondent : sinon on ne touche à rien.
  async function trouverCle(tenantId: string): Promise<string> {
    let t: string;
    try {
      t = validerTenant(tenantId);
    } catch {
      throw new ErreurPlafonds("tenant_invalide");
    }
    const l = liste.safeParse(await appeler("GET", `/key/list?key_alias=${encodeURIComponent(`cli-${t}`)}&return_full_object=true`));
    if (!l.success) throw new ErreurPlafonds("reponse_invalide");
    if (l.data.keys.length === 0) throw new ErreurPlafonds("cle_introuvable");
    if (l.data.keys.length > 1) throw new ErreurPlafonds("cle_ambigue");
    const [cle] = l.data.keys;
    if (!cle || cle.key_alias !== `cli-${t}` || cle.metadata?.tenant_id !== t) throw new ErreurPlafonds("client_different");
    return cle.token;
  }
  async function consomme(token: string): Promise<number> {
    const i = info.safeParse(await appeler("GET", `/key/info?key=${encodeURIComponent(token)}`));
    if (!i.success) throw new ErreurPlafonds("reponse_invalide");
    const micro = Math.round(Number((i.data.info.spend * MICRO_CENTIMES_PAR_UNITE).toPrecision(15)));
    if (!Number.isSafeInteger(micro)) throw new ErreurPlafonds("reponse_invalide");
    return micro;
  }

  return {
    async poserPlafondCle(tenantId: string, montant: number): Promise<void> {
      if (!entierSur(montant) || montant <= 0 || montant > o.plafondCleMax) throw new ErreurPlafonds("montant_invalide");
      const token = await trouverCle(tenantId);
      await appeler("POST", "/key/update", { key: token, max_budget: montant / MICRO_CENTIMES_PAR_UNITE, budget_duration: "30d" });
    },
    async bloquerCle(tenantId: string, motif: string): Promise<void> {
      const m = motifValide(motif);
      const token = await trouverCle(tenantId);
      // Bloquer d'abord : une lecture de dépense en panne ne doit jamais laisser une clé volée dépenser.
      await appeler("POST", "/key/block", { key: token });
      const montant = await consomme(token).catch(() => undefined);
      await ecrire(o.journal, { action: "blocage_cle", tenantId, parQui: "systeme", motif: m, ...(montant === undefined ? {} : { montantConsommeMicroCentimes: montant }) });
    },
    // Réservé à l'administrateur ; la trace s'écrit AVANT la réouverture. Aucune levée automatique n'existe.
    async leverBlocage(tenantId: string, { parQui, motif }: { parQui: string; motif: string }): Promise<void> {
      const qui = await verifierAdmin(o.estAdministrateur, parQui);
      const m = motifValide(motif);
      const token = await trouverCle(tenantId);
      const montant = await consomme(token);
      await ecrire(o.journal, { action: "levee_blocage_cle", tenantId, parQui: qui, motif: m, montantConsommeMicroCentimes: montant });
      try {
        await appeler("POST", "/key/unblock", { key: token });
      } catch (e) {
        // La trace d'avant disait « levée » : on écrit que la réouverture a échoué, la clé reste bloquée.
        await ecrire(o.journal, { action: "levee_blocage_cle_echouee", tenantId, parQui: qui, motif: m, montantConsommeMicroCentimes: montant });
        throw e;
      }
    },
  };
}

export interface OptionsBudgetJour {
  plafond: number;
  journal: JournalAudit;
  estAdministrateur: OptionsPlafonds["estAdministrateur"];
  horloge?: () => Date;
}

// Budget global du jour (UTC) côté API : refuse pour toutes les clés une fois atteint, sans jamais dépasser d'un appel.
// Le jour ne recule jamais (horloge faussée ou illisible) : seul un jour plus récent, ou une levée tracée, remet le compteur à zéro.
export function creerBudgetJour(o: OptionsBudgetJour) {
  if (!entierSur(o.plafond) || o.plafond <= 0) throw new ErreurPlafonds("montant_invalide");
  const horloge = o.horloge ?? (() => new Date());
  let jour = Number.NEGATIVE_INFINITY;
  let cumul = 0;
  const avancer = () => {
    const j = Math.floor(horloge().getTime() / 86_400_000);
    // Horloge illisible : on refuse (jamais de remise à zéro silencieuse).
    if (!Number.isFinite(j)) throw new ErreurPlafonds("horloge_illisible");
    if (j > jour) {
      jour = j;
      cumul = 0;
    }
  };
  return {
    reserver(cout: number): boolean {
      if (!entierSur(cout) || cout < 0) throw new ErreurPlafonds("montant_invalide");
      avancer();
      if (cumul >= o.plafond || cumul + cout > o.plafond) return false;
      cumul += cout;
      return true;
    },
    async lever({ parQui, motif }: { parQui: string; motif: string }): Promise<void> {
      const qui = await verifierAdmin(o.estAdministrateur, parQui);
      const m = motifValide(motif);
      await ecrire(o.journal, { action: "levee_budget_jour", parQui: qui, motif: m, montantConsommeMicroCentimes: cumul });
      cumul = 0;
    },
  };
}
