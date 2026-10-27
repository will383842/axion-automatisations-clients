import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { lireYaml } from "../../scripts/garde-compose.ts";
import type { Coffre } from "../../apps/api/src/coffre/coffre.ts";
import { creerCoffreIdentifiants, creerPortS3Aws, creerStockage, type IdentifiantsS3, type PortS3, type RegistreReferences } from "../../apps/api/src/stockage/stockage.ts";

// Porte du lot 1-A (T1A-19, partie A) : stockage d'objets en boîte noire. VRAIE brique SeaweedFS, même image et même commande que le
// fragment compose du socle, lancée par l'essai (comme apps/api/src/stockage/stockage.int.test.ts). Les identifiants du client A essaient
// d'atteindre le compartiment de B par les chemins que l'adaptateur n'utilise pas : copie côté serveur, téléversement en parties,
// liste des compartiments, en-têtes, suppression, API IAM, lien signé retouché. Clés d'essai générées au lancement.
// Les clients S3 et IAM sont ceux du paquet de l'API (chargés depuis apps/api : le dossier tests/ n'a pas de dépendances à lui).
const charger = createRequire(fileURLToPath(new URL("../../apps/api/package.json", import.meta.url)));
const S3 = charger("@aws-sdk/client-s3") as typeof import("@aws-sdk/client-s3");
const IAM = charger("@aws-sdk/client-iam") as typeof import("@aws-sdk/client-iam");

const racine = (chemin: string) => fileURLToPath(new URL(`../../${chemin}`, import.meta.url));
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const SERVICE = (lireYaml(readFileSync(racine("ops/socle/compose.stockage.yml"), "utf8")) as unknown as { services: { stockage: { image: string; command: string[]; environment: Record<string, string> } } }).services.stockage;
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const octets = (t: string) => new TextEncoder().encode(t);
const A = randomUUID();
const B = randomUUID();
const CONTENU_B = `CONTENU-DE-B-${randomBytes(8).toString("hex")}`;

afterEach((ctx) => {
  if (ctx.task.result?.state === "fail") writeSync(2, `ECHEC ${ctx.task.name}\n${(ctx.task.result.errors ?? []).map((e) => e.message).join("\n")}\n`);
});

const lances: string[] = [];
afterAll(() => {
  for (const id of lances) try { docker("rm", "-f", id); } catch { /* déjà arrêté */ }
});

let endpoint = "";
let admin: PortS3;
const valeurs = new Map<string, string>();
const refs = new Map<string, string>();
const coffre: Pick<Coffre, "rangerIdentifiant" | "lireValeur"> = {
  async rangerIdentifiant(tenantId, _nom, valeur) {
    const reference = `bao:clients/${tenantId}/${randomUUID()}`;
    valeurs.set(reference, valeur);
    return reference;
  },
  async lireValeur(tenantId, reference) {
    if (!reference.startsWith(`bao:clients/${tenantId}/`)) throw new Error("reference_etrangere");
    return valeurs.get(reference) ?? "";
  },
};
const registre: RegistreReferences = {
  async lire(t) { return refs.get(t); },
  async poser(t, r) { refs.set(t, r); },
};
const stockage = () => creerStockage({ s3: admin, coffre: creerCoffreIdentifiants({ coffre, registre }) });
const identifiantsDe = (t: string) => JSON.parse(valeurs.get(refs.get(t) ?? "") ?? "{}") as IdentifiantsS3;
const s3De = (id: { cleAcces: string; secret: string }) => new S3.S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: id.cleAcces, secretAccessKey: id.secret } });
const iamDe = (id: { cleAcces: string; secret: string }) => new IAM.IAMClient({ endpoint, region: "us-east-1", credentials: { accessKeyId: id.cleAcces, secretAccessKey: id.secret } });
// Résultat d'un appel : « ok » ou le statut HTTP de l'erreur (jamais le message, qui pourrait porter un identifiant).
const issue = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => String((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? (e as { name?: string }).name ?? "erreur"));

let idA: IdentifiantsS3;
let idB: IdentifiantsS3;
beforeAll(async () => {
  const cleAdmin = SERVICE.environment.AWS_ACCESS_KEY_ID ?? "";
  const secretAdmin = `TEST-NE-PAS-UTILISER-${randomBytes(16).toString("hex")}`;
  const id = docker("run", "-d", "--rm", "-e", `AWS_ACCESS_KEY_ID=${cleAdmin}`, "-e", `AWS_SECRET_ACCESS_KEY=${secretAdmin}`, SERVICE.image, ...SERVICE.command);
  lances.push(id);
  const ip = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id).split(" ")[0] ?? "";
  endpoint = `http://${ip}:8333`;
  admin = creerPortS3Aws({ endpoint, admin: { cleAcces: cleAdmin, secret: secretAdmin } });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${endpoint}/healthz`)).status === 200) {
        await admin.creerCompartiment("sonde");
        break;
      }
    } catch { /* démarrage */ }
    if (i > 90) throw new Error("SeaweedFS d'essai non démarré");
    await pause(1000);
  }
  execFileSync("bash", [racine("ops/socle/stockage/initialiser.sh"), id], { encoding: "utf8" });
  const s = stockage();
  await s.creerCompartimentClient(A);
  await s.creerCompartimentClient(B);
  await pause(1500);
  await s.deposer(B, "secret.txt", octets(CONTENU_B));
  await s.deposer(A, "mien.txt", octets("à A"));
  idA = identifiantsDe(A);
  idB = identifiantsDe(B);
}, 240_000);

describe("audit 1-A · stockage d'objets", () => {
  it("[A-061] @isolation A ne recopie pas un objet de B dans son propre compartiment (copie côté serveur)", async () => {
    const s3 = s3De(idA);
    try {
      const r = await issue(s3.send(new S3.CopyObjectCommand({ Bucket: `cli-${A}`, Key: "vol.txt", CopySource: `cli-${B}/secret.txt` })));
      const relu = await stockage().lire(A, "vol.txt");
      expect(relu === undefined ? "" : new TextDecoder().decode(relu), "contenu de B recopié chez A").not.toContain(CONTENU_B);
      expect(r).not.toBe("ok");
    } finally {
      s3.destroy();
    }
  }, 60_000);

  it("[A-061] @isolation A ne recopie pas un objet de B par un téléversement en parties (UploadPartCopy)", async () => {
    const s3 = s3De(idA);
    try {
      const depart = await s3.send(new S3.CreateMultipartUploadCommand({ Bucket: `cli-${A}`, Key: "vol-parties.txt" }));
      const partie = await issue(s3.send(new S3.UploadPartCopyCommand({ Bucket: `cli-${A}`, Key: "vol-parties.txt", UploadId: depart.UploadId, PartNumber: 1, CopySource: `cli-${B}/secret.txt` })));
      if (partie === "ok") {
        const parties = await s3.send(new S3.ListPartsCommand({ Bucket: `cli-${A}`, Key: "vol-parties.txt", UploadId: depart.UploadId }));
        await issue(s3.send(new S3.CompleteMultipartUploadCommand({ Bucket: `cli-${A}`, Key: "vol-parties.txt", UploadId: depart.UploadId, MultipartUpload: { Parts: (parties.Parts ?? []).map((p) => ({ ETag: p.ETag, PartNumber: p.PartNumber })) } })));
      } else {
        await issue(s3.send(new S3.AbortMultipartUploadCommand({ Bucket: `cli-${A}`, Key: "vol-parties.txt", UploadId: depart.UploadId })));
      }
      const relu = await stockage().lire(A, "vol-parties.txt");
      expect(relu === undefined ? "" : new TextDecoder().decode(relu), "contenu de B recopié chez A").not.toContain(CONTENU_B);
      expect(partie).not.toBe("ok");
    } finally {
      s3.destroy();
    }
  }, 60_000);

  it("[A-061] @isolation la liste des compartiments n'est pas ouverte aux identifiants de A, ou ne cite pas B", async () => {
    const s3 = s3De(idA);
    try {
      const liste = await s3.send(new S3.ListBucketsCommand({})).then((r) => (r.Buckets ?? []).map((b) => b.Name ?? ""), () => [] as string[]);
      expect(liste.filter((n) => n !== `cli-${A}`)).toEqual([]);
    } finally {
      s3.destroy();
    }
  }, 60_000);

  it("[A-061] @isolation A ne liste, ne supprime, ni n'interroge un objet de B ; un objet présent ou absent chez B répond pareil", async () => {
    const s3 = s3De(idA);
    try {
      expect(await issue(s3.send(new S3.ListObjectsV2Command({ Bucket: `cli-${B}` })))).toBe("403");
      expect(await issue(s3.send(new S3.DeleteObjectCommand({ Bucket: `cli-${B}`, Key: "secret.txt" })))).not.toBe("ok");
      expect(await issue(s3.send(new S3.DeleteObjectsCommand({ Bucket: `cli-${B}`, Delete: { Objects: [{ Key: "secret.txt" }] } })))).not.toBe("ok");
      const present = await issue(s3.send(new S3.HeadObjectCommand({ Bucket: `cli-${B}`, Key: "secret.txt" })));
      const absent = await issue(s3.send(new S3.HeadObjectCommand({ Bucket: `cli-${B}`, Key: "absent.txt" })));
      expect(present).toBe("403");
      expect(absent).toBe(present);
      const lirePresent = await issue(s3.send(new S3.GetObjectCommand({ Bucket: `cli-${B}`, Key: "secret.txt" })));
      const lireAbsent = await issue(s3.send(new S3.GetObjectCommand({ Bucket: `cli-${B}`, Key: "absent.txt" })));
      expect(lirePresent).toBe("403");
      expect(lireAbsent).toBe(lirePresent);
      expect(await issue(s3.send(new S3.PutObjectAclCommand({ Bucket: `cli-${B}`, Key: "secret.txt", ACL: "public-read" })))).not.toBe("ok");
      expect(await issue(s3.send(new S3.PutBucketPolicyCommand({ Bucket: `cli-${B}`, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::cli-${B}/*` }] }) })))).not.toBe("ok");
      expect(await issue(s3.send(new S3.PutBucketPolicyCommand({ Bucket: `cli-${A}`, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::cli-${A}/*` }] }) })))).not.toBe("ok");
      // Toujours là, toujours privé.
      expect(new TextDecoder().decode(await stockage().lire(B, "secret.txt"))).toBe(CONTENU_B);
      expect([401, 403]).toContain((await fetch(`${endpoint}/cli-${B}/secret.txt`)).status);
      expect([401, 403]).toContain((await fetch(`${endpoint}/cli-${A}/mien.txt`)).status);
    } finally {
      s3.destroy();
    }
  }, 60_000);

  it("[A-061] @isolation les identifiants de A n'ouvrent pas l'API IAM : ni liste, ni clé pour B, ni droit élargi, ni suppression de B", async () => {
    const iam = iamDe(idA);
    try {
      const essais: [string, Promise<unknown>][] = [
        ["lister les utilisateurs", iam.send(new IAM.ListUsersCommand({}))],
        ["créer une clé pour B", iam.send(new IAM.CreateAccessKeyCommand({ UserName: `cli-${B}` }))],
        ["lister les clés de B", iam.send(new IAM.ListAccessKeysCommand({ UserName: `cli-${B}` }))],
        ["élargir sa politique", iam.send(new IAM.PutUserPolicyCommand({ UserName: `cli-${A}`, PolicyName: "compartiment", PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:*"], Resource: ["arn:aws:s3:::*"] }] }) }))],
        ["lire la politique de B", iam.send(new IAM.GetUserPolicyCommand({ UserName: `cli-${B}`, PolicyName: "compartiment" }))],
        ["créer un utilisateur", iam.send(new IAM.CreateUserCommand({ UserName: `cli-${randomUUID()}` }))],
        ["supprimer B", iam.send(new IAM.DeleteUserCommand({ UserName: `cli-${B}` }))],
      ];
      const acceptes: string[] = [];
      for (const [quoi, p] of essais) if ((await issue(p)) === "ok") acceptes.push(quoi);
      expect(acceptes).toEqual([]);
      await pause(1500);
      // Les droits de A n'ont pas grandi, et B garde les siens.
      const s3 = s3De(idA);
      try {
        expect(await issue(s3.send(new S3.GetObjectCommand({ Bucket: `cli-${B}`, Key: "secret.txt" })))).toBe("403");
      } finally {
        s3.destroy();
      }
      expect(new TextDecoder().decode(await admin.lire(idB, `cli-${B}`, "secret.txt"))).toBe(CONTENU_B);
    } finally {
      iam.destroy();
    }
  }, 60_000);

  it("[A-061] @isolation un lien signé de A retouché pour viser B (compartiment, clé ou durée) est refusé", async () => {
    const lien = await stockage().lienSigne(A, "mien.txt", 60);
    expect((await fetch(lien)).status).toBe(200);
    const vers = (u: string) => fetch(u).then((r) => r.status);
    const u = new URL(lien);
    const retouches = [
      lien.replace(`/cli-${A}/mien.txt`, `/cli-${B}/secret.txt`),
      lien.replace(`/cli-${A}/`, `/cli-${B}/`),
      lien.replace("/mien.txt", "/secret.txt"),
      (() => { const x = new URL(u); x.searchParams.set("X-Amz-Expires", "604800"); return x.toString(); })(),
      (() => { const x = new URL(u); x.pathname = `/cli-${B}/secret.txt`; x.searchParams.delete("X-Amz-Signature"); return x.toString(); })(),
    ];
    for (const r of retouches) expect([401, 403], "lien retouché").toContain(await vers(r));
  }, 60_000);
});
