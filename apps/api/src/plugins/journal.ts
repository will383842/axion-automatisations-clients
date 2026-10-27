// Journal de l'API : toute ligne passe par le masqueur avant d'être écrite (A-005).
// Une valeur de secret lue dans OpenBao est inscrite au masqueur ; elle ne sort plus, ni brute ni encodée.

const REMPLACANT = "[masqué]";
// Une valeur plus courte est ignorée : la remplacer partout casserait et falsifierait toutes les lignes du journal.
// Elle n'entre donc jamais : le coffre et le lecteur technique/ la refusent au rangement comme à la lecture (ADR 0023).
export const LONGUEUR_MINIMALE = 8;
// Champs de traçabilité, posés par le serveur (identifiants) : jamais masqués, pour qu'aucune valeur de client ne les efface.
const TRACABILITE = new Set(["reqId", "tenant", "tenantId"]);
const IDENTIFIANT = /^[A-Za-z0-9-]{1,64}$/;

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
      if (typeof valeur !== "string" || valeur.length < LONGUEUR_MINIMALE) return;
      formes = [...new Set([...formes, valeur, ...formesDe(valeur)])].filter(Boolean).sort((a, b) => b.length - a.length);
    },
    masquer(texte) {
      return formes.reduce((t, f) => t.split(f).join(REMPLACANT), texte);
    },
  };
}

// Masque les valeurs de texte, jamais les noms de champs ni la ponctuation JSON : une valeur choisie par un client
// ne peut ni retirer un champ ni rendre la ligne invalide.
function masquerValeurs(v: unknown, masqueur: Masqueur, cle?: string): unknown {
  if (typeof v === "string") return cle !== undefined && TRACABILITE.has(cle) && IDENTIFIANT.test(v) ? v : masqueur.masquer(v);
  if (Array.isArray(v)) return v.map((x) => masquerValeurs(x, masqueur));
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, masquerValeurs(x, masqueur, k)]));
  return v;
}

// Flux accepté par le journal de Fastify (option logger.stream) : masque chaque valeur de la ligne JSON puis la remet à la sortie.
// Une ligne qui n'est pas du JSON est masquée comme texte brut.
export function creerFluxJournal(masqueur: Masqueur, sortie: (ligne: string) => void = (l) => void process.stdout.write(l)) {
  return {
    write: (ligne: string) => {
      let objet: unknown;
      try {
        objet = JSON.parse(ligne);
      } catch {
        return sortie(masqueur.masquer(ligne));
      }
      if (typeof objet !== "object" || objet === null) return sortie(masqueur.masquer(ligne));
      sortie(`${JSON.stringify(masquerValeurs(objet, masqueur))}${ligne.endsWith("\n") ? "\n" : ""}`);
    },
  };
}
