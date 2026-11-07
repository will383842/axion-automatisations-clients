import { ResumeFiche } from "../../../../composants/OngletsFiche.tsx";
import { lireFiche } from "../../../../fiche/onglets.ts";

// Onglet « Résumé » : le bandeau et les onglets viennent de la disposition (layout.tsx).
export default async function Page({ params }: { params: Promise<{ id?: string }> }) {
  const { id } = await params;
  const fiche = await lireFiche(id);
  if (!id || !fiche || fiche === "absente") return null;
  return <ResumeFiche id={id} resume={fiche.resume} />;
}
