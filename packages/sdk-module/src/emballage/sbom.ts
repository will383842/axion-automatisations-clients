import type { Paquet } from "./gardes.ts";

// CycloneDX 1.6 écrit à la main. Ni horodatage ni numéro de série : deux constructions donnent le même octet.
export function sbom(code: string, version: string, paquets: Paquet[]): Record<string, unknown> {
  const tries = [...paquets].sort((a, b) => (a.nom + a.version < b.nom + b.version ? -1 : 1));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: { type: "application", name: code, version } },
    components: tries.map((p) => {
      const purl = `pkg:npm/${p.nom.replace("@", "%40")}@${p.version}`;
      return { type: "library", "bom-ref": purl, name: p.nom, version: p.version, purl, licenses: [{ expression: p.licence }] };
    }),
  };
}
