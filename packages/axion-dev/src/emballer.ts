import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { construire } from "@axion-auto/sdk-module/src/emballage/construire.ts";
import { FICHIER_SIGNATURE, SignataireMemoire, signerArtefact, type Artefact } from "@axion-auto/sdk-module/src/emballage/signer.ts";
import { FICHIER_MODULE } from "./essai.ts";

export const DOSSIER_ARTEFACT = "artefact";

// T4-06 puis signature par le signataire de TEST : la clé de production reste dans le coffre (T4-26).
export async function emballer(dossier: string, ecrire: (texte: string) => void): Promise<number> {
  const sortie = join(dossier, DOSSIER_ARTEFACT);
  try {
    const { empreinte } = await construire(join(dossier, FICHIER_MODULE), sortie);
    const fichiers: Artefact = {};
    for (const nom of await readdir(sortie)) if (nom !== FICHIER_SIGNATURE) fichiers[nom] = await readFile(join(sortie, nom));
    const signe = signerArtefact(fichiers, new SignataireMemoire("cle-de-test"));
    await writeFile(join(sortie, FICHIER_SIGNATURE), signe[FICHIER_SIGNATURE] as Uint8Array);
    ecrire(`artefact emballé et signé (clé de test) : ${empreinte}`);
    return 0;
  } catch (e) {
    ecrire((e as Error).message);
    return 2;
  }
}
