/** @jsxRuntime automatic @jsxImportSource react */
import { useMemo, useState } from "react";
import { Bouton } from "./base.tsx";

const v = (nom: string) => `var(--${nom})`;

export type ColonneTableau = { cle: string; libelle: string };
type Ligne = Record<string, string | number>;

/**
 * Tableau : tri et filtre sur les lignes reçues, pagination PAR CURSEUR (B-175, jamais par décalage),
 * export par une fonction reçue (le composant ne fabrique aucun fichier). Lignes en cartes sous 720 px (r-tableau).
 */
export function Tableau({
  legende,
  colonnes,
  lignes,
  curseurSuivant,
  onPage,
  onExport,
}: {
  legende: string;
  colonnes: readonly ColonneTableau[];
  lignes: readonly Ligne[];
  curseurSuivant?: string | null;
  onPage?: (curseur: string) => void;
  onExport?: () => void;
}) {
  const [tri, setTri] = useState<{ cle: string; sens: 1 | -1 } | null>(null);
  const [filtre, setFiltre] = useState("");
  const affichees = useMemo(() => {
    const mot = filtre.trim().toLowerCase();
    const gardees = mot ? lignes.filter((l) => colonnes.some((c) => String(l[c.cle] ?? "").toLowerCase().includes(mot))) : [...lignes];
    if (!tri) return gardees;
    const { cle, sens } = tri;
    return gardees.sort((a, b) => String(a[cle] ?? "").localeCompare(String(b[cle] ?? ""), "fr", { numeric: true }) * sens);
  }, [lignes, colonnes, tri, filtre]);
  const trier = (cle: string) => setTri((t) => (t?.cle === cle ? { cle, sens: t.sens === 1 ? -1 : 1 } : { cle, sens: 1 }));
  const cellule = { padding: v("espacement-12"), borderBottom: `1px solid ${v("couleur-separateur")}` };
  return (
    <div style={{ color: v("couleur-texte-principal") }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: v("espacement-12"), alignItems: "end", paddingBottom: v("espacement-12") }}>
        <label style={{ display: "grid", gap: v("espacement-4"), fontWeight: 700 }}>
          Filtrer
          <input type="search" value={filtre} onChange={(e) => setFiltre(e.target.value)} style={{ minHeight: "48px", padding: `0 ${v("espacement-12")}`, border: `1px solid ${v("couleur-bordure-champ")}`, borderRadius: v("rayon-12") }} />
        </label>
        {onExport && (
          <Bouton variante="secondaire" onClick={onExport}>
            Exporter
          </Bouton>
        )}
      </div>
      <table className="r-tableau" style={{ width: "100%", borderCollapse: "collapse" }}>
        <caption style={{ textAlign: "left", fontWeight: 800, paddingBottom: v("espacement-8") }}>{legende}</caption>
        <thead>
          <tr>
            {colonnes.map((c) => (
              <th key={c.cle} scope="col" aria-sort={tri?.cle === c.cle ? (tri.sens === 1 ? "ascending" : "descending") : "none"} style={{ ...cellule, textAlign: "left" }}>
                <button type="button" onClick={() => trier(c.cle)} style={{ all: "unset", cursor: "pointer", minHeight: "48px", display: "inline-flex", alignItems: "center", fontWeight: 800 }}>
                  {c.libelle}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {affichees.map((l, i) => (
            <tr key={i}>
              {colonnes.map((c) => (
                <td key={c.cle} data-libelle={c.libelle} style={cellule}>
                  {l[c.cle]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {curseurSuivant && onPage && (
        <div style={{ paddingTop: v("espacement-12") }}>
          <Bouton variante="secondaire" onClick={() => onPage(curseurSuivant)}>
            Page suivante
          </Bouton>
        </div>
      )}
    </div>
  );
}
