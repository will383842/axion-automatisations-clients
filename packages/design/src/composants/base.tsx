/** @jsxRuntime automatic @jsxImportSource react */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

// Briques communes (C-597, C-586). Styles par jetons seulement : var(--…) de jetons.css, aucune couleur littérale.
const v = (nom: string) => `var(--${nom})`;
const CIBLE = "48px";

/** Retire r-plein d'une classe : interdit sur les cases, boutons d'option et leurs libellés (guide, correctif du 24/10). */
function sansPlein(className: string | undefined): string | undefined {
  if (!className?.split(/\s+/).includes("r-plein")) return className;
  if (typeof process === "undefined" || process.env["NODE_ENV"] !== "production") {
    console.warn("r-plein est interdit sur une case à cocher ou un bouton d'option : classe ignorée.");
  }
  return className.split(/\s+/).filter((c) => c !== "r-plein").join(" ");
}

type Teinte = "blanche" | "peche" | "sauge" | "miel" | "rose";
const TEINTES: Record<Teinte, { fond: string; titre: string }> = {
  blanche: { fond: v("couleur-fond-carte"), titre: v("couleur-texte-principal") },
  peche: { fond: v("couleur-peche-fond"), titre: v("couleur-peche-titre") },
  sauge: { fond: v("couleur-sauge-fond"), titre: v("couleur-sauge-titre") },
  miel: { fond: v("couleur-miel-fond"), titre: v("couleur-miel-titre") },
  rose: { fond: v("couleur-rose-fond"), titre: v("couleur-rose-titre") },
};

export function Carte({ teinte = "blanche", children }: { teinte?: Teinte; children: ReactNode }) {
  return (
    <section
      style={{
        background: TEINTES[teinte].fond,
        color: TEINTES[teinte].titre,
        border: `1px solid ${v("couleur-bordure-carte")}`,
        borderRadius: v("rayon-22"),
        boxShadow: v("ombre-carte"),
        padding: v("espacement-24"),
        minWidth: 0,
      }}
    >
      {children}
    </section>
  );
}

/** UN seul bouton principal par zone : les autres actions sont secondaires. */
export function Bouton({ variante, children, ...reste }: { variante: "principal" | "secondaire" } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const principal = variante === "principal";
  return (
    <button
      type="button"
      {...reste}
      data-variante={variante}
      style={{
        minHeight: CIBLE,
        padding: `0 ${v("espacement-24")}`,
        borderRadius: v("rayon-999"),
        fontFamily: v("police-texte"),
        fontSize: v("taille-texte"),
        fontWeight: 800,
        cursor: "pointer",
        background: principal ? v("couleur-action") : v("couleur-fond-carte"),
        color: principal ? v("couleur-menu-texte") : v("couleur-texte-principal"),
        border: principal ? "none" : `1px solid ${v("couleur-bordure-secondaire")}`,
        boxShadow: principal ? v("ombre-action") : "none",
      }}
    >
      {children}
    </button>
  );
}

export function Lien({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      style={{ color: v("couleur-lien"), fontWeight: 800, display: "inline-flex", alignItems: "center", minHeight: CIBLE }}
    >
      {children}
    </a>
  );
}

export type Etat = "urgent" | "averifier" | "fait" | "pause";
const MOTS: Record<Etat, string> = { urgent: "Urgent", averifier: "À vérifier", fait: "Fait", pause: "En pause" };

/** Toujours un mot : la couleur ne porte jamais seule l'état. */
export function BadgeEtat({ etat, texte }: { etat: Etat; texte?: string }) {
  const mot = texte?.trim() ? texte : MOTS[etat];
  return (
    <span
      style={{
        background: v(`couleur-etat-${etat}-fond`),
        color: v(`couleur-etat-${etat}-texte`),
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

const ICONES = { tri: "M4 6h16M4 12h10M4 18h6", comptesRendus: "M5 4h14v16H5zM9 9h6M9 13h6", relances: "M4 12a8 8 0 1 0 3-6M4 4v4h4" } as const;

export function TuileAutomatisation({ identite, nom }: { identite: keyof typeof ICONES; nom: string }) {
  return (
    <span
      role="img"
      aria-label={nom}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "44px",
        height: "44px",
        flex: "none",
        borderRadius: v("rayon-14"),
        background: v(`couleur-automatisation-${identite}-tuile`),
        color: v("couleur-menu-texte"),
      }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <path d={ICONES[identite]} />
      </svg>
    </span>
  );
}

export function PastilleInitiales({ nom, taille = 44 }: { nom: string; taille?: number }) {
  const initiales = nom.split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0]?.toUpperCase()).join("");
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: `${taille}px`,
        height: `${taille}px`,
        flex: "none",
        borderRadius: v("rayon-999"),
        background: v("couleur-initiales-fond"),
        color: v("couleur-initiales-texte"),
        fontWeight: 800,
      }}
    >
      {initiales}
    </span>
  );
}

export function Champ({ id, libelle, ...reste }: { id: string; libelle: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: v("espacement-4"), minWidth: 0 }}>
      <label htmlFor={id} style={{ fontWeight: 700, color: v("couleur-texte-principal") }}>
        {libelle}
      </label>
      <input
        id={id}
        {...reste}
        style={{
          minHeight: CIBLE,
          border: `1px solid ${v("couleur-bordure-champ")}`,
          borderRadius: v("rayon-12"),
          padding: `0 ${v("espacement-16")}`,
          fontSize: "16px",
          fontFamily: v("police-texte"),
          maxWidth: "100%",
        }}
      />
    </div>
  );
}

type Libelle = { libelle: string; className?: string };
function Choix({ type, libelle, className, ...reste }: { type: "checkbox" | "radio" } & Libelle & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label
      className={sansPlein(className)}
      style={{ display: "inline-flex", alignItems: "center", gap: v("espacement-12"), minHeight: CIBLE, flex: "none", color: v("couleur-texte-principal") }}
    >
      <input type={type} {...reste} style={{ width: "24px", height: "24px", flex: "none" }} />
      {libelle}
    </label>
  );
}

/** Jamais r-plein : la case porte flex: none. */
export function CaseACocher(props: Libelle & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className">) {
  return <Choix type="checkbox" {...props} />;
}

export function BoutonOption(props: Libelle & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className">) {
  return <Choix type="radio" {...props} />;
}

export function Bandeau({ type, children }: { type: "incident" | "information"; children: ReactNode }) {
  const incident = type === "incident";
  return (
    <div
      role={incident ? "alert" : "status"}
      style={{
        background: incident ? v("couleur-etat-urgent-fond") : v("couleur-teinte-gris-fond"),
        color: incident ? v("couleur-etat-urgent-texte") : v("couleur-teinte-gris-titre"),
        borderLeft: `4px solid ${incident ? v("couleur-etat-urgent-trait") : v("couleur-teinte-gris-liseret")}`,
        borderRadius: v("rayon-12"),
        padding: `${v("espacement-12")} ${v("espacement-16")}`,
        fontWeight: 700,
      }}
    >
      {children}
    </div>
  );
}

export function LienEvitement({ cible, libelle = "Aller au contenu" }: { cible: string; libelle?: string }) {
  return (
    <a className="evitement" href={`#${cible}`}>
      {libelle}
    </a>
  );
}

