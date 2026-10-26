import type { PasserelleIa } from "@axion-auto/sdk-module";

// IA simulée : réponses écrites d'avance, rendues dans l'ordre (la dernière se répète). Aucun appel réseau, aucun jeton compté.
export function creerIaSimulee(reponses: readonly string[] = ["ok"]): PasserelleIa & { demandes: string[] } {
  const demandes: string[] = [];
  return {
    demandes,
    async completer({ entree }) {
      demandes.push(entree);
      const texte = reponses[Math.min(demandes.length - 1, reponses.length - 1)] ?? "ok";
      return { texte, jetons: 0, coutIaMicroCentimes: 0 };
    },
  };
}
