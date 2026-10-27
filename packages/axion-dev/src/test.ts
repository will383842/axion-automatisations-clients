import { lancerJeuEssai } from "@axion-auto/harnais";
import { chargerModule } from "./essai.ts";

// Tout le harnais (T4-05) : jeu d'essai du module, e-mails piégés, déterminisme, IA hostile.
export async function test(dossier: string, ecrire: (texte: string) => void): Promise<number> {
  const { module, reglages } = await chargerModule(dossier);
  const rapport = await lancerJeuEssai(module, { reglages });
  for (const c of rapport.cas.filter((x) => !x.reussi)) ecrire(`échec ${c.id} : ${c.ecart ?? "écart inconnu"}`);
  for (const d of rapport.determinisme.filter((x) => !x.reussi)) ecrire(`échec déterminisme de l'étape ${d.etape}`);
  ecrire(`${rapport.totaux.reussis} tests réussis, ${rapport.totaux.echoues} échoués`);
  return rapport.codeSortie;
}
