/** @jsxRuntime automatic @jsxImportSource react */
import { useState } from "react";
import { Bouton } from "./base.tsx";

const v = (nom: string) => `var(--${nom})`;

export type ChampFormulaire = { id: string; libelle: string; type?: string; aide?: string; erreur?: string };

/** Formulaire à champs courts : aide à la demande, erreur sous le champ reliée par aria-describedby (B-259). */
export function Formulaire({
  champs,
  valeurs,
  onChange,
  onEnvoyer,
  libelleEnvoi,
}: {
  champs: ChampFormulaire[];
  valeurs: Record<string, string>;
  onChange: (id: string, valeur: string) => void;
  onEnvoyer: () => void;
  libelleEnvoi: string;
}) {
  const [ouvertes, setOuvertes] = useState<Record<string, boolean>>({});
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onEnvoyer();
      }}
      style={{ display: "grid", gap: v("espacement-16") }}
    >
      {champs.map((c) => {
        const liens = [c.aide && ouvertes[c.id] ? `${c.id}-aide` : "", c.erreur ? `${c.id}-erreur` : ""].filter(Boolean).join(" ");
        return (
          <div key={c.id} style={{ display: "grid", gap: v("espacement-4"), minWidth: 0 }}>
            <label htmlFor={c.id} style={{ fontWeight: 700, color: v("couleur-texte-principal") }}>
              {c.libelle}
            </label>
            <input
              id={c.id}
              type={c.type ?? "text"}
              value={valeurs[c.id] ?? ""}
              onChange={(e) => onChange(c.id, e.target.value)}
              aria-describedby={liens || undefined}
              aria-invalid={c.erreur ? true : undefined}
              style={{
                minHeight: "48px",
                border: `1px solid ${c.erreur ? v("couleur-etat-urgent-trait") : v("couleur-bordure-champ")}`,
                borderRadius: v("rayon-12"),
                padding: `0 ${v("espacement-16")}`,
                fontSize: "16px",
                fontFamily: v("police-texte"),
                maxWidth: "100%",
              }}
            />
            {c.erreur ? (
              <p id={`${c.id}-erreur`} style={{ margin: 0, color: v("couleur-etat-urgent-texte"), fontWeight: 700 }}>
                {c.erreur}
              </p>
            ) : null}
            {c.aide ? (
              <>
                <button
                  type="button"
                  aria-expanded={!!ouvertes[c.id]}
                  onClick={() => setOuvertes({ ...ouvertes, [c.id]: !ouvertes[c.id] })}
                  style={{ justifySelf: "start", minHeight: "48px", background: "none", border: "none", cursor: "pointer", color: v("couleur-lien"), fontWeight: 800, fontFamily: v("police-texte"), fontSize: v("taille-texte") }}
                >
                  Besoin d'aide ?
                </button>
                {ouvertes[c.id] ? (
                  <p id={`${c.id}-aide`} style={{ margin: 0, fontSize: v("taille-precision") }}>
                    {c.aide}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        );
      })}
      <div>
        <Bouton variante="principal" type="submit">
          {libelleEnvoi}
        </Bouton>
      </div>
    </form>
  );
}
