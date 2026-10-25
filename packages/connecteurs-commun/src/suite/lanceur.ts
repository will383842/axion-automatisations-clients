import { jouerSuite, type Fabrique } from "./messagerie.ts";

// Lanceur sans réseau : rejoue la suite contre la fabrique donnée (réponses enregistrées, mémoire ou faux serveur).
export async function lancer(fabrique: Fabrique): Promise<void> {
  const ratés = (await jouerSuite(fabrique)).filter((r) => !r.ok);
  if (ratés.length) throw new Error(`la suite échoue : ${ratés.map((r) => `${r.nom} (${r.detail})`).join(" ; ")}`);
}
