import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EN_TETES, signer } from "@axion-auto/contrats/src/commun/signature.ts";
import { empreinteArtefact, type Artefact } from "@axion-auto/sdk-module/src/emballage/signer.ts";
import { DOSSIER_ARTEFACT } from "./emballer.ts";

export interface OptionsPublier {
  env: Record<string, string | undefined>;
  recette: boolean;
  // Adresse de la recette écrite dans la configuration (origine), en plus des noms en .test.
  recetteConfiguree?: string | undefined;
  fetch: typeof fetch;
}

const TENTATIVES = 3;

// Seule la recette est permise : un nom en .test ou l'adresse écrite dans la configuration.
function adresseRecette(valeur: string | undefined, configuree: string | undefined): URL | undefined {
  try {
    const url = new URL(valeur ?? "");
    return url.hostname.endsWith(".test") || url.origin === configuree ? url : undefined;
  } catch {
    return undefined;
  }
}

// Envoie l'artefact signé à l'import de la recette. Chaque essai est re-signé (nouvel horodatage) ; l'Idempotency-Key reste la même.
export async function publier(dossier: string, o: OptionsPublier, ecrire: (texte: string) => void): Promise<number> {
  if (!o.recette) return ecrire("publication refusée : seule la recette est permise (--recette) ; la publication au catalogue se fait dans la console"), 3;
  const url = adresseRecette(o.env["AXION_RECETTE_URL"], o.recetteConfiguree);
  const secret = o.env["AXION_RECETTE_SECRET"];
  if (!url || !secret) return ecrire("envoi refusé : AXION_RECETTE_URL doit viser la recette (nom en .test) et AXION_RECETTE_SECRET doit être défini"), 3;

  const sortie = join(dossier, DOSSIER_ARTEFACT);
  const fichiers: Artefact = {};
  for (const nom of await readdir(sortie)) fichiers[nom] = await readFile(join(sortie, nom));
  if (!fichiers["signature.json"]) return ecrire("envoi refusé : artefact non signé, lancer « axion-dev emballer » d'abord"), 2;
  const corps = JSON.stringify({ fichiers: Object.fromEntries(Object.entries(fichiers).map(([n, c]) => [n, Buffer.from(c).toString("base64")])) });
  const cle = `publier-${empreinteArtefact(fichiers)}`;

  for (let i = 1; i <= TENTATIVES; i++) {
    const horodatage = String(Math.floor(Date.now() / 1000));
    try {
      const r = await o.fetch(url, {
        method: "POST",
        body: corps,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": cle,
          [EN_TETES.cle]: "recette",
          [EN_TETES.horodatage]: horodatage,
          [EN_TETES.signature]: signer(secret, horodatage, "POST", url.pathname + url.search, corps),
        },
      });
      if (r.ok) return ecrire("artefact envoyé à la recette"), 0;
      if (r.status < 500) break;
    } catch {
      // panne réseau : nouvel essai
    }
  }
  return ecrire("envoi refusé ou en panne : la recette n'a pas accepté l'artefact"), 3;
}
