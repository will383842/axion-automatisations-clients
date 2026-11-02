/** @jsxRuntime automatic @jsxImportSource react */
import { Bouton } from "./base.tsx";

const v = (nom: string) => `var(--${nom})`;

export type ElementAValider = { id: string; titre: string; detail?: string };

/** File de validation : accepter ou refuser d'un geste, au clavier aussi (A accepte, R refuse) (B-258, B-177). */
export function FileValidation({
  elements,
  onAccepter,
  onRefuser,
}: {
  elements: ElementAValider[];
  onAccepter: (id: string) => void;
  onRefuser: (id: string) => void;
}) {
  if (elements.length === 0) return <p style={{ color: v("couleur-texte-principal"), fontWeight: 700 }}>Rien à valider pour le moment.</p>;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: v("espacement-12") }}>
      {elements.map((e) => (
        <li
          key={e.id}
          tabIndex={0}
          onKeyDown={(ev) => {
            if (ev.target !== ev.currentTarget) return;
            const touche = ev.key.toLowerCase();
            if (touche === "a") onAccepter(e.id);
            if (touche === "r") onRefuser(e.id);
          }}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: v("espacement-12"),
            background: v("couleur-fond-carte"),
            border: `1px solid ${v("couleur-bordure-carte")}`,
            borderRadius: v("rayon-12"),
            padding: v("espacement-16"),
          }}
        >
          <span style={{ flex: "1 1 16rem", minWidth: 0 }}>
            <strong>{e.titre}</strong>
            {e.detail ? <span style={{ display: "block", fontSize: v("taille-precision") }}>{e.detail}</span> : null}
          </span>
          <Bouton variante="secondaire" aria-label={`Accepter : ${e.titre}`} onClick={() => onAccepter(e.id)}>
            Accepter
          </Bouton>
          <Bouton variante="secondaire" aria-label={`Refuser : ${e.titre}`} onClick={() => onRefuser(e.id)}>
            Refuser
          </Bouton>
        </li>
      ))}
    </ul>
  );
}
