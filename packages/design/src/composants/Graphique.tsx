/** @jsxRuntime automatic @jsxImportSource react */
const v = (nom: string) => `var(--${nom})`;

export type PointGraphique = { libelle: string; valeur: number };
const CACHE_VISUEL = { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" } as const;

/** Histogramme en SVG sans bibliothèque : titre, valeurs écrites sur les barres, tableau équivalent pour les lecteurs d'écran (B-257). */
export function Graphique({ titre, points, unite }: { titre: string; points: readonly PointGraphique[]; unite?: string }) {
  const max = Math.max(1, ...points.map((p) => p.valeur));
  const pas = 100;
  const largeur = Math.max(1, points.length) * pas;
  return (
    <figure style={{ margin: 0, color: v("couleur-texte-principal") }}>
      <h3 style={{ margin: 0, fontFamily: v("police-titre") }}>{titre}</h3>
      <svg aria-hidden="true" viewBox={`0 0 ${largeur} 180`} style={{ width: "100%", height: "auto", maxHeight: "16rem" }}>
        {points.map((p, i) => {
          const hauteur = (p.valeur / max) * 120;
          const x = i * pas + 20;
          return (
            <g key={p.libelle}>
              <rect x={x} y={140 - hauteur} width={pas - 40} height={hauteur} rx={4} fill={v("couleur-action")} />
              <text x={x + (pas - 40) / 2} y={132 - hauteur} textAnchor="middle" fill={v("couleur-texte-principal")} fontSize={14} fontWeight={800}>
                {p.valeur}
              </text>
              <text x={x + (pas - 40) / 2} y={165} textAnchor="middle" fill={v("couleur-texte-secondaire")} fontSize={13}>
                {p.libelle}
              </text>
            </g>
          );
        })}
      </svg>
      <table style={CACHE_VISUEL}>
        <caption>{titre}</caption>
        <thead>
          <tr>
            <th scope="col">Repère</th>
            <th scope="col">Valeur</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.libelle}>
              <th scope="row">{p.libelle}</th>
              <td>{unite ? `${p.valeur} ${unite}` : p.valeur}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
