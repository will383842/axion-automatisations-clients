// Contrat commun d'un module en code et d'un module enveloppe (A-308, A-310) : même entrée, mêmes événements, même fiche.
export type Json = null | boolean | number | string | Json[] | { [cle: string]: Json };

export interface Evenement {
  type: string;
  donnees: Json;
}
export interface Sortie {
  evenements: Evenement[];
}
export interface Fiche {
  nom: string;
  champs: string[];
  // Types d'événements que le module déclare dans sa fiche : tout autre type est refusé.
  evenements: string[];
}
export interface ModuleExecutable {
  fiche: Fiche;
  executer(entree: Json): Promise<Sortie>;
}
// Entrée de ops/briques/<nom>.json (schéma de la garde des briques), sans les champs d'exploitation.
export interface Brique {
  nom: string;
  image: string;
  version: string;
  empreinte: string;
  licence: string;
}

const CLES_INTERDITES = new Set(["__proto__", "client", "tenant_id"]);

function verifierJson(v: unknown, chemin: string): Json {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`${chemin} : nombre non JSON`);
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => verifierJson(x, `${chemin}[${i}]`));
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const sortie: { [cle: string]: Json } = {};
    for (const [cle, x] of Object.entries(v)) {
      if (CLES_INTERDITES.has(cle)) throw new Error(`${chemin} : clé « ${cle} » interdite`);
      sortie[cle] = verifierJson(x, `${chemin}.${cle}`);
    }
    return sortie;
  }
  throw new Error(`${chemin} : valeur non JSON`);
}

// Forme unique des événements, vérifiée sur la sortie d'un conteneur : tableau, type déclaré, données = objet JSON simple, clés interdites écartées.
export function versEvenements(s: Sortie, typesDeclares: readonly string[]): Evenement[] {
  const evenements: unknown = (s as { evenements?: unknown } | null)?.evenements;
  if (!Array.isArray(evenements)) throw new Error("événement : la sortie n'est pas un tableau");
  return evenements.map((e: unknown, i) => {
    if (typeof e !== "object" || e === null || Array.isArray(e)) throw new Error(`événement ${i} : objet attendu`);
    const { type, donnees } = e as { type?: unknown; donnees?: unknown };
    if (typeof type !== "string" || type === "") throw new Error(`événement ${i} sans type`);
    if (!typesDeclares.includes(type)) throw new Error(`événement ${i} : type « ${type} » non déclaré dans la fiche`);
    if (typeof donnees !== "object" || donnees === null || Array.isArray(donnees)) throw new Error(`événement ${i} : données = objet JSON simple attendu`);
    return { type, donnees: verifierJson(donnees, `événement ${i}.donnees`) };
  });
}
