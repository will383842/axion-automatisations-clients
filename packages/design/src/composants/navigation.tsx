/** @jsxRuntime automatic @jsxImportSource react */
import type { ReactNode } from "react";
import { PastilleInitiales } from "./base.tsx";

// Navigation commune (C-597, C-586). Le menu latéral (ordinateur) et la barre d'onglets (téléphone) coexistent dans le DOM :
// responsive.css masque l'un ou l'autre sous 720 px.
const v = (nom: string) => `var(--${nom})`;

export type Entree = { id: string; libelle: string; href?: string; compteur?: number };

const MENUS: Record<"console" | "portail", Entree[]> = {
  console: [
    { id: "accueil", libelle: "Accueil" },
    { id: "clients", libelle: "Clients" },
    { id: "alertes", libelle: "Alertes" },
    { id: "demandes", libelle: "Demandes" },
    { id: "facturation", libelle: "Facturation" },
    { id: "catalogue", libelle: "Catalogue" },
    { id: "conformite", libelle: "Conformité" },
  ],
  portail: [
    { id: "accueil", libelle: "Accueil" },
    { id: "arelire", libelle: "À relire" },
    { id: "automatisations", libelle: "Automatisations" },
    { id: "connexions", libelle: "Connexions" },
    { id: "factures", libelle: "Factures" },
    { id: "demandes", libelle: "Demandes" },
    { id: "equipe", libelle: "Mon équipe" },
    { id: "documents", libelle: "Documents" },
  ],
};

const ONGLETS = {
  console: [["accueil", "Accueil"], ["clients", "Clients"], ["alertes", "Alertes"], ["demandes", "Demandes"], ["plus", "Plus"]],
  portail: [["accueil", "Accueil"], ["arelire", "À relire"], ["automatisations", "Automatisations"], ["factures", "Factures"], ["plus", "Plus"]],
  "premiers-pas": [["premiers-pas", "Premiers pas"], ["demandes", "Demandes"]],
  resilie: [["factures", "Factures"], ["documents", "Documents"], ["export", "Export"]],
  bienvenue: [],
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;

const MASQUE_VISUEL = { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clipPath: "inset(50%)" } as const;

function Compteur({ n }: { n: number }) {
  return (
    <>
      <span
        aria-hidden="true"
        style={{ background: v("couleur-menu-actif-fond"), color: v("couleur-menu-actif-texte"), borderRadius: v("rayon-999"), padding: "0 8px", fontSize: v("taille-precision"), fontWeight: 800 }}
      >
        {n}
      </span>
      <span style={MASQUE_VISUEL}>{`, ${n} en attente`}</span>
    </>
  );
}

type PropsMenu = {
  variante: "console" | "portail";
  actif: string;
  logoAxion: string;
  entrees?: Entree[];
  compteurs?: Record<string, number>;
  /** Portail : le client dont l'espace s'affiche. Sans logo, pastille d'initiales + nom. */
  client?: { nom: string; logo?: string };
  /** Portail : action « Arrêter les envois » (bouton d'urgence). */
  surArret?: () => void;
};

export function MenuLateral({ variante, actif, logoAxion, entrees = MENUS[variante], compteurs = {}, client, surArret }: PropsMenu) {
  const portail = variante === "portail";
  return (
    <aside
      className="r-menu"
      style={{ display: "flex", flexDirection: "column", gap: v("espacement-8"), width: "260px", flex: "none", padding: v("espacement-16"), background: v("couleur-menu-fond"), color: v("couleur-menu-texte"), boxSizing: "border-box" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: v("espacement-12") }}>
        {portail && client ? (
          client.logo ? (
            <span style={{ background: v("couleur-fond-carte"), borderRadius: v("rayon-14"), padding: v("espacement-8"), display: "inline-flex" }}>
              <img src={client.logo} alt="" width={36} height={36} />
            </span>
          ) : (
            <PastilleInitiales nom={client.nom} />
          )
        ) : (
          <img src={logoAxion} alt="AXION IA" height={32} />
        )}
        {portail && client ? <span style={{ fontWeight: 800 }}>{client.nom}</span> : null}
      </div>
      <nav aria-label="Menu principal" style={{ display: "flex", flexDirection: "column", gap: v("espacement-4") }}>
        {entrees.map((e) => {
          const courant = e.id === actif;
          const n = e.compteur ?? compteurs[e.id];
          return (
            <a
              key={e.id}
              href={e.href ?? `/${e.id}`}
              aria-current={courant ? "page" : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                minHeight: "48px",
                padding: `0 ${v("espacement-12")}`,
                borderRadius: v("rayon-12"),
                fontWeight: 700,
                textDecoration: "none",
                whiteSpace: "nowrap",
                background: courant ? v("couleur-menu-actif-fond") : "transparent",
                color: courant ? v("couleur-menu-actif-texte") : v("couleur-menu-texte"),
              }}
            >
              {e.libelle}
              {n ? <Compteur n={n} /> : null}
            </a>
          );
        })}
      </nav>
      {portail && surArret ? (
        <button
          type="button"
          onClick={surArret}
          style={{ minHeight: "48px", borderRadius: v("rayon-999"), border: `1px solid ${v("couleur-menu-separateur")}`, background: "transparent", color: v("couleur-menu-texte"), fontWeight: 800, cursor: "pointer" }}
        >
          Arrêter les envois
        </button>
      ) : null}
      {portail ? (
        <div style={{ marginTop: "auto", paddingTop: v("espacement-16"), borderTop: `1px solid ${v("couleur-menu-separateur")}`, color: v("couleur-menu-secondaire"), fontSize: v("taille-precision") }}>
          <div>Propulsé par</div>
          <img src={logoAxion} alt="AXION IA" height={24} />
          <div>axion-ia.com</div>
        </div>
      ) : null}
    </aside>
  );
}

/** Téléphone : en-tête terracotta de 64 px. Le portail pose le logo du client sur une tuile blanche. */
export function EnTeteTelephone({ logo, nomLogo, tuile = false }: { logo: string; nomLogo: string; tuile?: boolean }): ReactNode {
  const image = <img src={logo} alt={nomLogo} height={32} />;
  return (
    <header className="r-entete">
      {tuile ? <span style={{ background: v("couleur-fond-carte"), borderRadius: v("rayon-14"), padding: v("espacement-8"), display: "inline-flex" }}>{image}</span> : image}
    </header>
  );
}

type PropsOnglets = {
  variante: keyof typeof ONGLETS;
  actif: string;
  compteurARelire?: number;
  compteurAlertes?: number;
  hrefs?: Record<string, string>;
};

export function BarreOnglets({ variante, actif, compteurARelire, compteurAlertes, hrefs = {} }: PropsOnglets) {
  const onglets = ONGLETS[variante];
  if (onglets.length === 0) return null;
  const compteurs: Record<string, number | undefined> = { arelire: compteurARelire, alertes: compteurAlertes };
  return (
    <nav className="r-onglets" aria-label="Navigation mobile">
      {onglets.map(([id, libelle]) => {
        const courant = id === actif;
        const n = compteurs[id];
        return (
          <a
            key={id}
            href={hrefs[id] ?? `/${id}`}
            aria-current={courant ? "page" : undefined}
            style={{
              flex: "1 1 0",
              minWidth: "44px",
              minHeight: "48px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: v("espacement-4"),
              fontSize: v("taille-precision"),
              fontWeight: courant ? 800 : 700,
              textDecoration: "none",
              color: courant ? v("couleur-actionTexte") : v("couleur-texte-secondaire"),
            }}
          >
            {libelle}
            {n ? <Compteur n={n} /> : null}
          </a>
        );
      })}
    </nav>
  );
}
