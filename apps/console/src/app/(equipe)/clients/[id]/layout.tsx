import { notFound } from "next/navigation.js";
import type { ReactNode } from "react";
import { BandeauSante } from "../../../../composants/BandeauSante.tsx";
import { OngletsFiche } from "../../../../composants/OngletsFiche.tsx";
import { lireFiche } from "../../../../fiche/onglets.ts";

// Coque de la fiche : bandeau de santé et onglets au-dessus de chaque onglet (B-035). Client hors portée : l'API répond 404, la page aussi.
export default async function MiseEnPageFiche({ children, params }: { children: ReactNode; params: Promise<{ id?: string }> }) {
  const { id } = await params;
  const fiche = await lireFiche(id);
  if (!fiche || !id) return <section aria-labelledby="titre"><h1 id="titre">Fiche client</h1><p>Cette fiche n’est pas disponible pour le moment.</p></section>;
  if (fiche === "absente") notFound();
  return (
    <div>
      <BandeauSante bandeau={fiche.bandeau} />
      <OngletsFiche id={id} actif="" />
      {children}
    </div>
  );
}
