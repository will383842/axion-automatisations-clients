import pg from "pg";
import { afterAll, beforeAll } from "vitest";

// Verrou de la grappe « donnees » du socle d'essai, entre fichiers .int.test.ts qui tournent en parallèle (aide de test, jamais en production).
// Cause mesurée des 53300 en CI : [A-236] (tests/donnees/grappe.int.test.ts) sature EXPRÈS les 250 places ordinaires de la grappe ; un autre fichier qui s'y
// connecte au même moment avec un rôle sans places réservées (_mod_, _app, _lecture) est refusé. Les fichiers qui utilisent la grappe prennent le verrou PARTAGÉ
// (ils tournent ensemble) ; A-236 prend le verrou EXCLUSIF (il attend qu'ils finissent, et eux attendent la retombée de sa charge).
// Verrou consultatif PostgreSQL tenu par une connexion du provisionneur (places réservées : jamais refusée pendant la saturation) ; rendu par le serveur si le processus meurt.
export const CLE_VERROU_GRAPPE = "236000236";
// Attente bornée : un fichier de la grappe dure au plus quelques minutes ; au-delà, échec clair (55P03) plutôt qu'une attente sans fin.
const ATTENTE_MS = 540_000;

export type ClientVerrou = { connect(): Promise<unknown>; end(): Promise<unknown>; on(e: "error", f: () => void): unknown; query(texte: string, valeurs?: unknown[]): Promise<unknown> };
export type Verrou = { liberer: () => Promise<void> };
const noop = () => undefined;

export async function prendreVerrou(fabrique: () => ClientVerrou, options: { exclusif: boolean; attenteMs?: number }): Promise<Verrou> {
  const suffixe = options.exclusif ? "" : "_shared";
  const c = fabrique();
  c.on("error", noop);
  try {
    await c.connect();
    await c.query(`SET lock_timeout = ${Math.trunc(options.attenteMs ?? ATTENTE_MS)}`);
    await c.query(`SELECT pg_advisory_lock${suffixe}($1)`, [CLE_VERROU_GRAPPE]);
  } catch (e) {
    await c.end().catch(noop);
    throw e;
  }
  return {
    liberer: async () => {
      await c.query(`SELECT pg_advisory_unlock${suffixe}($1)`, [CLE_VERROU_GRAPPE]).catch(noop);
      await c.end().catch(noop);
    },
  };
}

// Adresse du provisionneur (connexion DIRECTE, socket de l'hôte) ; seule la base « postgres » sert au verrou.
const fabriquer = (urlAdmin: string) => () => {
  const u = new URL(urlAdmin);
  u.pathname = "/postgres";
  return new pg.Client({ connectionString: u.toString(), application_name: "verrou-grappe" });
};

// À appeler en haut d'un fichier .int.test.ts qui se connecte à la grappe données : verrou partagé du premier au dernier essai du fichier.
export function grappePartagee(urlAdmin: () => string): void {
  let verrou: Verrou | undefined;
  beforeAll(async () => { verrou = await prendreVerrou(fabriquer(urlAdmin()), { exclusif: false }); }, ATTENTE_MS + 30_000);
  afterAll(async () => { await verrou?.liberer(); });
}

// Pour l'essai qui sature la grappe : verrou exclusif, à rendre (liberer) après la retombée des connexions.
export const reserverGrappe = (urlAdmin: string): Promise<Verrou> => prendreVerrou(fabriquer(urlAdmin), { exclusif: true });
