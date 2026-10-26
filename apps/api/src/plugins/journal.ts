// Journal de l'API : toute ligne passe par le masqueur avant d'être écrite (A-005).
// Une valeur de secret lue dans OpenBao est inscrite au masqueur ; elle ne sort plus, ni brute ni encodée.

const REMPLACANT = "[masqué]";

export interface Masqueur {
  ajouter(valeur: string): void;
  masquer(texte: string): string;
}

export function creerMasqueur(): Masqueur {
  let formes: string[] = []; // les plus longues d'abord : une forme ne coupe pas une autre
  return {
    ajouter(valeur) {
      if (typeof valeur !== "string" || !valeur) return;
      const octets = Buffer.from(valeur);
      const nouvelles = [valeur, JSON.stringify(valeur).slice(1, -1), encodeURIComponent(valeur), octets.toString("base64"), octets.toString("base64url")];
      formes = [...new Set([...formes, ...nouvelles])].filter(Boolean).sort((a, b) => b.length - a.length);
    },
    masquer(texte) {
      return formes.reduce((t, f) => t.split(f).join(REMPLACANT), texte);
    },
  };
}

// Flux accepté par le journal de Fastify (option logger.stream) : masque la ligne entière puis la remet à la sortie.
export function creerFluxJournal(masqueur: Masqueur, sortie: (ligne: string) => void = (l) => void process.stdout.write(l)) {
  return { write: (ligne: string) => sortie(masqueur.masquer(ligne)) };
}
