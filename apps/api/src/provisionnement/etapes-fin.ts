import { randomUUID } from "node:crypto";
import type { ContexteChamp } from "../donnees/colonnes-chiffrees.js";
import type { ContexteBase, Sql } from "./etapes-base.js";
import { ErreurEtape, type Etape } from "./machine.js";

// Étapes 8 (fumée) et 9 (inscription) du provisionnement (T2-35), assemblage des neuf étapes et mesure de durée (A-223, C-473).
export const SEUIL_CREATION_MS = 120_000;
const VERSION_MAX = 999_999_999;
export interface ConnexionApp extends Sql { fermer(): Promise<void> }
export interface PortsFin {
  // Connexion de cli_<id>_app À TRAVERS PgBouncer (mot de passe lu au coffre par l'adaptateur) ; la fumée y ouvre une transaction qu'elle ANNULE toujours.
  connexionApp(nomBase: string): Promise<ConnexionApp>;
  colonnes: {
    chiffrerChamp(tenantId: string, valeur: string, contexte: ContexteChamp): Promise<Uint8Array>;
    dechiffrerChamp(tenantId: string, octets: Uint8Array, contexte: ContexteChamp): Promise<string>;
  };
  // Compartiment cli-<id> du client de la tâche.
  objets: { deposer(tenantId: string, cle: string, octets: Uint8Array): Promise<void>; lire(tenantId: string, cle: string): Promise<Uint8Array | undefined>; retirer(tenantId: string, cle: string): Promise<void> };
  // Dernière version de structure appliquée à la base (public.version_structure) ; 0 si illisible.
  versionStructure(nomBase: string): Promise<number>;
  registre: { activer(tenantId: string, versionStructure: number): Promise<void>; estActive(tenantId: string): Promise<boolean> };
  // Journal d'audit par la base (T2-01). Fait CRM ou Hub : aucun.
  trace: { tracer(e: { action: "base_client_creee"; tenantId: string; versionStructure: number }): Promise<void> };
}

export function etapesFin(p: PortsFin): Etape<ContexteBase>[] {
  return [
    {
      numero: 8,
      nom: "fumee",
      // La fumée se rejoue à chaque passage : elle ne laisse rien derrière elle, donc rien à ne pas refaire.
      dejaFait: async () => false,
      async faire(ctx) {
        const eprouve = `fumee/${randomUUID()}`;
        const octets = Buffer.from(`essai-${randomUUID()}`);
        try {
          const idLigne = randomUUID();
          const contexte = { colonne: "personnes.courriel_chiffre", idLigne };
          const valeur = `fumee-${idLigne}@exemple.fr`;
          const c = await p.connexionApp(ctx.nomBase);
          try {
            await c.requete("BEGIN");
            try {
              const etablissement = (await c.requete<{ id: string }>("INSERT INTO commun.etablissements (nom) VALUES ('fumee') RETURNING id"))[0]?.id;
              const chiffre = await p.colonnes.chiffrerChamp(ctx.tenantId, valeur, contexte);
              await c.requete("INSERT INTO commun.personnes (id, etablissement_id, nom, courriel_chiffre) VALUES ($1, $2, 'fumee', $3)", [idLigne, etablissement, Buffer.from(chiffre)]);
              const lu = (await c.requete<{ courriel_chiffre: Uint8Array }>("SELECT courriel_chiffre FROM commun.personnes WHERE id = $1", [idLigne]))[0]?.courriel_chiffre;
              if (!lu || (await p.colonnes.dechiffrerChamp(ctx.tenantId, lu, contexte)) !== valeur) throw new Error("relecture");
            } finally {
              await c.requete("ROLLBACK");
            }
          } finally {
            await c.fermer();
          }
          await p.objets.deposer(ctx.tenantId, eprouve, octets);
          const relu = await p.objets.lire(ctx.tenantId, eprouve);
          if (!relu || Buffer.compare(Buffer.from(relu), octets) !== 0) throw new Error("objet");
        } catch {
          // Le texte de la cause ne sort jamais ; l'objet d'essai est retiré avant l'échec s'il a été déposé.
          await p.objets.retirer(ctx.tenantId, eprouve).catch(() => undefined);
          throw new ErreurEtape("fumee_echouee");
        }
        await p.objets.retirer(ctx.tenantId, eprouve).catch(() => { throw new ErreurEtape("fumee_echouee"); });
      },
    },
    {
      numero: 9,
      nom: "inscription",
      dejaFait: (ctx) => p.registre.estActive(ctx.tenantId),
      async faire(ctx) {
        const version = await p.versionStructure(ctx.nomBase).catch(() => 0);
        if (!Number.isInteger(version) || version < 1 || version > VERSION_MAX) throw new ErreurEtape("version_illisible");
        // Trace d'abord, inscription ensuite : un plantage entre les deux rejoue l'étape (dejaFait faux) sans base marquée active à tort.
        await p.trace.tracer({ action: "base_client_creee", tenantId: ctx.tenantId, versionStructure: version }).catch(() => { throw new ErreurEtape("trace_echouee"); });
        await p.registre.activer(ctx.tenantId, version).catch(() => { throw new ErreurEtape("inscription_echouee"); });
      },
    },
  ];
}

// Les neuf étapes dans l'ordre 1 à 9 ; un trou ou un doublon est une erreur de montage, jamais une base à moitié provisionnée.
export function assemblerEtapes<C>(...groupes: Etape<C>[][]): Etape<C>[] {
  const toutes = groupes.flat().sort((a, b) => a.numero - b.numero);
  if (toutes.length !== 9 || toutes.some((e, i) => e.numero !== i + 1)) throw new Error("étapes de provisionnement : les neuf étapes 1 à 9 sont attendues, chacune une fois");
  return toutes;
}

// Mesure (A-223, C-473) : durée de chaque création de bout en bout ; le seuil de 2 minutes est une constante, jamais un paramètre.
export interface Mesure { durees: number[]; mediane: number; maximum: number; toutesSousLeSeuil: boolean }
export async function mesurerCreations(n: number, creer: () => Promise<void>, horloge: () => number): Promise<Mesure> {
  const durees: number[] = [];
  for (let i = 0; i < n; i++) {
    const debut = horloge();
    await creer();
    durees.push(horloge() - debut);
  }
  const triees = durees.slice().sort((a, b) => a - b);
  return { durees, mediane: triees[Math.floor(triees.length / 2)] ?? 0, maximum: triees.at(-1) ?? 0, toutesSousLeSeuil: durees.every((d) => d < SEUIL_CREATION_MS) };
}
export const formaterMesure = (m: Mesure, o: { date: string; machine: string }): string =>
  `Mesure du ${o.date} sur ${o.machine} : ${m.durees.length} créations, médiane ${Math.round(m.mediane / 1000)} s, maximum ${Math.round(m.maximum / 1000)} s, seuil ${SEUIL_CREATION_MS / 1000} s : ${m.toutesSousLeSeuil ? "respecté" : "DÉPASSÉ"}.`;
