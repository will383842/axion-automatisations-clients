import { createHash, randomUUID } from "node:crypto";
import { appeler, ErreurCoffre, validerTenant, type OptionsBao } from "../coffre/coffre.js";
import { nomBaseDe } from "../provisionnement/etapes-base.js";
import { dechiffrerFlux } from "./chiffrement-flux.js";
import { cheminDump } from "./dump-client.js";

// Restauration d'UN client (T2-40, A-240, C-048, C-536) : toujours dans une base TEMPORAIRE « cli_<id>_restau_<n> », jamais sur place.
// Rien n'est supprimé ici sauf ce que l'outil vient de créer : la base temporaire en cas d'échec, l'instance jetable (qui ne contient que des copies).

export type SourceRestauration = { depuis: "dump"; date: string } | { depuis: "instant"; horodatage: string };
export interface Restauration {
  id: string;
  tenantId: string;
  nomBase: string;
  numero: number;
  source: SourceRestauration;
  etat: "prete";
}
export interface InstanceJetable {
  /** pg_dump de la seule base demandée, lue dans la copie. */
  dumper(nomBase: string): AsyncIterable<Buffer>;
  detruire(): Promise<void>;
}
export interface PortsRestauration {
  bao: OptionsBao;
  lireDump(chemin: string): AsyncIterable<Buffer>;
  /** Empreinte sha256 (hex) du dump chiffré, notée par dumperClient à la sauvegarde ; absente = pas de restauration. */
  empreinteEnregistree(tenantId: string, date: string): Promise<string | undefined>;
  /** pgBackRest du dépôt « données » à l'instant voulu ; la phrase du dépôt est lue dans OpenBao à l'usage. */
  demarrerInstanceJetable(horodatage: string): Promise<InstanceJetable>;
  numeroSuivant(tenantId: string): Promise<number>;
  rolesDuClient(tenantId: string): Promise<string[]>;
  /** CREATE DATABASE, REVOKE CONNECT FROM PUBLIC, GRANT CONNECT aux seuls rôles donnés. Ici toujours []: la base reste verrouillée jusqu'à la bascule (basculer.ts). */
  creerBaseTemporaire(nomBase: string, rolesAutorises: string[]): Promise<void>;
  /** pg_restore dans la base temporaire. */
  charger(nomBase: string, flux: AsyncIterable<Buffer>): Promise<void>;
  /** Ne retire qu'une base dont le nom porte « _restau_ » (l'adaptateur le revérifie). */
  retirerBaseTemporaire(nomBase: string): Promise<void>;
  enregistrer(r: Restauration): Promise<void>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function valider(source: SourceRestauration): void {
  const ok = source.depuis === "dump" ? DATE.test(source.date) : source.depuis === "instant" && INSTANT.test(source.horodatage) && !Number.isNaN(Date.parse(source.horodatage));
  if (!ok) throw new Error("source_invalide");
}

const ouvrirCle = (p: PortsRestauration, tenantId: string) => async (e: { cleChiffree: string }): Promise<Buffer> => {
  const r = (await appeler(p.bao, "POST", `transit/decrypt/cli-${tenantId}`, { ciphertext: e.cleChiffree })) as { data?: { plaintext?: unknown } } | undefined;
  const cle = typeof r?.data?.plaintext === "string" ? Buffer.from(r.data.plaintext, "base64") : Buffer.alloc(0);
  if (cle.length !== 32) throw new ErreurCoffre("coffre_indisponible");
  return cle;
};

// Le dump est lu en flux (jamais plus d'un bloc en mémoire) : 1) empreinte seule ; 2) lecture à blanc qui ouvre la clé du client et authentifie TOUS les blocs
// (dump altéré, coupé ou d'un autre client : échec ici) ; 3) la vraie lecture pour pg_restore, qui recompare l'empreinte. Rien n'est créé avant la fin de 1 et 2.
async function* surveiller(source: AsyncIterable<Buffer>, attendue: string): AsyncGenerator<Buffer> {
  const h = createHash("sha256");
  for await (const m of source) { h.update(m); yield m; }
  if (h.digest("hex") !== attendue) throw new Error("empreinte_differente");
}
async function controlerDump(p: PortsRestauration, tenantId: string, date: string, attendue: string): Promise<void> {
  const chemin = cheminDump(tenantId, date);
  for await (const _ of surveiller(p.lireDump(chemin), attendue)) void _;
  for await (const _ of dechiffrerFlux(p.lireDump(chemin), tenantId, ouvrirCle(p, tenantId))) void _;
}

export async function preparerRestauration(p: PortsRestauration, tenantId: string, source: SourceRestauration): Promise<Restauration> {
  validerTenant(tenantId);
  valider(source);
  const numero = await p.numeroSuivant(tenantId);
  const nomBase = `${nomBaseDe(tenantId)}_restau_${numero}`;
  let instance: InstanceJetable | undefined;
  let creee = false;
  let resultat: Restauration | undefined;
  let destruction: { e: unknown } | undefined;
  try {
    let flux: AsyncIterable<Buffer>;
    if (source.depuis === "dump") {
      const attendue = await p.empreinteEnregistree(tenantId, source.date);
      if (typeof attendue !== "string" || !/^[0-9a-f]{64}$/.test(attendue)) throw new Error("empreinte_absente");
      await controlerDump(p, tenantId, source.date, attendue);
      flux = dechiffrerFlux(surveiller(p.lireDump(cheminDump(tenantId, source.date)), attendue), tenantId, ouvrirCle(p, tenantId));
    } else {
      instance = await p.demarrerInstanceJetable(source.horodatage);
      flux = instance.dumper(nomBaseDe(tenantId));
    }
    // Verrouillée : aucun rôle du client n'y entre avant la bascule.
    creee = true;
    await p.creerBaseTemporaire(nomBase, []);
    await p.charger(nomBase, flux);
    const r: Restauration = { id: randomUUID(), tenantId, nomBase, numero, source, etat: "prete" };
    await p.enregistrer(r);
    resultat = r;
  } catch (e) {
    // Une erreur de nettoyage ne remplace jamais l'erreur d'origine ; la base, sans droit client, reste fermée.
    if (creee) await p.retirerBaseTemporaire(nomBase).catch(() => {});
    throw e;
  } finally {
    try { await instance?.detruire(); } catch (e) { destruction = { e }; }
  }
  // Réussite seulement : une copie jetable qui ne se détruit pas est une erreur, mais elle ne masque jamais une erreur d'origine.
  if (destruction) throw destruction.e;
  return resultat!;
}
