"use client";

import { useEffect } from "react";

// Réception du lien signé (C-404) : le jeton est dans le fragment (#j=), jamais dans la requête.
// Il est effacé de l'adresse AVANT tout envoi, puis posté dans le corps ; la réponse n'est qu'une adresse de connexion.
const CONNEXION = "/connexion";
const ENTREE = "/api/console/v1/entree";

// Adresse acceptée : chemin local, ou http(s) ; jamais « // », « javascript: » ni « data: ».
function adresseSure(valeur: unknown): string {
  if (typeof valeur !== "string" || valeur.startsWith("//") || /[\s\\]/.test(valeur)) return CONNEXION;
  if (valeur.startsWith("/")) return valeur;
  try {
    return /^https?:$/.test(new URL(valeur).protocol) ? valeur : CONNEXION;
  } catch {
    return CONNEXION;
  }
}

async function recevoir(): Promise<string> {
  const jeton = /^#j=([A-Za-z0-9_.-]{1,1024})$/.exec(location.hash)?.[1];
  history.replaceState(null, "", location.pathname);
  if (!jeton) return CONNEXION;
  try {
    const reponse = await fetch(ENTREE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jeton }), credentials: "omit", cache: "no-store", redirect: "error" });
    return reponse.ok ? adresseSure(((await reponse.json()) as { url?: unknown } | null)?.url) : CONNEXION;
  } catch {
    return CONNEXION;
  }
}

export default function Page() {
  useEffect(() => {
    void recevoir().then((adresse) => location.assign(adresse));
  }, []);
  return <main>Connexion en cours…</main>;
}
