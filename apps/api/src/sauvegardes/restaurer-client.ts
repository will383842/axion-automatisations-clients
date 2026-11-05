import { randomUUID } from "node:crypto";
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
  /** pgBackRest du dépôt « données » à l'instant voulu ; la phrase du dépôt est lue dans OpenBao à l'usage. */
  demarrerInstanceJetable(horodatage: string): Promise<InstanceJetable>;
  numeroSuivant(tenantId: string): Promise<number>;
  rolesDuClient(tenantId: string): Promise<string[]>;
  /** CREATE DATABASE, REVOKE CONNECT FROM PUBLIC, GRANT CONNECT aux seuls rôles donnés. */
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

export async function preparerRestauration(p: PortsRestauration, tenantId: string, source: SourceRestauration): Promise<Restauration> {
  validerTenant(tenantId);
  valider(source);
  const numero = await p.numeroSuivant(tenantId);
  const nomBase = `${nomBaseDe(tenantId)}_restau_${numero}`;
  let instance: InstanceJetable | undefined;
  let creee = false;
  try {
    // La clé du client ouvre le dump ; clé détruite → le coffre refuse, rien n'est restauré.
    const flux = source.depuis === "dump"
      ? dechiffrerFlux(p.lireDump(cheminDump(tenantId, source.date)), tenantId, async (e) => {
          const r = (await appeler(p.bao, "POST", `transit/decrypt/cli-${tenantId}`, { ciphertext: e.cleChiffree })) as { data?: { plaintext?: unknown } } | undefined;
          const cle = typeof r?.data?.plaintext === "string" ? Buffer.from(r.data.plaintext, "base64") : Buffer.alloc(0);
          if (cle.length !== 32) throw new ErreurCoffre("coffre_indisponible");
          return cle;
        })
      : (instance = await p.demarrerInstanceJetable(source.horodatage)).dumper(nomBaseDe(tenantId));
    await p.creerBaseTemporaire(nomBase, await p.rolesDuClient(tenantId));
    creee = true;
    await p.charger(nomBase, flux);
    const r: Restauration = { id: randomUUID(), tenantId, nomBase, numero, source, etat: "prete" };
    await p.enregistrer(r);
    return r;
  } catch (e) {
    if (creee) await p.retirerBaseTemporaire(nomBase);
    throw e;
  } finally {
    await instance?.detruire();
  }
}
