// Stockage d'objets (A-061, C-522) : un compartiment cli-<tenantId> par client, avec des identifiants limités à ce compartiment
// et rangés dans le coffre. Le code ne parle que le port S3 (ADR 0008) ; l'adaptateur de la brique retenue vient à l'étape 2.
// Un message d'erreur est le code seul : aucun identifiant ni secret n'y entre.

export interface IdentifiantsS3 {
  cleAcces: string;
  secret: string;
  compartiment: string;
}

// identifiants absents = accès anonyme : la brique doit le refuser.
export interface PortS3 {
  creerCompartiment(nom: string): Promise<void>;
  creerUtilisateur(compartiment: string): Promise<IdentifiantsS3>;
  deposer(id: IdentifiantsS3 | undefined, compartiment: string, cle: string, octets: Uint8Array): Promise<void>;
  lire(id: IdentifiantsS3 | undefined, compartiment: string, cle: string): Promise<Uint8Array | undefined>;
  signer(id: IdentifiantsS3 | undefined, compartiment: string, cle: string, secondes: number): Promise<string>;
}

export interface CoffreIdentifiants {
  ranger(tenantId: string, id: IdentifiantsS3): Promise<void>;
  lire(tenantId: string): Promise<IdentifiantsS3 | undefined>;
}

export type CodeStockage = "tenant_invalide" | "cle_invalide" | "duree_invalide" | "deja_cree" | "compartiment_absent" | "identifiants_etrangers";

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
    async creerCompartimentClient(tenantId: string): Promise<void> {
      const compartiment = compartimentDe(tenantId);
      if (await o.coffre.lire(tenantId)) throw new ErreurStockage("deja_cree");
      await o.s3.creerCompartiment(compartiment);
      await o.coffre.ranger(tenantId, await o.s3.creerUtilisateur(compartiment));
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
