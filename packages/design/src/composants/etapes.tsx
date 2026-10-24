/** @jsxRuntime automatic @jsxImportSource react */
// Frise (ordinateur) et étape sur total (téléphone) : même contenu, l'un caché par responsive.css selon la largeur.
const v = (nom: string) => `var(--${nom})`;

type PropsEtapes = { etapes: readonly string[]; courante: number };

/** `courante` compte à partir de 1. */
export function Frise({ etapes, courante }: PropsEtapes) {
  return (
    <ol className="r-cache-mobile" aria-label="Étapes" style={{ display: "flex", gap: v("espacement-8"), listStyle: "none", margin: 0, padding: 0 }}>
      {etapes.map((nom, i) => {
        const fait = i + 1 <= courante;
        return (
          <li
            key={nom}
            aria-current={i + 1 === courante ? "step" : undefined}
            style={{ flex: "1 1 0", minWidth: 0, padding: v("espacement-12"), borderRadius: v("rayon-12"), fontWeight: 700, background: fait ? v("couleur-peche-fond") : v("couleur-fond-carte"), color: v("couleur-texte-principal"), border: `1px solid ${v("couleur-bordure-carte")}` }}
          >
            {nom}
          </li>
        );
      })}
    </ol>
  );
}

export function EtapeSurTotal({ etapes, courante }: PropsEtapes) {
  const total = etapes.length;
  return (
    <div className="r-mobile-seul">
      <p style={{ margin: 0, fontWeight: 800, color: v("couleur-texte-principal") }}>{`Étape ${courante} sur ${total} : ${etapes[courante - 1] ?? ""}`}</p>
      <div role="progressbar" aria-label="Progression" aria-valuemin={0} aria-valuemax={total} aria-valuenow={courante} style={{ height: v("espacement-8"), borderRadius: v("rayon-999"), background: v("couleur-separateur") }}>
        <div style={{ width: `${(courante / total) * 100}%`, height: "100%", borderRadius: v("rayon-999"), background: v("couleur-action") }} />
      </div>
    </div>
  );
}

/** Tableau en ordinateur, cartes empilées en téléphone (data-libelle repris en tête de chaque valeur). */
export function TableauCartes({ legende, colonnes, lignes }: { legende: string; colonnes: readonly string[]; lignes: readonly (readonly string[])[] }) {
  return (
    <table className="r-tableau" style={{ width: "100%", borderCollapse: "collapse", color: v("couleur-texte-principal") }}>
      <caption style={{ textAlign: "left", fontWeight: 800, paddingBottom: v("espacement-8") }}>{legende}</caption>
      <thead>
        <tr>
          {colonnes.map((c) => (
            <th key={c} scope="col" style={{ textAlign: "left", padding: v("espacement-12"), borderBottom: `1px solid ${v("couleur-separateur")}` }}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {lignes.map((ligne, i) => (
          <tr key={i}>
            {ligne.map((valeur, j) => (
              <td key={j} data-libelle={colonnes[j]} style={{ padding: v("espacement-12"), borderBottom: `1px solid ${v("couleur-separateur")}` }}>
                {valeur}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
