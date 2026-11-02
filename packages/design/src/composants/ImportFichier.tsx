/** @jsxRuntime automatic @jsxImportSource react */
import { useId, useState } from "react";

const v = (nom: string) => `var(--${nom})`;

const ecrireTaille = (octets: number) => (octets > 1_000_000 ? `${Math.round(octets / 100_000) / 10} Mo`.replace(".", ",") : `${Math.round(octets / 1000)} ko`);

/**
 * Contrôle avant envoi : retourne le message à afficher, ou null si le fichier est accepté (B-260).
 * `types` ne contient que des extensions avec le point (".csv"), jamais des types MIME.
 */
export function controlerFichier(f: { name: string; size: number }, types: string[], tailleMax: number): string | null {
  const nom = f.name.toLowerCase();
  if (!types.some((t) => nom.endsWith(t.toLowerCase()))) return `Ce type de fichier n'est pas accepté. Types acceptés : ${types.join(", ")}.`;
  if (f.size > tailleMax) return `Ce fichier est trop lourd. Taille maximale : ${ecrireTaille(tailleMax)}.`;
  return null;
}

/** Import de fichier par choix ou glisser-déposer ; rien n'est transmis tant que le contrôle n'est pas passé (B-260). */
export function ImportFichier({
  libelle,
  types,
  tailleMax,
  onFichier,
}: {
  libelle: string;
  types: string[];
  tailleMax: number;
  onFichier: (fichier: File) => void;
}) {
  const id = useId();
  const idErreur = `${id}-erreur`;
  const [erreur, setErreur] = useState<string | null>(null);
  const traiter = (liste: ArrayLike<File> | null | undefined) => {
    const f = liste?.[0];
    if (!f) return;
    const refus = controlerFichier(f, types, tailleMax);
    setErreur(refus);
    if (!refus) onFichier(f);
  };
  return (
    <div style={{ display: "grid", gap: v("espacement-8") }}>
      <div
        data-zone
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          traiter(e.dataTransfer?.files);
        }}
        style={{
          display: "grid",
          gap: v("espacement-8"),
          border: `2px dashed ${v("couleur-bordure-champ")}`,
          borderRadius: v("rayon-12"),
          background: v("couleur-fond-carte"),
          padding: v("espacement-24"),
        }}
      >
        <label htmlFor={id} style={{ fontWeight: 700, color: v("couleur-texte-principal") }}>
          {libelle}
        </label>
        <span style={{ fontSize: v("taille-precision") }}>Glissez le fichier ici ou choisissez-le.</span>
        <input id={id} type="file" accept={types.join(",")} onChange={(e) => {
            traiter(e.currentTarget.files);
            e.currentTarget.value = "";
          }}
          aria-describedby={erreur ? idErreur : undefined} style={{ minHeight: "48px", fontSize: "16px" }} />
      </div>
      {erreur ? (
        <p id={idErreur} role="alert" style={{ margin: 0, color: v("couleur-etat-urgent-texte"), fontWeight: 700 }}>
          {erreur}
        </p>
      ) : null}
    </div>
  );
}
