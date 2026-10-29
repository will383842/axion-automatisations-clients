/** @jsxRuntime automatic @jsxImportSource react */
import type { ReactNode } from "react";
import { Bouton } from "./base.tsx";

const v = (nom: string) => `var(--${nom})`;

export type NiveauBandeau = "information" | "avertissement" | "erreur";
const JETONS: Record<NiveauBandeau, { fond: string; texte: string; trait: string }> = {
  information: { fond: "couleur-teinte-gris-fond", texte: "couleur-teinte-gris-titre", trait: "couleur-teinte-gris-liseret" },
  avertissement: { fond: "couleur-etat-averifier-fond", texte: "couleur-etat-averifier-texte", trait: "couleur-etat-averifier-trait" },
  erreur: { fond: "couleur-etat-urgent-fond", texte: "couleur-etat-urgent-texte", trait: "couleur-etat-urgent-trait" },
};

/** Bandeau d'information, d'avertissement ou d'erreur, avec toujours l'action à faire (B-263). */
export function BandeauAction({ niveau, action, children }: { niveau: NiveauBandeau; action: { libelle: string; onClick: () => void }; children: ReactNode }) {
  const j = JETONS[niveau];
  return (
    <div
      role={niveau === "erreur" ? "alert" : "status"}
      data-niveau={niveau}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: v("espacement-12"),
        background: v(j.fond),
        color: v(j.texte),
        borderLeft: `4px solid ${v(j.trait)}`,
        borderRadius: v("rayon-12"),
        padding: `${v("espacement-12")} ${v("espacement-16")}`,
        fontWeight: 700,
      }}
    >
      <span style={{ flex: "1 1 16rem", minWidth: 0 }}>{children}</span>
      <Bouton variante="secondaire" onClick={action.onClick}>
        {action.libelle}
      </Bouton>
    </div>
  );
}
