import { createHash, createPublicKey, verify } from "node:crypto";
import { appeler, ErreurCoffre, type OptionsBao } from "../coffre/coffre.js";

// Manifeste de l'export (B-374) : pour chaque fichier, taille, empreinte SHA-256 et date ; signé par la clé « exports-signature » d'AXION.
// La signature ne se fait que dans OpenBao (transit, Ed25519, non exportable) : on envoie les octets, on reçoit la signature. Aucun appel d'export de clé ici.
// La vérification se fait HORS ligne, avec la clé publique donnée à part (verifier.txt, documentation) : jamais avec une clé trouvée dans le ZIP.
const CLE = "exports-signature";
const FORME_SIGNATURE = /^vault:v\d+:[A-Za-z0-9+/]+={0,2}$/;
const ENTETE_SPKI = Buffer.from("302a300506032b6570032100", "hex");
export const FICHIERS_DE_PREUVE = ["manifeste.json", "manifeste.sig", "verifier.txt"] as const;
const indisponible = () => new ErreurCoffre("coffre_indisponible");

export const empreinteSha256 = (octets: Uint8Array): string => createHash("sha256").update(octets).digest("hex");

export interface FichierManifeste { fichier: string; taille: number; sha256: string; date: string }
export function construireManifeste(o: { clientId: string; demande: string; versionStructure: number; genereLe: Date; fichiers: FichierManifeste[] }): Buffer {
  const contenu = { version: 1, client: o.clientId, demande: o.demande, versionStructure: o.versionStructure, genereLe: o.genereLe.toISOString(), algorithme: "SHA-256", signature: "Ed25519", fichiers: o.fichiers };
  return Buffer.from(`${JSON.stringify(contenu, null, 2)}\n`, "utf8");
}

export function creerSignatureExports(o: OptionsBao) {
  const data = (r: unknown): Record<string, unknown> => ((r as { data?: Record<string, unknown> } | undefined)?.data) ?? {};
  return {
    async signer(octets: Buffer): Promise<string> {
      const s = data(await appeler(o, "POST", `transit/sign/${CLE}`, { input: octets.toString("base64") })).signature;
      if (typeof s !== "string" || !FORME_SIGNATURE.test(s)) throw indisponible();
      return s;
    },
    // Clé publique brute (32 octets en base64), à publier avec le mode d'emploi.
    async clePublique(): Promise<string> {
      const d = data(await appeler(o, "GET", `transit/keys/${CLE}`));
      const cles = d["keys"] as Record<string, { public_key?: unknown }> | undefined;
      const cle = cles?.["1"]?.public_key;
      if (d["type"] !== "ed25519" || d["exportable"] !== false || typeof cle !== "string" || Buffer.from(cle, "base64").length !== 32) throw indisponible();
      return cle;
    },
  };
}

export type ResultatVerification = { ok: true } | { ok: false; raison: "cle_invalide" | "manifeste_absent" | "signature_invalide" | "manifeste_illisible" | "fichier_absent" | "fichier_non_liste" | "empreinte_differente" };
const ko = (raison: Extract<ResultatVerification, { ok: false }>["raison"]): ResultatVerification => ({ ok: false, raison });

export function verifierExport(fichiers: ReadonlyMap<string, Uint8Array>, clePubliqueBase64: string): ResultatVerification {
  const brute = Buffer.from(String(clePubliqueBase64), "base64");
  if (brute.length !== 32) return ko("cle_invalide");
  const manifeste = fichiers.get("manifeste.json");
  const signature = fichiers.get("manifeste.sig");
  if (!manifeste || !signature) return ko("manifeste_absent");
  const texte = Buffer.from(signature).toString("utf8").trim();
  const m = /^vault:v\d+:([A-Za-z0-9+/]+={0,2})$/.exec(texte);
  let valide = false;
  try {
    valide = !!m && verify(null, manifeste, createPublicKey({ key: Buffer.concat([ENTETE_SPKI, brute]), format: "der", type: "spki" }), Buffer.from(m[1]!, "base64"));
  } catch { valide = false; }
  if (!valide) return ko("signature_invalide");
  let liste: FichierManifeste[];
  try {
    const lu = JSON.parse(Buffer.from(manifeste).toString("utf8")) as { fichiers?: FichierManifeste[] };
    if (!Array.isArray(lu.fichiers)) return ko("manifeste_illisible");
    liste = lu.fichiers;
  } catch { return ko("manifeste_illisible"); }
  const listes = new Set(liste.map((f) => f.fichier));
  for (const nom of fichiers.keys()) if (!listes.has(nom) && !(FICHIERS_DE_PREUVE as readonly string[]).includes(nom)) return ko("fichier_non_liste");
  for (const f of liste) {
    const octets = fichiers.get(f.fichier);
    if (!octets) return ko("fichier_absent");
    if (octets.length !== f.taille || empreinteSha256(octets) !== f.sha256) return ko("empreinte_differente");
  }
  return { ok: true };
}
