import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ClePublique } from "../../../../packages/sdk-module/src/emballage/cles-publiques.ts";
import { ErreurApi } from "../plugins/erreurs.js";
import { ErreurRangement, type creerRangement } from "./ranger.js";
import { CodeAutomatisation } from "./schema.js";
import { verifierArtefactImporte } from "./verifier-artefact.js";

// Import d'une version (T4-25). Toute version importée naît « brouillon » : aucun paramètre de la requête ne choisit l'état (A-024, A-305).
// Une version rangée ne change plus jamais (A-407) : même version et même empreinte = réponse identique ; sinon 409. Aucune mise à jour ni suppression n'existe ici.
export interface VersionRangee { semver: string; empreinte: string; statut: "brouillon"; ref: string; automatisation?: string }
export interface EntreeVersion {
  codeAutomatisation: string;
  nomAutomatisation: string;
  semver: string;
  apiMoteur: string;
  empreinte: string;
  ref: string;
  signature: string;
  schemaConfiguration: unknown;
  // Lu par la vue des outils (C-671) ; l'identifiant de la clé de signature y est gardé, la table n'ayant pas de colonne pour lui.
  manifeste: { connecteurs: { famille: string }[]; idCle: string };
}
// `enregistrer` est atomique : il crée l'automatisation si elle est nouvelle, puis la version, ou rend la version déjà en place (même semver OU même empreinte).
export interface DepotCatalogue {
  enregistrer(e: EntreeVersion): Promise<{ cree: boolean; version: VersionRangee }>;
}
export type Rangement = ReturnType<typeof creerRangement>;
// Signal de proximité de T3-40 (B-534) : codes d'automatisations proches. Il informe, il ne bloque jamais.
export type Doublons = (nom: string) => Promise<string[]>;

const sansDonnees = ({ semver, empreinte, statut, ref }: VersionRangee) => ({ semver, empreinte, statut, ref });
const DELAI_DOUBLONS_MS = 2000;

export function creerImporteur(o: { cles: readonly ClePublique[]; rangement: Rangement; depot: DepotCatalogue; doublons?: Doublons }) {
  return {
    async importer(archive: Uint8Array, codeAutomatisation: string): Promise<{ cree: boolean; version: ReturnType<typeof sansDonnees>; signal_doublon: string[] }> {
      if (!CodeAutomatisation.safeParse(codeAutomatisation).success) throw new ErreurApi("schema_invalide", "Requête invalide.");
      const v = verifierArtefactImporte(archive, o.cles);
      if (!v.ok) throw v.code === "archive_invalide" ? new ErreurApi("schema_invalide", "Archive invalide.") : new ErreurApi("regle_metier", `Artefact refusé : ${v.code}.`);
      let ref: string;
      try {
        ref = await o.rangement.ranger(v.empreinte, v.fichiers);
      } catch (e) {
        if (e instanceof ErreurRangement && e.code === "empreinte_occupee") throw new ErreurApi("identifiant_deja_pris", "Cette version existe déjà avec un autre contenu.");
        throw e;
      }
      let signal: string[] = [];
      if (o.doublons) {
        const attente = new Promise<string[]>((r) => setTimeout(() => r([]), DELAI_DOUBLONS_MS).unref());
        signal = await Promise.race([o.doublons(v.manifeste.code), attente]).catch(() => []);
        signal = signal.filter((c) => c !== codeAutomatisation);
      }
      const m = v.manifeste;
      const r = await o.depot.enregistrer({
        codeAutomatisation,
        nomAutomatisation: m.code,
        semver: m.version,
        apiMoteur: m.apiMoteur,
        empreinte: v.empreinte,
        ref,
        signature: v.signature,
        schemaConfiguration: m.schemaReglages,
        manifeste: { connecteurs: m.connecteurs.map((c) => ({ famille: c.famille })), idCle: v.idCle },
      });
      const identique = r.version.empreinte === v.empreinte && r.version.semver === m.version && (r.version.automatisation ?? codeAutomatisation) === codeAutomatisation;
      if (!r.cree && !identique) throw new ErreurApi("identifiant_deja_pris", "Cette version existe déjà avec un autre contenu.");
      return { cree: r.cree, version: sansDonnees(r.version), signal_doublon: signal };
    },
  };
}
export type Importeur = ReturnType<typeof creerImporteur>;

// Poste de la recette (axion-dev publier --recette) : HMAC-SHA256 de « horodatage \n empreinte SHA-256 du corps », valable 5 minutes. Le corps change = signature fausse.
export function verifierRecette(o: { cle: Uint8Array; maintenant: () => number }, entetes: Record<string, string | string[] | undefined>, corps: Uint8Array): boolean {
  const t = entetes["x-axion-horodatage"];
  const s = entetes["x-axion-signature"];
  if (typeof t !== "string" || typeof s !== "string" || !/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/.test(s)) return false;
  if (Math.abs(o.maintenant() - Number(t)) > 300) return false;
  const attendu = createHmac("sha256", o.cle).update(`${t}\n${createHash("sha256").update(corps).digest("hex")}`).digest();
  return timingSafeEqual(attendu, Buffer.from(s, "hex"));
}

type Requete = (sql: string, valeurs: unknown[]) => Promise<Record<string, unknown>[]>;
// Dépôt PostgreSQL : écrit seulement dans les tables de T2-03, avec le rôle d'équipe (règle C5) ; `transaction` fournit une requête liée à une transaction.
export function depotSql(transaction: <T>(fn: (q: Requete) => Promise<T>) => Promise<T>): DepotCatalogue {
  const lire = (l: Record<string, unknown>): VersionRangee => ({ semver: String(l["semver"]), empreinte: String(l["empreinte"]), statut: "brouillon", ref: String(l["ref"]), automatisation: String(l["code"]) });
  return {
    enregistrer: (e) =>
      transaction(async (q) => {
        await q("INSERT INTO automatisations (code, nom, statut) VALUES ($1, $2, 'en_construction') ON CONFLICT (code) DO NOTHING", [e.codeAutomatisation, e.nomAutomatisation]);
        const id = (await q("SELECT id FROM automatisations WHERE code = $1", [e.codeAutomatisation]))[0]?.["id"];
        const colonnes = "v.semver, v.empreinte_sha256 AS empreinte, v.artefact_ref AS ref, a.code";
        const neuf = await q(
          `WITH v AS (INSERT INTO versions_automatisation (automatisation_id, semver, api_moteur, artefact_ref, empreinte_sha256, signature_ed25519, sbom_ref, nature, schema_configuration, manifeste, statut)
             SELECT $1, $2, $3, $4, $5, $6, $7, (CASE WHEN EXISTS (SELECT 1 FROM versions_automatisation WHERE automatisation_id = $1) THEN 'evolution' ELSE 'creation' END)::nature_version, $8::jsonb, $9::jsonb, 'brouillon'
             ON CONFLICT DO NOTHING RETURNING *) SELECT ${colonnes} FROM v JOIN automatisations a ON a.id = v.automatisation_id`,
          [id, e.semver, e.apiMoteur, e.ref, e.empreinte, e.signature, `${e.ref}sbom.cdx.json`, JSON.stringify(e.schemaConfiguration), JSON.stringify(e.manifeste)],
        );
        if (neuf[0]) return { cree: true, version: lire(neuf[0]) };
        const present = await q(`SELECT ${colonnes} FROM versions_automatisation v JOIN automatisations a ON a.id = v.automatisation_id WHERE (v.automatisation_id = $1 AND v.semver = $2) OR v.empreinte_sha256 = $3 LIMIT 1`, [id, e.semver, e.empreinte]);
        if (!present[0]) throw new Error("conflit introuvable");
        return { cree: false, version: lire(present[0]) };
      }),
  };
}
