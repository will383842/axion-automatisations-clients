import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { appeler, ErreurCoffre, validerTenant, type OptionsBao } from "../coffre/coffre.js";
import { calculerRetention } from "../../../../ops/sauvegardes/retention.js";
import { chiffrerFlux } from "./chiffrement-flux.js";

// Sauvegarde de nuit d'UNE base client (T2-39, A-238, A-239, A-244, C-047) : pg_dump en flux → chiffrement par blocs → cible.
// Rien n'est écrit en clair sur le disque (ce module n'importe aucune fonction d'écriture de fichier) et rien n'est mélangé entre clients :
// la clé de données vient de la clé transit du client (cli-<id>), propre à ce dump, et le client est lié à chaque bloc.
// Détruire la clé d'un client (effacement décidé par Will, T2-45) rend ses dumps illisibles ; la fin de contrat, elle, garde la clé.

export interface BaseADumper {
  tenantId: string;
  nomBase: string;
  etat: string;
}
// La cible (Storage Box ; SFTP d'essai) : `deposer` est atomique (rien de partiel visible) et refuse d'écraser un dump existant.
export interface Cible {
  deposer(chemin: string, flux: AsyncIterable<Buffer>): Promise<void>;
  lister(prefixe: string): Promise<string[]>;
  retirer(chemin: string): Promise<void>;
}
export interface DepsDump {
  bao: OptionsBao;
  lancerDump: (nomBase: string) => Readable;
  cible: Cible;
  marquerSauvegarde: (tenantId: string, le: Date) => Promise<void>;
  maintenant?: () => Date;
  /** Pour les tests : reçoit la clé de données en clair APRÈS sa remise à zéro. */
  observerCle?: (cle: Buffer) => void;
}

// Une base en création n'a rien à sauvegarder ; une base effacée n'existe plus. Gelée, à l'écart ou exportée : la sauvegarde continue tant que la clé existe.
const SAUVEGARDEES = new Set(["active", "gelee", "exportee", "a_l_ecart"]);
export const aSauvegarder = (b: BaseADumper) => SAUVEGARDEES.has(b.etat);

const idCourt = (tenantId: string) => validerTenant(tenantId).replaceAll("-", "").slice(0, 12);
export const cheminDump = (tenantId: string, date: string) => `clients/${idCourt(tenantId)}/${date}.dump.enc`;

// BullMQ refuse « : » dans un jobId : « dump-<base>-<date> » (même base, même nuit → une seule tâche).
export async function planifierNuit(file: { add: (nom: string, donnees: unknown, opts: { jobId: string }) => Promise<unknown> }, bases: BaseADumper[], date: string): Promise<void> {
  for (const b of bases.filter(aSauvegarder)) await file.add("dump-client", { tenantId: b.tenantId, nomBase: b.nomBase, date }, { jobId: `dump-${b.nomBase}-${date}` });
}

// pg_dump du rôle propriétaire, en connexion DIRECTE à la grappe (pas PgBouncer). Les paramètres de connexion et le mot de passe viennent de l'environnement
// du processus fils seulement ; la sortie d'erreur est vidée sans être gardée ni journalisée. Un code de sortie non nul fait échouer le flux.
export function lancerPgDump(env: Record<string, string>, commande = "pg_dump"): (nomBase: string) => Readable {
  return (nomBase) => {
    const p = spawn(commande, ["--format=custom", "--no-password", `--dbname=${nomBase}`], { env, stdio: ["ignore", "pipe", "pipe"] });
    p.stderr.resume();
    const sortie = new Readable({ read() { p.stdout.resume(); } });
    p.stdout.on("data", (d: Buffer) => { if (!sortie.push(d)) p.stdout.pause(); });
    p.on("error", () => sortie.destroy(new Error("pg_dump_introuvable")));
    p.on("close", (code) => (code === 0 ? sortie.push(null) : sortie.destroy(new Error("pg_dump_a_echoue"))));
    return sortie;
  };
}

async function cleDeDonnees(bao: OptionsBao, tenantId: string): Promise<{ cle: Buffer; cleChiffree: string; versionCle: number }> {
  const r = (await appeler(bao, "POST", `transit/datakey/plaintext/cli-${validerTenant(tenantId)}`, {})) as { data?: { plaintext?: unknown; ciphertext?: unknown } } | undefined;
  const cle = typeof r?.data?.plaintext === "string" ? Buffer.from(r.data.plaintext, "base64") : Buffer.alloc(0);
  const m = typeof r?.data?.ciphertext === "string" ? /^vault:v(\d+):[A-Za-z0-9+/]+={0,2}$/.exec(r.data.ciphertext) : null;
  if (cle.length !== 32 || !m) {
    cle.fill(0);
    throw new ErreurCoffre("coffre_indisponible");
  }
  return { cle, cleChiffree: r!.data!.ciphertext as string, versionCle: Number(m[1]) };
}

export async function dumperClient(deps: DepsDump, base: BaseADumper, date: string): Promise<{ chemin: string; empreinte: string; octets: number }> {
  if (!aSauvegarder(base)) throw new Error("base_non_sauvegardee");
  const chemin = cheminDump(base.tenantId, date);
  const { cle, cleChiffree, versionCle } = await cleDeDonnees(deps.bao, base.tenantId);
  const hash = createHash("sha256");
  let octets = 0;
  try {
    const chiffre = chiffrerFlux(deps.lancerDump(base.nomBase), cle, { versionCle, cleChiffree }, base.tenantId);
    await deps.cible.deposer(chemin, (async function* () { for await (const p of chiffre) { hash.update(p); octets += p.length; yield p; } })());
  } finally {
    cle.fill(0);
    deps.observerCle?.(cle);
  }
  await deps.marquerSauvegarde(base.tenantId, (deps.maintenant ?? (() => new Date()))());
  return { chemin, empreinte: hash.digest("hex"), octets };
}

// Retrait d'anciens dumps d'UN client (30 quotidiennes, 12 mensuelles : retention.ts de T1A-14). Suppression de fichiers sur la cible :
// FERMÉ par défaut (SAUVEGARDES_RETRAIT_ACTIF), et suspendu pour un client en gel pour litige. Ne touche qu'au dossier de ce client.
export async function retirerAnciensDumps(o: { cible: Cible; actif: boolean; gelees: ReadonlySet<string> }, tenantId: string, aujourdhui: string): Promise<{ retires: string[]; raison?: "interrupteur_ferme" | "gel_litige" }> {
  if (!o.actif) return { retires: [], raison: "interrupteur_ferme" };
  if (o.gelees.has(tenantId)) return { retires: [], raison: "gel_litige" };
  const prefixe = `clients/${idCourt(tenantId)}/`;
  const existants = (await o.cible.lister(prefixe)).filter((c) => c.startsWith(prefixe) && /\/\d{4}-\d{2}-\d{2}\.dump\.enc$/.test(c));
  const sauvegardes = existants.map((c) => ({ id: c, date: /(\d{4}-\d{2}-\d{2})\.dump\.enc$/.exec(c)![1]! }));
  const { expirer } = calculerRetention(sauvegardes, aujourdhui);
  for (const s of expirer) await o.cible.retirer(s.id);
  return { retires: expirer.map((s) => s.id) };
}
