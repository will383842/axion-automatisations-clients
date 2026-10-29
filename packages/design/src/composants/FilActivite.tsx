/** @jsxRuntime automatic @jsxImportSource react */
const v = (nom: string) => `var(--${nom})`;

export type EvenementFil = { id: string; quand: string; texte: string };

const date = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Paris" });

/** Fil d'activité, du plus récent au plus ancien (B-261). */
export function FilActivite({ titre, evenements }: { titre: string; evenements: readonly EvenementFil[] }) {
  const tries = [...evenements].sort((a, b) => Date.parse(b.quand) - Date.parse(a.quand));
  return (
    <section aria-label={titre} style={{ color: v("couleur-texte-principal") }}>
      <h3 style={{ margin: 0, fontFamily: v("police-titre") }}>{titre}</h3>
      {tries.length === 0 ? (
        <p>Aucune activité pour le moment.</p>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {tries.map((e) => (
            <li key={e.id} style={{ padding: `${v("espacement-12")} 0`, borderBottom: `1px solid ${v("couleur-separateur")}` }}>
              <time dateTime={e.quand} style={{ display: "block", color: v("couleur-texte-secondaire"), fontSize: v("taille-precision") }}>
                {date(e.quand)}
              </time>
              {e.texte}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
