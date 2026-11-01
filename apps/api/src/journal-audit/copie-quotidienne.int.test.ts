import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, GetObjectRetentionCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { lireYaml } from "../../../../scripts/garde-compose.js";
import { COMPARTIMENT, copierVeille, creerPortCopieAws, type PortCopie } from "./copie-quotidienne.js";
import { empreinteDe, type LigneJournal } from "./contenu-canonique.js";
import type { LecteurJournal } from "./verifier.js";

// Copie quotidienne contre la VRAIE brique SeaweedFS, lancée avec l'image et la commande du fragment compose du socle (comme stockage.int.test.ts).
// Le compartiment est créé avec le verrouillage d'objets (on ne l'ajoute pas après). Clés d'essai générées au lancement.
const racine = (chemin: string) => fileURLToPath(new URL(`../../../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const compose = lireYaml(readFileSync(racine("ops/socle/compose.stockage.yml"), "utf8")) as unknown as { services: { stockage: { image: string; command: string[]; environment: Record<string, string> } } };
const SERVICE = compose.services.stockage;
const lances: string[] = [];
afterAll(() => { for (const id of lances) try { docker("rm", "-f", id); } catch { /* déjà arrêté */ } });
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const octets = (t: string) => new TextEncoder().encode(t);

let s3: S3Client;
let port: PortCopie;
const JOUR_MS = 86_400_000;
const MAINTENANT = new Date();
const veille = new Date(MAINTENANT.getTime() - JOUR_MS).toISOString().slice(0, 10);

function lecteur(): LecteurJournal {
  const l: LigneJournal = { id: "1", tenant_id: null, acteur: "agent-essai", action: "insertion", entite: "contacts", entite_id: "c1", ancienne: null, nouvelle: '{"v": 1}', ip: null, cree: `${veille}T10:00:00.000000Z`, empreinte_precedente: null, empreinte: "" };
  l.empreinte = empreinteDe(null, l);
  return { async lireLot(apres) { return apres === null ? [l] : []; }, async lireIntervalle(d, f) { return l.cree >= d && l.cree < f ? [l] : []; } };
}
const signataire = { async signer(o: Buffer) { return `vault:v1:${createHash("sha256").update(o).digest("base64")}`; } };
const alertes = { async envoyer() { /* aucune alerte attendue */ } };

beforeAll(async () => {
  const cle = SERVICE.environment.AWS_ACCESS_KEY_ID!;
  const secret = `TEST-NE-PAS-UTILISER-${randomBytes(16).toString("hex")}`;
  const conteneur = docker("run", "-d", "--rm", "-e", `AWS_ACCESS_KEY_ID=${cle}`, "-e", `AWS_SECRET_ACCESS_KEY=${secret}`, SERVICE.image, ...SERVICE.command);
  lances.push(conteneur);
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", conteneur).split(" ")[0] ?? "";
  const endpoint = `http://${ip}:8333`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${endpoint}/healthz`)).status === 200) break; } catch { /* pas encore prêt */ }
    if (i > 60) throw new Error("la brique ne répond pas");
    await pause(1000);
  }
  s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: cle, secretAccessKey: secret } });
  for (let i = 0; ; i++) {
    try { await s3.send(new CreateBucketCommand({ Bucket: COMPARTIMENT, ObjectLockEnabledForBucket: true })); break; } catch (e) { if (i > 30) throw e; await pause(1000); }
  }
  port = creerPortCopieAws({ endpoint, cleAcces: cle, secret });
}, 180_000);

async function deposer(): Promise<string> {
  const r = await copierVeille({ lecteur: lecteur(), port, signataire, alertes, maintenant: () => MAINTENANT });
  expect(r.etat === "deposee" || r.etat === "deja_deposee").toBe(true);
  return `${veille}.jsonl`;
}

// Le rapport JSON de la CI n'est pas publié : le nom du test et la cause sont donc écrits dans le journal.
describe("copie quotidienne du journal, avec la brique de stockage", { timeout: 60_000 }, () => {
  beforeEach((ctx) => { onTestFailed((c) => console.log(`ECHEC ${ctx.task.name} : ${String(c.task.result?.errors?.[0]?.message ?? "").slice(0, 400)}`)); });

  it("[C-029] la copie de la veille est déposée avec ObjectLock COMPLIANCE et une rétention de 5 ans", async () => {
    const cle = await deposer();
    const r = await s3.send(new GetObjectRetentionCommand({ Bucket: COMPARTIMENT, Key: cle }));
    expect(r.Retention?.Mode).toBe("COMPLIANCE");
    const jusqua = r.Retention!.RetainUntilDate!.getTime();
    const cinqAns = new Date(MAINTENANT); cinqAns.setUTCFullYear(cinqAns.getUTCFullYear() + 5);
    expect(Math.abs(jusqua - cinqAns.getTime())).toBeLessThan(2000);
    const corps = await (await s3.send(new GetObjectCommand({ Bucket: COMPARTIMENT, Key: cle }))).Body!.transformToString();
    expect(JSON.parse(corps.trim()).entite_id).toBe("c1");
  });

  it("[C-029] une suppression ou un remplacement de la copie est refusé par le stockage", async () => {
    const cle = await deposer();
    const avant = await s3.send(new GetObjectCommand({ Bucket: COMPARTIMENT, Key: cle }));
    const original = await avant.Body!.transformToString();
    const versions = (await s3.send(new ListObjectVersionsCommand({ Bucket: COMPARTIMENT, Prefix: cle }))).Versions ?? [];
    expect(versions.length).toBeGreaterThan(0);
    // Suppression définitive de la version verrouillée : refusée, même avec la clé administrateur (mode COMPLIANCE).
    await expect(s3.send(new DeleteObjectCommand({ Bucket: COMPARTIMENT, Key: cle, VersionId: versions[0]!.VersionId! }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    // Remplacement conditionnel : refusé (412). La copie reste celle d'origine.
    await expect(s3.send(new PutObjectCommand({ Bucket: COMPARTIMENT, Key: cle, Body: octets("remplacement"), IfNoneMatch: "*" }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    const apres = await (await s3.send(new GetObjectCommand({ Bucket: COMPARTIMENT, Key: cle, VersionId: versions[0]!.VersionId! }))).Body!.transformToString();
    expect(apres).toBe(original);
  });

  it("[C-029] @anti-doublon deux lancements la même nuit ne déposent qu'une copie", async () => {
    const o = { lecteur: lecteur(), port, signataire, alertes, maintenant: () => MAINTENANT };
    // L'unicité de la tâche la même nuit est tenue par le jobId (enfilerCopie) ; ici, le second lancement trouve la clé et ne dépose rien.
    const etats = [(await copierVeille(o)).etat, (await copierVeille(o)).etat];
    expect(etats.filter((e) => e === "deposee").length).toBeLessThanOrEqual(1);
    expect(etats[1]).toBe("deja_deposee");
    const versions = (await s3.send(new ListObjectVersionsCommand({ Bucket: COMPARTIMENT, Prefix: `${veille}.jsonl` }))).Versions ?? [];
    expect(versions).toHaveLength(1);
  });

  it("[C-040] une ligne du journal d'audit de 5 ans moins un jour est encore lisible dans la copie, et la copie refuse sa suppression avant 5 ans", async () => {
    const cle = await deposer();
    // Cinq ans ne s'attendent pas : on lit la date de fin de rétention écrite par la brique. Au dernier jour moins un, elle est encore dans le futur.
    const r = await s3.send(new GetObjectRetentionCommand({ Bucket: COMPARTIMENT, Key: cle }));
    const aLaVeilleDeLaFin = r.Retention!.RetainUntilDate!.getTime() - JOUR_MS;
    expect(aLaVeilleDeLaFin).toBeGreaterThan(Date.now() + 5 * 365 * JOUR_MS - 3 * JOUR_MS);
    const lue = await (await s3.send(new GetObjectCommand({ Bucket: COMPARTIMENT, Key: cle }))).Body!.transformToString();
    expect(JSON.parse(lue.trim())).toMatchObject({ id: "1", acteur: "agent-essai" });
    const versions = (await s3.send(new ListObjectVersionsCommand({ Bucket: COMPARTIMENT, Prefix: cle }))).Versions ?? [];
    await expect(s3.send(new DeleteObjectCommand({ Bucket: COMPARTIMENT, Key: cle, VersionId: versions[0]!.VersionId! }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
  });
});
