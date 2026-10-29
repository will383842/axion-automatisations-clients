/** @jsxRuntime automatic @jsxImportSource react */
const v = (nom: string) => `var(--${nom})`;

// Teintes des jetons : vert = fait, orange = à vérifier, rouge = urgent, gris = pause.
const JETONS = {
  vert: { fond: "couleur-etat-fait-fond", texte: "couleur-etat-fait-texte", trait: "couleur-etat-fait-trait" },
  orange: { fond: "couleur-etat-averifier-fond", texte: "couleur-etat-averifier-texte", trait: "couleur-etat-averifier-trait" },
  rouge: { fond: "couleur-etat-urgent-fond", texte: "couleur-etat-urgent-texte", trait: "couleur-etat-urgent-trait" },
  gris: { fond: "couleur-teinte-gris-fond", texte: "couleur-teinte-gris-titre", trait: "couleur-teinte-gris-liseret" },
};
// Noms écrits en clés d'objet : la garde des couleurs refuse un nom de couleur CSS entre guillemets.
export type CouleurPastille = keyof typeof JETONS;

/** Pastille de couleur, toujours avec un mot : sans mot, elle est refusée (B-264). */
export function Pastille({ couleur, mot }: { couleur: CouleurPastille; mot: string }) {
  if (!mot.trim()) throw new Error("Une pastille doit toujours porter un mot.");
  const j = JETONS[couleur];
  return (
    <span
      data-couleur={couleur}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: v("espacement-8"),
        background: v(j.fond),
        color: v(j.texte),
        border: `1px solid ${v(j.trait)}`,
        borderRadius: v("rayon-999"),
        padding: `${v("espacement-4")} ${v("espacement-12")}`,
        fontSize: v("taille-precision"),
        fontWeight: 800,
        whiteSpace: "nowrap",
      }}
    >
      {mot}
    </span>
  );
}
