import { createHash, randomUUID } from "node:crypto";

// Données de test du catalogue (T2-03) : FICTIVES. Les montants sont visiblement faux (123456, 99) : aucun prix réel, jamais.
export const GRILLE_FICTIVE = Object.freeze({ installation: 123456, mensuel: 99, maintenance: 99, pack: 123456 });

// Empreinte SHA-256 en hexadécimal minuscule, tirée au hasard : une même empreinte ne se range pas deux fois.
export const empreinteFictive = (): string => createHash("sha256").update(randomUUID()).digest("hex");

export const automatisationFictive = (code: string): Record<string, unknown> => ({
  code,
  nom: `Automatisation fictive ${code}`,
  fonction: "Relancer les devis restés sans réponse",
  description: "Automatisation inventée pour les essais ; ne décrit aucun produit réel.",
});

export const versionFictive = (automatisationId: string): Record<string, unknown> => ({
  automatisation_id: automatisationId,
  semver: "1.0.0",
  api_moteur: ">=1.0.0 <2.0.0",
  artefact_ref: "artefacts/essai/1.0.0.tar",
  empreinte_sha256: empreinteFictive(),
  signature_ed25519: "c2lnbmF0dXJlLWZpY3RpdmU=",
  sbom_ref: "sbom/essai/1.0.0.json",
  nature: "creation",
  manifeste: { connecteurs: [] },
});
