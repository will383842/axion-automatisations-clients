/** @jsxRuntime automatic @jsxImportSource react */
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BarreOnglets, EnTeteTelephone, LienEvitement, MenuLateral } from "../src/index.ts";
import { valeur } from "../src/jetons.ts";
import "../src/polices.css";
import "../src/jetons.css";
import "../src/responsive.css";
import "./galerie.css";

// Logos fictifs de la galerie, dessinés avec les jetons : aucune image distante.
const vignette = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
export const LOGO_AXION = vignette(
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32" viewBox="0 0 120 32"><text x="0" y="24" font-family="sans-serif" font-size="22" font-weight="800" fill="${valeur("couleur.menu.texte")}">AXION IA</text></svg>`,
);
export const LOGO_LEMOINE = vignette(
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${valeur("couleur.initiales.fond")}"/><text x="16" y="23" text-anchor="middle" font-family="serif" font-size="20" font-weight="700" fill="${valeur("couleur.initiales.texte")}">L</text></svg>`,
);

type PropsPage = { variante: "console" | "portail"; actif: string; compteurs?: Record<string, number>; children: ReactNode };

export function Page({ variante, actif, compteurs = {}, children }: PropsPage) {
  const portail = variante === "portail";
  return (
    <div className="r-racine" style={{ display: "flex", minHeight: "100vh" }}>
      <LienEvitement cible="contenu" />
      <MenuLateral variante={variante} actif={actif} logoAxion={LOGO_AXION} compteurs={compteurs} client={portail ? { nom: "Lemoine Rénovation", logo: LOGO_LEMOINE } : undefined} />
      {portail ? <EnTeteTelephone logo={LOGO_LEMOINE} nomLogo="Lemoine Rénovation" tuile /> : <EnTeteTelephone logo={LOGO_AXION} nomLogo="AXION IA" />}
      <main id="contenu" className="r-contenu" style={{ flex: "1 1 0", minWidth: 0, padding: "var(--espacement-32)", boxSizing: "border-box" }}>
        {children}
      </main>
      <BarreOnglets variante={variante} actif={actif} compteurARelire={portail ? compteurs["arelire"] : undefined} compteurAlertes={portail ? undefined : compteurs["alertes"]} />
    </div>
  );
}

export function monter(page: ReactNode) {
  createRoot(document.getElementById("racine")!).render(page);
}
