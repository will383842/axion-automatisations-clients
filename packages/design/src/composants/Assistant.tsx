/** @jsxRuntime automatic @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { Bouton } from "./base.tsx";

const v = (nom: string) => `var(--${nom})`;

export type EtapeAssistant = { id: string; titre: string; rendu: (p: { valeur: string; changer: (valeur: string) => void }) => ReactNode };

/**
 * Assistant pas à pas (B-212) : une étape par écran, barre de progression, retour arrière.
 * Le brouillon est confié à la fonction onBrouillon, jamais au stockage du navigateur : il peut contenir des données d'un client.
 * Un seul bouton principal : « Continuer » ou l'action finale.
 */
export function Assistant({
  titre,
  etapes,
  brouillonInitial,
  onBrouillon,
  onTerminer,
  libelleFin,
}: {
  titre: string;
  etapes: EtapeAssistant[];
  brouillonInitial?: Record<string, string>;
  onBrouillon: (brouillon: Record<string, string>, etapeId: string) => void;
  onTerminer: (brouillon: Record<string, string>) => void;
  libelleFin: string;
}) {
  const [index, setIndex] = useState(0);
  const [brouillon, setBrouillon] = useState<Record<string, string>>(brouillonInitial ?? {});
  const etape = etapes[index];
  if (!etape) return null;
  const derniere = index === etapes.length - 1;
  const changer = (valeur: string) => {
    const suite = { ...brouillon, [etape.id]: valeur };
    setBrouillon(suite);
    onBrouillon(suite, etape.id);
  };
  return (
    <section aria-labelledby="assistant-titre" style={{ display: "grid", gap: v("espacement-16") }}>
      <h2 id="assistant-titre" style={{ margin: 0 }}>
        {titre}
      </h2>
      <p style={{ margin: 0, fontWeight: 700 }}>
        Étape {index + 1} sur {etapes.length} : {etape.titre}
      </p>
      <div
        role="progressbar"
        aria-label="Avancement"
        aria-valuemin={1}
        aria-valuemax={etapes.length}
        aria-valuenow={index + 1}
        aria-valuetext={`Étape ${index + 1} sur ${etapes.length}`}
        style={{ height: v("espacement-8"), background: v("couleur-bordure-carte"), borderRadius: v("rayon-999"), overflow: "hidden" }}
      >
        <div style={{ width: `${((index + 1) / etapes.length) * 100}%`, height: "100%", background: v("couleur-action") }} />
      </div>
      <div>{etape.rendu({ valeur: brouillon[etape.id] ?? "", changer })}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: v("espacement-12") }}>
        {index > 0 ? (
          <Bouton variante="secondaire" onClick={() => setIndex(index - 1)}>
            Retour
          </Bouton>
        ) : null}
        <Bouton variante="principal" onClick={() => (derniere ? onTerminer(brouillon) : setIndex(index + 1))}>
          {derniere ? libelleFin : "Continuer"}
        </Bouton>
      </div>
    </section>
  );
}
