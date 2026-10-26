// Stockage d'objets (A-061, C-522) : un compartiment cli-<tenantId> par client, avec des identifiants limités à ce compartiment
// et rangés dans le coffre, lus par référence (T1A-06). Le code ne parle que le port S3 (ADR 0015) ; l'adaptateur de la brique
// retenue, SeaweedFS, est creerPortS3Aws (ADR 0022). Un message d'erreur est le code seul : aucun identifiant ni secret n'y entre.
import { CreateAccessKeyCommand, CreateUserCommand, DeleteAccessKeyCommand, DeleteUserCommand, DeleteUserPolicyCommand, IAMClient, ListAccessKeysCommand, PutUserPolicyCommand } from "@aws-sdk/client-iam";
import { CreateBucketCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Coffre } from "../coffre/coffre.js";

export interface IdentifiantsS3 {
  cleAcces: string;
  secret: string;
  compartiment: string;
}

// identifiants absents = accès anonyme : la brique doit le refuser (ErreurStockage « acces_refuse »).
// creerUtilisateur est atomique côté brique : un second appel pour le même compartiment est refusé (« deja_cree »).
// deposerSiAbsent écrit seulement si la clé n'existe pas (condition vérifiée par la brique) et dit s'il a écrit.
export interface PortS3 {
  creerCompartiment(nom: string): Promise<void>;
  creerUtilisateur(compartiment: string): Promise<IdentifiantsS3>;
  supprimerUtilisateur(compartiment: string): Promise<void>;
  deposer(id: IdentifiantsS3 | undefined, compartiment: string, cle: string, octets: Uint8Array): Promise<void>;
  deposerSiAbsent(id: IdentifiantsS3 | undefined, compartiment: string, cle: string, octets: Uint8Array): Promise<boolean>;
  lire(id: IdentifiantsS3 | undefined, compartiment: string, cle: string): Promise<Uint8Array | undefined>;
  signer(id: IdentifiantsS3 | undefined, compartiment: string, cle: string, secondes: number): Promise<string>;
}

export interface CoffreIdentifiants {
  ranger(tenantId: string, id: IdentifiantsS3): Promise<void>;
  lire(tenantId: string): Promise<IdentifiantsS3 | undefined>;
}

// Correspondance client → référence du coffre : la référence n'est pas un secret, la valeur reste dans le coffre.
export interface RegistreReferences {
  lire(tenantId: string): Promise<string | undefined>;
  poser(tenantId: string, reference: string): Promise<void>;
}

export type CodeStockage =
  | "tenant_invalide"
  | "cle_invalide"
  | "duree_invalide"
  | "deja_cree"
  | "compartiment_absent"
  | "identifiants_etrangers"
  | "identifiants_illisibles"
  | "acces_refuse"
  | "brique_indisponible";

export class ErreurStockage extends Error {
  constructor(readonly code: CodeStockage) {
    super(code);
    this.name = "ErreurStockage";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Segments simples commençant par un caractère alphanumérique : ni « .. », ni « . », ni barre double, ni « % », ni espace.
const CLE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const CLE_MAX = 512;
export const DUREE_LIEN_MAX = 900;

export const validerCle = (cle: string): string => {
  if (typeof cle !== "string" || cle.length > CLE_MAX || !CLE.test(cle)) throw new ErreurStockage("cle_invalide");
  return cle;
};

export const compartimentDe = (tenantId: string): string => {
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) throw new ErreurStockage("tenant_invalide");
  return `cli-${tenantId}`;
};

export function creerStockage(o: { s3: PortS3; coffre: CoffreIdentifiants }) {
  // Les identifiants DU client, et d'aucun autre : un jeu rangé pour un autre compartiment est refusé avant tout appel.
  const identifiants = async (tenantId: string) => {
    const compartiment = compartimentDe(tenantId);
    const id = await o.coffre.lire(tenantId);
    if (!id) throw new ErreurStockage("compartiment_absent");
    if (id.compartiment !== compartiment) throw new ErreurStockage("identifiants_etrangers");
    return { id, compartiment };
  };
  return {
    // Atomique : seule la brique tranche (un utilisateur par compartiment). Si le coffre échoue, l'utilisateur est supprimé :
    // aucun jeu de clés ne reste actif sans être rangé, et la création peut être refaite.
    async creerCompartimentClient(tenantId: string): Promise<void> {
      const compartiment = compartimentDe(tenantId);
      await o.s3.creerCompartiment(compartiment);
      const id = await o.s3.creerUtilisateur(compartiment);
      try {
        await o.coffre.ranger(tenantId, id);
      } catch (e) {
        await o.s3.supprimerUtilisateur(compartiment).catch(() => undefined);
        throw e;
      }
    },
    async deposer(tenantId: string, cle: string, octets: Uint8Array): Promise<void> {
      validerCle(cle);
      const { id, compartiment } = await identifiants(tenantId);
      await o.s3.deposer(id, compartiment, cle, octets);
    },
    async lire(tenantId: string, cle: string): Promise<Uint8Array | undefined> {
      validerCle(cle);
      const { id, compartiment } = await identifiants(tenantId);
      return o.s3.lire(id, compartiment, cle);
    },
    async lienSigne(tenantId: string, cle: string, dureeSecondes: number): Promise<string> {
      validerCle(cle);
      if (!Number.isInteger(dureeSecondes) || dureeSecondes < 1 || dureeSecondes > DUREE_LIEN_MAX) throw new ErreurStockage("duree_invalide");
      const { id, compartiment } = await identifiants(tenantId);
      return o.s3.signer(id, compartiment, cle, dureeSecondes);
    },
  };
}

// Les identifiants du client sont dans le coffre (T1A-06) : le registre ne garde que la référence bao:clients/<client>/<uuid>,
// et le coffre refuse la référence d'un autre client. Une valeur illisible est refusée sans être recopiée dans l'erreur.
export function creerCoffreIdentifiants(o: { coffre: Pick<Coffre, "rangerIdentifiant" | "lireValeur">; registre: RegistreReferences }): CoffreIdentifiants {
  return {
    async ranger(tenantId, id) {
      const reference = await o.coffre.rangerIdentifiant(tenantId, "stockage-s3", JSON.stringify({ cleAcces: id.cleAcces, secret: id.secret, compartiment: id.compartiment }));
      await o.registre.poser(tenantId, reference);
    },
    async lire(tenantId) {
      const reference = await o.registre.lire(tenantId);
      if (!reference) return undefined;
      let v: Partial<IdentifiantsS3> | null = null;
      try {
        v = JSON.parse(await o.coffre.lireValeur(tenantId, reference)) as Partial<IdentifiantsS3> | null;
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
      if (!v || typeof v.cleAcces !== "string" || typeof v.secret !== "string" || typeof v.compartiment !== "string" || !v.cleAcces || !v.secret || !v.compartiment) {
        throw new ErreurStockage("identifiants_illisibles");
      }
      return { cleAcces: v.cleAcces, secret: v.secret, compartiment: v.compartiment };
    },
  };
}

// Adaptateur SeaweedFS (API S3 et API IAM embarquée, ADR 0022). Style d'adresse « path-style » exigé hors AWS.
// Le jeu administrateur ne sert qu'à créer les compartiments et les utilisateurs ; il n'est jamais rendu à un client.
export function creerPortS3Aws(o: { endpoint: string; admin: { cleAcces: string; secret: string }; region?: string }): PortS3 {
  const region = o.region ?? "us-east-1";
  const connexion = (c: { cleAcces: string; secret: string }) => ({ endpoint: o.endpoint, region, credentials: { accessKeyId: c.cleAcces, secretAccessKey: c.secret } });
  const s3De = (c: { cleAcces: string; secret: string }) => new S3Client({ ...connexion(c), forcePathStyle: true });
  const iam = () => new IAMClient(connexion(o.admin));
  const statut = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const nom = (e: unknown) => (e as { name?: string }).name;
  // Seul le code sort : le message et la pile du client de la brique ne sont jamais relayés.
  const traduire = (e: unknown): never => {
    if (e instanceof ErreurStockage) throw e;
    throw new ErreurStockage(statut(e) === 403 ? "acces_refuse" : "brique_indisponible");
  };
  const avec = async <T>(c: { cleAcces: string; secret: string }, f: (s3: S3Client) => Promise<T>): Promise<T> => {
    const s3 = s3De(c);
    try {
      return await f(s3);
    } catch (e) {
      return traduire(e);
    } finally {
      s3.destroy();
    }
  };
  // Requête sans signature : la brique doit répondre 401 ou 403. Une réponse ouverte est rendue telle quelle pour que les tests la voient.
  const anonyme = async (methode: "GET" | "PUT", compartiment: string, cle: string, corps?: Uint8Array): Promise<Response> => {
    const adresse = `${o.endpoint}/${compartiment}/${cle.split("/").map(encodeURIComponent).join("/")}`;
    const r = await fetch(adresse, corps ? { method: methode, body: corps } : { method: methode }).catch(() => traduire(undefined));
    if (r.status === 401 || r.status === 403) throw new ErreurStockage("acces_refuse");
    return r;
  };
  const supprimerUtilisateur = async (utilisateur: string): Promise<void> => {
    const client = iam();
    const absent = (e: unknown) => nom(e) === "NoSuchEntityException" || statut(e) === 404;
    try {
      const cles = await client.send(new ListAccessKeysCommand({ UserName: utilisateur })).catch((e: unknown) => (absent(e) ? { AccessKeyMetadata: [] } : Promise.reject(e)));
      for (const k of cles.AccessKeyMetadata ?? []) await client.send(new DeleteAccessKeyCommand({ UserName: utilisateur, AccessKeyId: k.AccessKeyId }));
      await client.send(new DeleteUserPolicyCommand({ UserName: utilisateur, PolicyName: "compartiment" })).catch((e: unknown) => (absent(e) ? undefined : Promise.reject(e)));
      await client.send(new DeleteUserCommand({ UserName: utilisateur })).catch((e: unknown) => (absent(e) ? undefined : Promise.reject(e)));
    } catch (e) {
      traduire(e);
    } finally {
      client.destroy();
    }
  };
  return {
    async creerCompartiment(compartiment) {
      const s3 = s3De(o.admin);
      try {
        await s3.send(new CreateBucketCommand({ Bucket: compartiment }));
      } catch (e) {
        // Déjà à nous : la création est idempotente.
        if (nom(e) !== "BucketAlreadyOwnedByYou") traduire(e);
      } finally {
        s3.destroy();
      }
    },
    async creerUtilisateur(compartiment) {
      const client = iam();
      try {
        try {
          await client.send(new CreateUserCommand({ UserName: compartiment }));
        } catch (e) {
          throw nom(e) === "EntityAlreadyExistsException" ? new ErreurStockage("deja_cree") : e;
        }
        try {
          const politique = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"], Resource: [`arn:aws:s3:::${compartiment}`, `arn:aws:s3:::${compartiment}/*`] }] };
          await client.send(new PutUserPolicyCommand({ UserName: compartiment, PolicyName: "compartiment", PolicyDocument: JSON.stringify(politique) }));
          const k = (await client.send(new CreateAccessKeyCommand({ UserName: compartiment }))).AccessKey;
          if (!k?.AccessKeyId || !k.SecretAccessKey) throw new ErreurStockage("brique_indisponible");
          return { cleAcces: k.AccessKeyId, secret: k.SecretAccessKey, compartiment };
        } catch (e) {
          await supprimerUtilisateur(compartiment).catch(() => undefined);
          throw e;
        }
      } catch (e) {
        return traduire(e);
      } finally {
        client.destroy();
      }
    },
    supprimerUtilisateur,
    async deposer(id, compartiment, cle, octets) {
      if (!id) {
        if (!(await anonyme("PUT", compartiment, cle, octets)).ok) throw new ErreurStockage("brique_indisponible");
        return;
      }
      await avec(id, (s3) => s3.send(new PutObjectCommand({ Bucket: compartiment, Key: cle, Body: octets })));
    },
    async deposerSiAbsent(id, compartiment, cle, octets) {
      if (!id) throw new ErreurStockage("acces_refuse");
      return avec(id, async (s3) => {
        try {
          await s3.send(new PutObjectCommand({ Bucket: compartiment, Key: cle, Body: octets, IfNoneMatch: "*" }));
          return true;
        } catch (e) {
          if (statut(e) === 412) return false;
          throw e;
        }
      });
    },
    async lire(id, compartiment, cle) {
      if (!id) {
        const r = await anonyme("GET", compartiment, cle);
        if (r.status === 404) return undefined;
        if (!r.ok) throw new ErreurStockage("brique_indisponible");
        return new Uint8Array(await r.arrayBuffer());
      }
      return avec(id, async (s3) => {
        try {
          const r = await s3.send(new GetObjectCommand({ Bucket: compartiment, Key: cle }));
          return await r.Body!.transformToByteArray();
        } catch (e) {
          if (nom(e) === "NoSuchKey") return undefined;
          throw e;
        }
      });
    },
    async signer(id, compartiment, cle, secondes) {
      if (!id) throw new ErreurStockage("acces_refuse");
      return avec(id, (s3) => getSignedUrl(s3, new GetObjectCommand({ Bucket: compartiment, Key: cle }), { expiresIn: secondes }));
    },
  };
}
