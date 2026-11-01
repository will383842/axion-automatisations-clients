/** @jsxRuntime automatic @jsxImportSource react */
import type { ReactNode } from "react";

const v = (nom: string) => `var(--${nom})`;

export type Evolution = { variation: number; periode: string };

// L'évolution est dite en mots ; la flèche est décorative (B-255).
function phrase({ variation, periode }: Evolution): { texte: string; fleche: string } {
  if (variation > 0) return { texte: `En hausse de ${variation} % ${periode}`, fleche: "▲" };
  if (variation < 0) return { texte: `En baisse de ${Math.abs(variation)} % ${periode}`, fleche: "▼" };
  return { texte: `Stable ${periode}`, fleche: "▬" };
}

/** Un chiffre et son évolution (B-255, B-174). */
export function Indicateur({ libelle, valeur, evolution }: { libelle: string; valeur: ReactNode; evolution?: Evolution }) {
  const e = evolution && phrase(evolution);
  return (
    <div style={{ background: v("couleur-fond-carte"), border: `1px solid ${v("couleur-bordure-carte")}`, borderRadius: v("rayon-12"), padding: v("espacement-16"), minWidth: 0 }}>
      <p style={{ margin: 0, color: v("couleur-texte-secondaire"), fontSize: v("taille-precision") }}>{libelle}</p>
      <p style={{ margin: `${v("espacement-4")} 0`, color: v("couleur-texte-principal"), fontFamily: v("police-titre"), fontSize: "2rem", fontWeight: 800 }}>{valeur}</p>
      {e && (
        <p style={{ margin: 0, color: v("couleur-texte-secondaire"), fontSize: v("taille-precision"), fontWeight: 700 }}>
          <span aria-hidden="true">{e.fleche} </span>
          {e.texte}
        </p>
      )}
    </div>
  );
}
