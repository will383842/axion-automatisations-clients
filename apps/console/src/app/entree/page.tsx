"use client";

import { useEffect } from "react";

// Réception du lien signé (C-404) : le jeton est dans le fragment (#j=), jamais dans la requête.
// Il est effacé de l'adresse AVANT tout envoi, puis posté dans le corps ; la réponse n'est qu'un chemin local de connexion.
const CONNEXION = "/connexion";
const ENTREE = "/api/console/v1/entree";

// Adresse acceptée : un chemin local seulement (l'API ne rend que la page de connexion de la console avec login_hint) ; sinon connexion normale.
// La page ne connaît pas l'adresse du fournisseur d'identité : la route de connexion (lot 3) la construit.
function adresseSure(valeur: unknown): string {
  return typeof valeur === "string" && /^\/(?![/\\])\S*$/.test(valeur) ? valeur : CONNEXION;
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
