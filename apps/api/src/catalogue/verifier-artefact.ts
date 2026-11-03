import { gunzipSync } from "node:zlib";
import type { ClePublique } from "../../../../packages/sdk-module/src/emballage/cles-publiques.ts";
import { verifierCode, verifierLicences, verifierProvenance, type Paquet } from "../../../../packages/sdk-module/src/emballage/gardes.ts";
import { FICHIER_SIGNATURE, cheminValide, type Artefact } from "../../../../packages/sdk-module/src/emballage/signer.ts";
import { verifierArtefact } from "../../../../packages/sdk-module/src/emballage/verifier.ts";
import { FICHIERS_OBLIGATOIRES, FICHIERS_PERMIS, LIMITES, ManifesteImporte, type CodeRefus } from "./schema.js";

// La console revérifie TOUT : la parole du poste qui envoie ne compte pas (C-248). Elle ne lit que des octets et du JSON : jamais d'évaluation du module.
export type Verifie = { ok: true; fichiers: Artefact; empreinte: string; idCle: string; signature: string; manifeste: ManifesteImporte };
export type Resultat = Verifie | { ok: false; code: CodeRefus };
const refus = (code: CodeRefus): Resultat => ({ ok: false, code });

const texte = (o: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(o);
// Champ tar en texte jusqu'au premier octet nul.
const champ = (b: Uint8Array) => texte(b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)));
const octal = (b: Uint8Array) => {
  const t = champ(b).trim();
  return /^[0-7]+$/.test(t) ? parseInt(t, 8) : NaN;
};

// Archive tar compressée (gzip), lue à la main : fichiers ordinaires seulement. Refuse lien, dossier, chemin hors du dossier, doublon, fichier inconnu, taille hors bornes.
export function lireArchive(archive: Uint8Array): Artefact | undefined {
  try {
    if (archive.length === 0 || archive.length > LIMITES.archiveOctets) return undefined;
    const tar = new Uint8Array(gunzipSync(archive, { maxOutputLength: LIMITES.decompresseOctets }));
    const fichiers: Artefact = Object.create(null) as Artefact;
    let i = 0;
    while (i + 512 <= tar.length) {
      const entete = tar.subarray(i, i + 512);
      if (entete.every((x) => x === 0)) return tar.subarray(i).every((x) => x === 0) && Object.keys(fichiers).length ? fichiers : undefined;
      const somme = entete.reduce((a, x, k) => a + (k >= 148 && k < 156 ? 32 : x), 0);
      const taille = octal(entete.subarray(124, 136));
      const type = String.fromCharCode(entete[156] ?? 0);
      const nom = champ(entete.subarray(0, 100));
      if (octal(entete.subarray(148, 156)) !== somme || !Number.isSafeInteger(taille) || (type !== "0" && type !== "\0") || champ(entete.subarray(345, 500)) !== "") return undefined;
      if (!cheminValide(nom) || !FICHIERS_PERMIS.has(nom) || nom in fichiers || Object.keys(fichiers).length >= LIMITES.fichiers) return undefined;
      const debut = i + 512;
      if (debut + taille > tar.length) return undefined;
      fichiers[nom] = tar.slice(debut, debut + taille);
      i = debut + Math.ceil(taille / 512) * 512;
    }
    return undefined; // pas de fin d'archive : tronquée
  } catch {
    return undefined;
  }
}

export function verifierArtefactImporte(archive: Uint8Array, cles: readonly ClePublique[]): Resultat {
  const lu = lireArchive(archive);
  if (!lu || !FICHIERS_OBLIGATOIRES.every((f) => f in lu)) return refus("archive_invalide");
  const signe = verifierArtefact(lu, cles);
  if (!signe.ok) return refus("module_non_signe");
  try {
    // La signature a été vérifiée : signature.json est bien formé (idCle, empreinte, signature en chaînes).
    const { idCle, empreinte, signature } = JSON.parse(texte(signe.fichiers[FICHIER_SIGNATURE] as Uint8Array)) as { idCle: string; empreinte: string; signature: string };
    const manifeste = ManifesteImporte.safeParse(JSON.parse(texte(signe.fichiers["manifest.json"] as Uint8Array)));
    if (!manifeste.success) return refus("manifeste_invalide");
    const bom = JSON.parse(texte(signe.fichiers["sbom.cdx.json"] as Uint8Array)) as { components?: { name?: unknown; version?: unknown; licenses?: { expression?: unknown; license?: { id?: unknown } }[] }[] };
    if (!Array.isArray(bom.components)) return refus("manifeste_invalide");
    // Une licence absente ou inconnue vaut refus (ADR 0012) : la console ne croit pas le poste.
    const paquets: Paquet[] = bom.components.map((c) => {
      const l = c.licenses?.[0];
      const licence = typeof l?.expression === "string" ? l.expression : typeof l?.license?.id === "string" ? l.license.id : undefined;
      return { nom: String(c.name), version: String(c.version), licence };
    });
    if (verifierLicences(paquets).length) return refus("licence_non_permise");
    if (verifierProvenance(paquets).length) return refus("provenance_interdite");
    if (verifierCode(texte(signe.fichiers["module.js"] as Uint8Array), []).length) return refus("contenu_interdit");
    return { ok: true, fichiers: signe.fichiers, empreinte, idCle, signature, manifeste: manifeste.data };
  } catch {
    return refus("manifeste_invalide");
  }
}
