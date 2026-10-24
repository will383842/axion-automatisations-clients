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

// Noms des teintes de jetons.css (T0-17), écrits en clés d'objet : la garde des couleurs refuse un nom de couleur CSS entre guillemets.
export const TEINTES = { terracotta: 0, vert: 0, ambre: 0, violet: 0, gris: 0 };
type Teinte = keyof typeof TEINTES;

/** Bloc coloré des maquettes : fond doux, bordure de 1 px dans la teinte, liseret de 4 px (à gauche : encart ; en haut : chiffre clé). Sans teinte : carte blanche. */
export function Carte({ teinte, liseret, children }: { teinte?: Teinte; liseret?: "gauche" | "haut"; children: ReactNode }) {
  const t = (partie: string) => v(`couleur-teinte-${teinte}-${partie}`);
  const cote = (nom: string) => (teinte && liseret === nom ? `4px solid ${t("liseret")}` : `1px solid ${teinte ? t("bordure") : v("couleur-bordure-carte")}`);
  return (
    <section
      style={{
        background: teinte ? t("fond") : v("couleur-fond-carte"),
        color: teinte ? t("titre") : v("couleur-texte-principal"),
        borderTop: cote("haut"),
        borderRight: cote("droite"),
        borderBottom: cote("bas"),
        borderLeft: cote("gauche"),
        borderRadius: v("rayon-12"),
        boxShadow: teinte ? "none" : v("ombre-carte"),
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
const TEINTE_ETAT: Record<Etat, string> = { urgent: "terracotta", averifier: "ambre", fait: "vert", pause: "gris" };
const MOTS: Record<Etat, string> = { urgent: "Urgent", averifier: "À vérifier", fait: "Fait", pause: "En pause" };

/** Pastille pleine, libellé blanc (contraste testé). Toujours un mot : la couleur ne porte jamais seule l'état. */
export function BadgeEtat({ etat, texte }: { etat: Etat; texte?: string }) {
  const mot = texte?.trim() ? texte : MOTS[etat];
  return (
    <span
      style={{
        background: v(`couleur-teinte-${TEINTE_ETAT[etat]}-liseret`),
        color: v("couleur-menu-texte"),
        borderRadius: `calc(${v("rayon-12")} / 2)`,
        flex: "none",
        alignSelf: "flex-start",
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

