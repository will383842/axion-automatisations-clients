import { createHash } from "node:crypto";
import { z } from "zod";
import { Donnees } from "@axion-auto/contrats/src/c4/donnees.ts";
import { schemaValeur } from "@axion-auto/contrats/src/c4/forme.ts";
import { MODELE_BASE_CLIENT, executerLecture, genererSql, verifierForme, type ClientLecture, type Modele } from "@axion-auto/donnees-module";
import type { PortDonnees } from "@axion-auto/sdk-module";
import type { BaseLecture } from "../courtier/client.ts";
import type { LimitesDonnees } from "./limites.ts";

// Port `donnees` de l'exécuteur (T4-50d, ADR 0109, 0112, 0113) : LECTURE SEULE de `commun`, par les requêtes déclarées en structure par la version installée chez CE client.
// Tout ce qui décide de la base vient du CONTEXTE de l'exécution (fixé par l'exécuteur à partir de sa tâche), jamais du module : le module ne donne qu'un nom et des paramètres déclarés.
//   - la base et le rôle sont remis par le courtier pour (client, tâche) : cli_<id>_lecture, jamais _app ; la session ouverte est revérifiée (current_user, current_database) ;
//   - une connexion DÉDIÉE par appel, rendue à la fin (avec l'erreur si elle est perdue) : aucune connexion n'est gardée ni passée d'un appel ou d'un client à l'autre ;
//   - le manifeste est relu à chaque appel ; seule sa vérification contre le modèle est mise en cache, par (client, empreinte de version).
// Les erreurs ne portent que le code : ni SQL, ni nom de base, ni message de la base.
export type CodeDonnees = "introuvable" | "interdit" | "schema_invalide" | "indisponible";
const MESSAGES: Record<CodeDonnees, string> = { introuvable: "Requête introuvable.", interdit: "Requête interdite.", schema_invalide: "Paramètres invalides.", indisponible: "Données indisponibles." };
export class ErreurDonnees extends Error {
  constructor(readonly code: CodeDonnees) { super(MESSAGES[code]); this.name = "ErreurDonnees"; }
}

export interface InstanceInstallee {
  empreinte: string; // empreinte de la version installée
  installee: boolean;
  ecart: boolean;
  impaye: boolean;
  etat: "actif" | "pause" | "arrete";
  donnees: unknown; // champ `donnees` du manifeste de CETTE version
}
// Session dédiée : `liberer(err)` la rend ; avec une erreur, elle doit être détruite (jamais remise à un pool).
export interface ConnexionLecture extends ClientLecture { liberer(erreur?: Error): void }
export interface TraceLecture { correlation: string; requete: string; statut: "ok" | "refus" | "erreur"; lignes: number }
export interface PortsLecture {
  // Cherche l'instance SOUS ce client seulement ; absente ou d'un autre client : undefined.
  instance(tenantId: string, instanceId: string): Promise<InstanceInstallee | undefined>;
  baseLecture(tenantId: string, idTache: string): Promise<BaseLecture>; // courtier (demanderBaseLecture)
  ouvrir(base: BaseLecture): Promise<ConnexionLecture>; // session dédiée, avec l'hôte, la base, le rôle et le mot de passe remis
  tracer(trace: TraceLecture): void; // jamais de paramètre ni de ligne
}
export interface ContexteLecture { tenantId: string; instanceId: string; idTache: string; correlation: string }

const UUID = z.uuid();
const CORRELATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_TACHE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const BASE = /^cli_[0-9a-f]{12}$/;
const CACHE_MAX = 64;
const SQL_ETABLISSEMENTS = "SELECT current_user::text AS u, current_database()::text AS d, e.id::text AS id FROM (SELECT 1) s LEFT JOIN commun.etablissements e ON true LIMIT $1::int";
const MAX_ETABLISSEMENTS = 1000;
// Même dérivation que le courtier (ADR 0046) : 12 premiers caractères hexadécimaux de l'UUID du client.
const nomBaseDe = (tenantId: string): string => `cli_${tenantId.replaceAll("-", "").slice(0, 12).toLowerCase()}`;
type Requete = z.infer<typeof Donnees>["requetes"][number];

export function creerFabriquePort(ports: PortsLecture, limites: LimitesDonnees, modele: Modele = MODELE_BASE_CLIENT): (ctx: ContexteLecture) => PortDonnees {
  // (client | empreinte | condensat du contenu lu) -> requêtes déjà vérifiées contre le modèle ; null = manifeste refusé. Propre à chaque client.
  const cache = new Map<string, ReadonlyMap<string, Requete> | null>();

  // Une lecture à la fois par client : CONNECTION LIMIT de _lecture (2) est partagée avec la console, un module ne doit pas la saturer.
  const files = new Map<string, Promise<unknown>>();
  async function enSerie<T>(tenantId: string, tache: () => Promise<T>): Promise<T> {
    const suite = (files.get(tenantId) ?? Promise.resolve()).then(tache);
    const marque = suite.catch(() => undefined);
    files.set(tenantId, marque);
    try { return await suite; } finally { if (files.get(tenantId) === marque) files.delete(tenantId); }
  }

  // Délai TOTAL (file, courtier, ouverture, lecture) : au-delà, l'appelant reçoit « indisponible » ; l'appel en cours libère sa connexion à sa propre fin.
  function avecDelaiTotal<T>(travail: Promise<T>): Promise<T> {
    let minuteur: NodeJS.Timeout | undefined;
    const limite = new Promise<never>((_, rejeter) => { minuteur = setTimeout(() => rejeter(new ErreurDonnees("indisponible")), limites.delaiTotalMs); });
    travail.catch(() => undefined);
    return Promise.race([travail, limite]).finally(() => clearTimeout(minuteur));
  }

  function verifie(cle: string, donnees: unknown): ReadonlyMap<string, Requete> | null {
    if (cache.has(cle)) return cache.get(cle)!;
    const lu = Donnees.safeParse(donnees);
    const ok = lu.success && lu.data.actions.length === 0 ? new Map(lu.data.requetes.filter((r) => verifierForme(r.forme, r.parametres, modele).refus.length === 0).map((r) => [r.nom, r])) : null;
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(cle, ok);
    return ok;
  }

  return (ctx) => {
    if (!UUID.safeParse(ctx.tenantId).success || !UUID.safeParse(ctx.instanceId).success || !ID_TACHE.test(ctx.idTache) || !CORRELATION.test(ctx.correlation)) throw new Error("contexte d'exécution illisible");
    const { tenantId, instanceId, idTache, correlation } = ctx;

    async function appel(nom: string, parametres: unknown): Promise<{ lignes: Record<string, unknown>[] }> {
      const inst = await ports.instance(tenantId, instanceId).catch(() => { throw new ErreurDonnees("indisponible"); });
      if (!inst || !inst.installee || inst.ecart || inst.impaye || inst.etat !== "actif") throw new ErreurDonnees("introuvable");
      const r = typeof nom === "string" ? verifie(`${tenantId}|${inst.empreinte}|${createHash("sha256").update(JSON.stringify(inst.donnees) ?? "").digest("hex")}`, inst.donnees)?.get(nom) : undefined; // Map : « __proto__ » n'est membre de rien
      if (!r) throw new ErreurDonnees("introuvable");
      // L'exécuteur n'a pas d'utilisateur : une permission déclarée ne peut pas être évaluée, la requête est refusée.
      if (r.permission !== undefined) throw new ErreurDonnees("interdit");
      // Aucune clé hors de celles déclarées : un identifiant de client, de base ou d'établissement n'est jamais un paramètre.
      const brut = parametres ?? {};
      if (typeof brut !== "object" || Array.isArray(brut) || Object.keys(brut).some((k) => !Object.hasOwn(r.parametres, k))) throw new ErreurDonnees("schema_invalide");
      const forme: Record<string, z.ZodType> = {};
      for (const [n, p] of Object.entries(r.parametres)) forme[n] = p.defaut === undefined ? schemaValeur(p) : schemaValeur(p).default(p.defaut as never);
      const valeurs = z.strictObject(forme).safeParse(brut);
      if (!valeurs.success) throw new ErreurDonnees("schema_invalide");

      let base: BaseLecture;
      let connexion: ConnexionLecture;
      try {
        base = await ports.baseLecture(tenantId, idTache);
        if (!BASE.test(base.base) || base.base !== nomBaseDe(tenantId) || base.role !== `${nomBaseDe(tenantId)}_lecture` || !limites.hotes.includes(base.hote)) throw new Error("remise_illisible");
        connexion = await ports.ouvrir(base);
      } catch { throw new ErreurDonnees("indisponible"); }
      let perdue: Error | undefined; // défini sur toute erreur
      try {
        // Établissements : tous ceux de la base lus par la connexion de lecture ; la même lecture revérifie l'identité de la session ouverte.
        const sonde = await executerLecture(connexion, { texte: SQL_ETABLISSEMENTS, valeurs: [MAX_ETABLISSEMENTS + 1] }, { delaiMs: limites.delaiMs });
        if (sonde.length === 0 || sonde.some((l) => l["u"] !== base.role || l["d"] !== base.base)) throw new Error("identite_session");
        if (sonde.length > MAX_ETABLISSEMENTS) throw new Error("trop_d_etablissements"); // jamais une lecture partielle
        const etablissements = sonde.map((l) => l["id"]).filter((i): i is string => typeof i === "string");
        const g = genererSql(r.forme, r.parametres, valeurs.data, etablissements, modele);
        const lignes = await executerLecture(connexion, g, { delaiMs: limites.delaiMs });
        return { lignes: lignes.slice(0, limites.maxLignes).map((l) => Object.fromEntries(g.colonnes.filter((c) => c in l).map((c) => [c, l[c]]))) };
      } catch (e) {
        perdue = e instanceof Error ? e : new Error("lecture_echouee"); // la session est dédiée à cet appel : après une erreur elle est toujours détruite, jamais réutilisée
        throw new ErreurDonnees("indisponible");
      } finally {
        try { connexion.liberer(perdue); } catch { /* la connexion est abandonnée */ }
      }
    }

    return {
      async lire(nom, parametres) {
        try {
          const { lignes } = await avecDelaiTotal(enSerie(tenantId, () => appel(nom, parametres)));
          try { ports.tracer({ correlation, requete: nom, statut: "ok", lignes: lignes.length }); } catch { /* la trace ne change pas la réponse */ }
          return lignes;
        } catch (e) {
          const refus = e instanceof ErreurDonnees && e.code !== "indisponible";
          try { ports.tracer({ correlation, requete: nom, statut: refus ? "refus" : "erreur", lignes: 0 }); } catch { /* la trace ne change pas la réponse */ }
          throw e instanceof ErreurDonnees ? e : new ErreurDonnees("indisponible");
        }
      },
    };
  };
}
