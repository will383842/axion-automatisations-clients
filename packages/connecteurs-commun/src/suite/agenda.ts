import type { Garantie } from "@axion-auto/sdk-module";
import type { Capacite } from "../capacites.ts";
import { classer, ErreurConnecteur } from "../erreurs.ts";
import type { DeclarationConnecteur } from "../famille.ts";
import { ACTIONS_AGENDA, type ConnecteurAgenda } from "../familles/agenda.ts";
import { avecJeton, creerJeton, type JetonCourt } from "../jeton.ts";

export type Panne = "quota" | "jeton" | "http_503" | "inattendue";
export type Scenario = { nom: string; panne?: Panne };
type Base = { declaration: DeclarationConnecteur & { capacites: Capacite[] } };
export type Banc<C extends Base = Base> = { connecteur: C; jeton: JetonCourt; valeurJeton: string; effets(): number };
export type Aide = { proteger<T>(j: JetonCourt, f: () => T): Promise<T>; ecrire(cle: string, prefixe: string): string; ecrits: Set<string> };
export type Cas<C extends Base> = { nom: string; scenario: Scenario; jouer(b: Banc<C>): Promise<void> };

export const verifier = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg); };
export const attraper = async (f: () => Promise<unknown>): Promise<unknown> => { try { await f(); } catch (e) { return e; } return undefined; };

// Socle commun des suites de contrat des familles : connecteur de référence en mémoire, sans réseau,
// et les cas communs (déclaration, effet unique, quota, jeton, 503, inattendu).
export function creerSuite<C extends Base>(cfg: {
  famille: string;
  actions: readonly string[];
  garanties: Record<string, Garantie>;
  methodes: string[];
  connecteur(aide: Aide): Omit<C, "declaration">;
  nominal(c: C, j: JetonCourt): Promise<unknown>;
  ecriture(c: C, j: JetonCourt): Promise<unknown>;
  extra?: Cas<C>[];
}) {
  type Fabrique = (s: Scenario) => Promise<Banc<C>> | Banc<C>;
  const fabriqueMemoire = (s: Scenario): Banc<C> => {
    const valeurJeton = `jeton-fictif-${s.nom}`;
    const jeton = creerJeton(valeurJeton, Date.now() + 60_000);
    const ecrits = new Set<string>();
    const proteger = async <T>(j: JetonCourt, f: () => T): Promise<T> => {
      try {
        avecJeton(j, Date.now(), () => 0);
        if (s.panne === "quota") throw new ErreurConnecteur("quota", "quota_depasse", { reprise: "2026-11-01T08:00:00Z" });
        if (s.panne === "jeton") throw new ErreurConnecteur("identification", "jeton_refuse");
        if (s.panne === "http_503") throw new ErreurConnecteur("passagere", "http_503");
        if (s.panne === "inattendue") throw new TypeError("fetch failed");
        return f();
      } catch (e) {
        throw classer(e);
      }
    };
    const aide: Aide = { proteger, ecrits, ecrire: (cle, prefixe) => (ecrits.add(cle), `${prefixe}-${cle}`) };
    const declaration = {
      famille: cfg.famille, outil: "reference-memoire", version: "1.0.0", portees: [`${cfg.famille}.essai`],
      capacites: cfg.actions.map((action) => ({ action, garantie: cfg.garanties[action]! })),
    };
    return { jeton, valeurJeton, effets: () => ecrits.size, connecteur: { declaration, ...cfg.connecteur(aide) } as C };
  };
  const C = (nom: string, scenario: string | Scenario, jouer: Cas<C>["jouer"]): Cas<C> => ({ nom, scenario: typeof scenario === "string" ? { nom: scenario } : scenario, jouer });
  const erreurClasse = async (b: Banc<C>, classe: string) => {
    const e = await attraper(() => cfg.nominal(b.connecteur, b.jeton));
    verifier(e instanceof ErreurConnecteur && e.classe === classe, `erreur attendue de classe ${classe}`);
    return e as ErreurConnecteur;
  };
  const CAS: Cas<C>[] = [
    C("déclaration conforme, une garantie par action", "vide", async (b) => {
      const cap = b.connecteur.declaration?.capacites ?? [];
      verifier(cfg.actions.every((a) => cap.some((c) => c.action === a && !!c.garantie)), "capacité manquante");
      verifier(cfg.methodes.every((m) => typeof (b.connecteur as Record<string, unknown>)[m] === "function"), "méthode manquante");
    }),
    C("action nominale", "nominal", async (b) => { verifier((await cfg.nominal(b.connecteur, b.jeton)) !== undefined, "réponse attendue"); }),
    C("écriture une seule fois pour la même clé", "ecriture", async (b) => {
      await cfg.ecriture(b.connecteur, b.jeton);
      await attraper(() => cfg.ecriture(b.connecteur, b.jeton));
      verifier(b.effets() === 1, "un seul effet attendu");
    }),
    ...(cfg.extra ?? []),
    C("quota avec date de reprise", { nom: "quota", panne: "quota" }, async (b) => { verifier(!Number.isNaN(Date.parse((await erreurClasse(b, "quota")).details.reprise ?? "")), "date de reprise attendue"); }),
    C("jeton refusé", { nom: "jeton", panne: "jeton" }, async (b) => { await erreurClasse(b, "identification"); }),
    C("panne 503", { nom: "http_503", panne: "http_503" }, async (b) => { await erreurClasse(b, "passagere"); }),
    C("erreur inattendue", { nom: "inattendue", panne: "inattendue" }, async (b) => { await erreurClasse(b, "definitive"); }),
  ];
  const jouerSuite = async (fabrique: Fabrique): Promise<{ nom: string; ok: boolean; detail?: string }[]> => {
    const rapport = [];
    for (const cas of CAS) {
      try {
        await cas.jouer(await fabrique(cas.scenario));
        rapport.push({ nom: cas.nom, ok: true });
      } catch (e) {
        rapport.push({ nom: cas.nom, ok: false, detail: (e as Error).message });
      }
    }
    return rapport;
  };
  return { CAS, fabriqueMemoire, jouerSuite };
}

const D1 = "2026-11-02T09:00:00Z";
const D2 = "2026-11-02T10:00:00Z";
export const { CAS, fabriqueMemoire, jouerSuite } = creerSuite<ConnecteurAgenda>({
  famille: "agenda",
  actions: ACTIONS_AGENDA,
  garanties: { lister_creneaux: "au_plus_une_fois", creer_evenement: "idempotent_par_cle" },
  methodes: ["listerCreneaux", "creerEvenement"],
  connecteur: (a) => ({
    listerCreneaux: (j, debut, fin) => a.proteger(j, () => [{ debut, fin }]),
    creerEvenement: (j, e) => a.proteger(j, () => ({ id: a.ecrire(e.cle, "evt") })),
  }),
  nominal: (c, j) => c.listerCreneaux(j, D1, D2),
  ecriture: (c, j) => c.creerEvenement(j, { cle: "cle-1", debut: D1, fin: D2, titre: "Essai" }),
});
