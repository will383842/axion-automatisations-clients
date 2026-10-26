// Journal de l'API : toute ligne passe par le masqueur avant d'être écrite (A-005).
// Une valeur de secret lue dans OpenBao est inscrite au masqueur ; elle ne sort plus, ni brute ni encodée.

const REMPLACANT = "[masqué]";

export interface Masqueur {
  ajouter(valeur: string): void;
  masquer(texte: string): string;
}

// Formes inscrites : brute, JSON, JSON doublement échappé (JSON recopié dans un message), adresse, formulaire (espace → +),
// base64 et base64url de la valeur, avec les trois décalages possibles d'une valeur placée dans un texte plus long (« Basic base64(utilisateur:secret) »).
// Limites acceptées : hexadécimal, changement de casse et valeur tronquée ne sont pas masqués.
function formesDe(valeur: string): string[] {
  const octets = Buffer.from(valeur);
  const decalees: string[] = [];
  for (const decalage of [0, 1, 2]) {
    const total = Buffer.concat([Buffer.alloc(decalage), octets]);
    for (const codage of ["base64", "base64url"] as const) {
      const texte = total.toString(codage).replace(/=+$/, "");
      // On retire les caractères de bord, qui dépendent des octets voisins (avant : décalage ; après : alignement sur 3 octets).
      const debut = decalage === 0 ? 0 : Math.ceil((decalage * 8) / 6);
      const fin = total.length % 3 === 0 ? texte.length : texte.length - 1;
      const forme = texte.slice(debut, fin);
      if (forme.length >= 4) decalees.push(forme);
    }
  }
  return [
    valeur,
    JSON.stringify(valeur).slice(1, -1),
    JSON.stringify(JSON.stringify(valeur)).slice(3, -3),
    encodeURIComponent(valeur),
    new URLSearchParams({ x: valeur }).toString().slice(2),
    octets.toString("base64"),
    octets.toString("base64url"),
    ...decalees,
  ];
}

export function creerMasqueur(): Masqueur {
  let formes: string[] = []; // les plus longues d'abord : une forme ne coupe pas une autre
  return {
    ajouter(valeur) {
      if (typeof valeur !== "string" || !valeur) return;
      formes = [...new Set([...formes, valeur, ...formesDe(valeur)])].filter(Boolean).sort((a, b) => b.length - a.length);
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
