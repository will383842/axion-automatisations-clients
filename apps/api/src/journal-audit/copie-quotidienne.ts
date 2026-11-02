import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { FileMinimale } from "../files/files.js";
import { verifierChaine, type LecteurJournal } from "./verifier.js";

// Copie quotidienne du journal d'audit (A-182, C-029, C-040) : les lignes de la veille, en JSON Lines, avec leur empreinte signée par OpenBao,
// déposées dans le compartiment `journal-audit` créé avec le verrouillage d'objets (ADR 0015 : SeaweedFS). Mode COMPLIANCE, 5 ans :
// ni suppression ni remplacement avant l'échéance, même avec la clé administrateur. Rien n'est déposé si la chaîne est rompue.
export const COMPARTIMENT = "journal-audit";
export const RETENTION_ANNEES = 5;
const JOUR_MS = 86_400_000;

// `deposer` écrit seulement si la clé n'existe pas (condition vérifiée par la brique) et dit s'il a écrit : c'est l'anti-doublon.
export interface DepotVerrouille {
  compartiment: string;
  cle: string;
  octets: Uint8Array;
  modeRetention: "COMPLIANCE";
  retenirJusquA: Date;
}
export interface PortCopie {
  deposer(depot: DepotVerrouille): Promise<boolean>;
}
// signature.ts de T1A-07 : la clé de signature ne sort jamais d'OpenBao.
export interface Signataire {
  signer(octets: Buffer): Promise<string>;
}
// Port des alertes (alertes/port.ts) : son type d'alerte est fermé sur un autre cas ; `journal_rompu` y sera ajouté par la fiche qui en est propriétaire.
export interface AlerteJournalRompu {
  type: "journal_rompu";
  identifiantRupture: string;
}
export interface AlertesJournal {
  envoyer(alerte: AlerteJournalRompu): Promise<void>;
}
export type ResultatCopie = { etat: "deposee" | "deja_deposee"; cle: string; lignes: number } | { etat: "bloquee" };

const jourDe = (d: Date) => d.toISOString().slice(0, 10);
const minuit = (jour: string) => `${jour}T00:00:00.000000Z`;

export async function copierVeille(o: { lecteur: LecteurJournal; port: PortCopie; signataire: Signataire; alertes: AlertesJournal; maintenant?: () => Date }): Promise<ResultatCopie> {
  const maintenant = (o.maintenant ?? (() => new Date()))();
  const verification = await verifierChaine(o.lecteur);
  if (!verification.intacte) {
    await o.alertes.envoyer({ type: "journal_rompu", identifiantRupture: verification.rupture.id });
    return { etat: "bloquee" };
  }
  const veille = jourDe(new Date(maintenant.getTime() - JOUR_MS));
  const lignes = await o.lecteur.lireIntervalle(minuit(veille), minuit(jourDe(maintenant)));
  const donnees = new TextEncoder().encode(lignes.map((l) => `${JSON.stringify(l)}\n`).join(""));
  const sha256 = createHash("sha256").update(donnees).digest("hex");
  const signature = await o.signataire.signer(Buffer.from(sha256, "utf8"));
  const retenirJusquA = new Date(maintenant);
  retenirJusquA.setUTCFullYear(retenirJusquA.getUTCFullYear() + RETENTION_ANNEES);
  const depot = { compartiment: COMPARTIMENT, modeRetention: "COMPLIANCE" as const, retenirJusquA };
  const cle = `${veille}.jsonl`;
  const ecrit = await o.port.deposer({ ...depot, cle, octets: donnees });
  // La signature est tentée même si la copie existait déjà : une relance après une coupure entre les deux dépôts la complète.
  await o.port.deposer({ ...depot, cle: `${veille}.signature.json`, octets: new TextEncoder().encode(`${JSON.stringify({ jour: veille, sha256, signature })}\n`) });
  return { etat: ecrit ? "deposee" : "deja_deposee", cle, lignes: lignes.length };
}

// Une tâche par nuit : même jour → même jobId → BullMQ n'en garde qu'une. Le déclenchement nocturne (planificateur) est branché à la mise en service.
export async function enfilerCopie(file: FileMinimale, maintenant: Date): Promise<void> {
  await file.add("copie-journal", {}, { jobId: `copie-journal-${jourDe(maintenant)}` });
}

const statutDe = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
// Adaptateur S3 (SeaweedFS). Seul un code sort : ni message ni pile de la bibliothèque. Une clé déjà présente (412) n'est pas une erreur.
export function creerPortCopieAws(o: { endpoint: string; cleAcces: string; secret: string; region?: string }): PortCopie {
  return {
    async deposer(d) {
      const s3 = new S3Client({ endpoint: o.endpoint, region: o.region ?? "us-east-1", forcePathStyle: true, credentials: { accessKeyId: o.cleAcces, secretAccessKey: o.secret } });
      try {
        // Anti-doublon : écriture conditionnelle seule (If-None-Match, appliquée par SeaweedFS 4.51 sur ce compartiment : essai d'intégration). Aucune lecture, pour qu'une clé en écriture seule suffise.
        await s3.send(new PutObjectCommand({ Bucket: d.compartiment, Key: d.cle, Body: d.octets, IfNoneMatch: "*", ObjectLockMode: d.modeRetention, ObjectLockRetainUntilDate: d.retenirJusquA }));
        return true;
      } catch (e) {
        const statut = statutDe(e);
        if (statut === 412) return false;
        throw new Error(statut === 403 ? "acces_refuse" : "brique_indisponible");
      } finally {
        s3.destroy();
      }
    },
  };
}
