import { z } from "zod";
import { Donnees } from "../../../../packages/contrats/src/c4/donnees.ts";
import { MODELE_BASE_CLIENT, executerLecture, genererSql, verifierForme, type Modele } from "@axion-auto/donnees-module";
import { ErreurApi } from "../plugins/erreurs.js";
import type { PortsDonnees } from "./service.js";
import { schemaParametres, type RequeteDeclaree } from "./requetes/structure.js";

// Requêtes déclarées par les versions INSTALLÉES chez CE client (T2-49, ADR 0109, ADR 0112) : LECTURE SEULE de `commun`. Aucune écriture, aucune action (T2-55).
// Tout ce qui décide de la base vient de la SESSION : l'instance est cherchée sous le client de la session (une instance d'un autre client est « introuvable », sans différence avec une absente),
// la base vient de bases_client, le rôle est toujours « lecture ». Le SQL est produit par genererSql du paquet donnees-module après verifierForme (rien n'est recopié). Pas de cache du manifeste.
export interface InstanceInstallee {
  etat: "actif" | "pause" | "arrete";
  installee: boolean; // la version est installée chez ce client
  ecart: boolean; // client ou instance à l'écart
  impaye: boolean; // pause pour impayé
  donnees: unknown; // champ `donnees` du manifeste de CETTE version installée
}
export interface SessionPortail { tenantId: string; role: "client" | "equipe"; acteur: string; etablissements: string[] }
// CONTRAT DE CONNEXION : `ouvrir` DOIT rendre une session DÉDIÉE (un pg.PoolClient pris au pool, jamais le pg.Pool lui-même) et `fermer` la rend. executerLecture envoie BEGIN READ ONLY,
// SET LOCAL statement_timeout, le SELECT et COMMIT en appels séparés : sur un Pool.query ils partiraient sur des connexions différentes, le SELECT sortirait de la transaction en lecture seule
// et sans délai. Une session ne sert jamais deux clients. Preuve due : dette T2-49-branchement-lecture-declaree (T2-55), essai d'intégration à deux vraies bases.
export interface PortsDeclarees extends Pick<PortsDonnees, "base" | "ouvrir" | "maintenant"> {
  // Cherche l'instance SOUS ce client seulement (RLS) ; absente ou d'un autre client : undefined.
  instance(tenantId: string, instanceId: string): Promise<InstanceInstallee | undefined>;
  // La permission déclarée est-elle accordée au rôle de l'utilisateur (T6-02) ?
  permissionAccordee(tenantId: string, acteur: string, permission: string): Promise<boolean>;
}

const DELAI_MS = 5000;
const MAX_LIGNES = 200;
const SessionZ = z.object({ tenantId: z.uuid(), role: z.literal("client"), acteur: z.string().min(1), etablissements: z.array(z.uuid()) });
const NOM = /^[a-z][a-z0-9-]{1,40}$/;
const introuvable = () => new ErreurApi("introuvable", "Ressource introuvable.");
const interdit = () => new ErreurApi("action_interdite", "Action interdite.");

export function creerRequetesDeclarees(ports: PortsDeclarees, modele: Modele = MODELE_BASE_CLIENT) {
  return {
    async lire(sessionBrute: SessionPortail, instanceId: string, nom: string, parametres: unknown): Promise<Record<string, unknown>[]> {
      const s = SessionZ.safeParse(sessionBrute);
      if (!s.success) throw interdit();
      const session = s.data;
      if (!z.uuid().safeParse(instanceId).success || !NOM.test(nom)) throw introuvable();
      try {
        const inst = await ports.instance(session.tenantId, instanceId);
        if (!inst || !inst.installee || inst.ecart || inst.impaye || inst.etat !== "actif") throw introuvable();
        // Échec fermé : le manifeste est relu en C4 0.5.0 puis la forme revérifiée contre le modèle à chaque appel.
        const lu = Donnees.safeParse(inst.donnees);
        const r = lu.success ? lu.data.requetes.find((x) => x.nom === nom) : undefined;
        if (!lu.success || lu.data.actions.length > 0 || !r || verifierForme(r.forme, r.parametres, modele).refus.length > 0) throw introuvable();
        if (r.permission !== undefined && !(await ports.permissionAccordee(session.tenantId, session.acteur, r.permission))) throw interdit();
        // Aucune clé hors de celles déclarées : un identifiant de client, de base ou d'établissement n'est jamais un paramètre.
        const brut = parametres ?? {};
        if (typeof brut !== "object" || Array.isArray(brut) || Object.keys(brut).some((k) => !Object.hasOwn(r.parametres, k))) throw new ErreurApi("schema_invalide", "Requête invalide.");
        const p = schemaParametres(r as unknown as RequeteDeclaree).safeParse(brut);
        if (!p.success) throw new ErreurApi("schema_invalide", "Requête invalide.");

        const base = await ports.base(session.tenantId);
        if (!base || base.etat !== "active") throw introuvable();
        const connexion = await ports.ouvrir(base.nomBase, "lecture");
        try {
          const g = genererSql(r.forme, r.parametres, p.data, session.etablissements, modele);
          const lignes = await executerLecture({ query: async (t, v) => ({ rows: await connexion.requete(t, v ?? []) }) }, g, { delaiMs: DELAI_MS });
          return lignes.slice(0, MAX_LIGNES).map((l) => Object.fromEntries(g.colonnes.filter((c) => c in l).map((c) => [c, l[c]])));
        } finally {
          await connexion.fermer().catch(() => undefined);
        }
      } catch (e) {
        // Aucun détail technique, SQL ni nom de base ne sort.
        throw e instanceof ErreurApi ? e : new ErreurApi("porte_fermee", "Service indisponible.");
      }
    },
  };
}
