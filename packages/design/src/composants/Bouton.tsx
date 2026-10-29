/** @jsxRuntime automatic @jsxImportSource react */
import type { ButtonHTMLAttributes } from "react";

const v = (nom: string) => `var(--${nom})`;

/** Bouton danger (B-262), à côté du principal et du secondaire de base.tsx. Jamais le bouton principal de la zone. */
export function BoutonDanger({ children, ...reste }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...reste}
      data-variante="danger"
      style={{
        minHeight: "48px",
        padding: `0 ${v("espacement-24")}`,
        borderRadius: v("rayon-999"),
        fontFamily: v("police-texte"),
        fontSize: v("taille-texte"),
        fontWeight: 800,
        cursor: "pointer",
        background: v("couleur-etat-urgent-trait"),
        color: v("couleur-menu-texte"),
        border: "none",
      }}
    >
      {children}
    </button>
  );
}
