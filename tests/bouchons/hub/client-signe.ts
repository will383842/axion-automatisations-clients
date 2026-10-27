import { EN_TETES, signer } from "../../../packages/contrats/src/commun/signature.ts";

export interface Identifiants {
  cle: string;
  secret: string;
}

export interface OptionsEnvoi {
  cleIdempotence?: string;
  // Secondes Unix : fixer la même valeur deux fois reproduit une signature identique (rejeu).
  horodatage?: number;
}

// Client signé commun aux tests : chaque appel signe avec les fonctions de packages/contrats, jamais celles de l'API.
export async function envoyerSigne(base: string, ident: Identifiants, methode: "GET" | "POST", chemin: string, corps?: unknown, options: OptionsEnvoi = {}) {
  const brut = corps === undefined ? "" : JSON.stringify(corps);
  const horodatage = String(options.horodatage ?? Math.floor(Date.now() / 1000));
  const entetes: Record<string, string> = {
    [EN_TETES.cle]: ident.cle,
    [EN_TETES.horodatage]: horodatage,
    [EN_TETES.signature]: signer(ident.secret, horodatage, methode, chemin, brut),
    "Content-Type": "application/json",
  };
  if (options.cleIdempotence) entetes["Idempotency-Key"] = options.cleIdempotence;
  const reponse = await fetch(`${base}${chemin}`, { method: methode, headers: entetes, ...(methode === "POST" ? { body: brut } : {}) });
  const texte = await reponse.text();
  return { statut: reponse.status, entetes: reponse.headers, corps: texte ? JSON.parse(texte) : null };
}
