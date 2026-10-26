/** @jsxRuntime automatic @jsxImportSource react */
import { Button } from "@react-email/components";
import type { ReactNode } from "react";
import { jetons, valeur } from "../jetons.ts";

// Bouton d'e-mail : cible de 48 px au moins (C-597), texte blanc sur terracotta.
export function Bouton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button
      href={href}
      style={{ display: "inline-block", boxSizing: "border-box", minHeight: "48px", lineHeight: "48px", padding: `0 ${jetons.espacement[24]}`, borderRadius: jetons.rayon[999], background: valeur("couleur.actionTexte"), color: valeur("couleur.menu.texte"), fontWeight: 800, textDecoration: "none" }}
    >
      {children}
    </Button>
  );
}
