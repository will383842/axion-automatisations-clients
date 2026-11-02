import { createHash } from "node:crypto";
import type { Connexion } from "../donnees/service.js";
import type { ContexteChamp } from "../donnees/colonnes-chiffrees.js";
import { construireManifeste, empreinteSha256, type FichierManifeste } from "./manifeste.js";
import { ecrireZip, type EntreeZip } from "./zip-flux.js";

// Export complet d'UN client (A-252, B-371, B-374, C-536) : un CSV (RFC 4180, UTF-8) et un JSON Lines par table de `commun`, `a_<code>` et `trace`,
// ses fichiers, le manifeste SHA-256 signé et verifier.txt, dans un ZIP déposé chiffré dans son compartiment sous exports/<demande>.zip.
// Ce qui décide de la base vient du seul `tenantId` fourni par la session de l'appelant ; le port `base` ne connaît que ce client. Une connexion de lecture
// est ouverte pour cet export, jamais prise dans un pool partagé, et refermée quoi qu'il arrive. Une ligne portant un autre tenant_id arrête tout (fail-closed).
// Le ZIP est assemblé en mémoire (jamais sur disque, même chiffré) puis déposé d'un bloc : au-delà de TAILLE_MAX_ZIP, refus net.
export const DUREE_EXPORT_JOURS = 30;
export const TAILLE_MAX_ZIP = 1024 * 1024 * 1024;
const PAGE = 1000;
const NOM_SQL = /^[a-z][a-z0-9_]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PortsExport {
  base(tenantId: string): Promise<{ nomBase: string; etat: string; versionStructure?: number } | undefined>;
  ouvrir(nomBase: string, role: "lecture"): Promise<Connexion>;
  fichiers: { lister(tenantId: string): Promise<string[]>; lire(tenantId: string, cle: string): Promise<Uint8Array | undefined> };
  dechiffrer(tenantId: string, octets: Uint8Array, contexte: ContexteChamp): Promise<string>;
  signature: { signer(octets: Buffer): Promise<string>; clePublique(): Promise<string> };
  deposer(tenantId: string, cle: string, octets: Uint8Array): Promise<void>;
  tracer(evenement: Record<string, unknown>): Promise<void>;
  maintenant(): Date;
}
export interface DemandeExport { tenantId: string; demande: string; acteur: string }
export interface ResultatExport { cle: string; expireLe: Date; octets: number; sha256: string }

const refus = (code: "introuvable" | "isolation_violee" | "nom_invalide" | "export_trop_gros") => new Error(code);
const verifierIds = (tenantId: string, demande: string) => { if (!UUID.test(tenantId) || !UUID.test(demande)) throw new Error("identifiant_invalide"); };
export const idTacheExport = (tenantId: string, demande: string): string => { verifierIds(tenantId, demande); return `export:${tenantId}:${demande}`; };
export const dateExpiration = (depuis: Date): Date => new Date(depuis.getTime() + DUREE_EXPORT_JOURS * 86_400_000);

const nom = (n: unknown): string => { if (typeof n !== "string" || !NOM_SQL.test(n)) throw refus("nom_invalide"); return n; };
const schemaPermis = (s: string) => s === "commun" || s === "trace" || /^a_[a-z0-9_]+$/.test(s);
const champCsv = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const texte = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `\\x${v.toString("hex")}`;
  if (typeof v === "object") return JSON.stringify(v, (_c, x) => (typeof x === "bigint" ? x.toString() : x));
  return String(v);
};
const jsonValeur = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : typeof v === "bigint" ? v.toString() : Buffer.isBuffer(v) ? `\\x${v.toString("hex")}` : v === undefined ? null : v);

export function creerExporteur(p: PortsExport) {
  async function* lignesDeTable(c: Connexion, schema: string, table: string, colonnes: string[], tenantId: string, dechiffrer: (col: string, ligne: Record<string, unknown>) => Promise<string | null>): AsyncGenerator<{ csv: string; json: string }> {
    // Colonnes `*_chiffre` rendues en clair sous le nom sans suffixe ; empreintes de recherche (`*_empreinte`) non exportées : elles ne servent qu'à notre index.
    const sorties = colonnes.filter((x) => !x.endsWith("_empreinte")).map((x) => ({ source: x, sortie: x.endsWith("_chiffre") ? x.slice(0, -8) : x }));
    const liste = colonnes.map((x) => `"${x}"`).join(", ");
    for (let decalage = 0; ; decalage += PAGE) {
      const lignes = await c.requete(`SELECT ${liste} FROM "${schema}"."${table}" ORDER BY 1 LIMIT $1 OFFSET $2`, [PAGE, decalage]);
      for (const l of lignes) {
        if ("tenant_id" in l && l["tenant_id"] !== tenantId) throw refus("isolation_violee");
        const valeurs: [string, unknown][] = [];
        for (const s of sorties) valeurs.push([s.sortie, s.source.endsWith("_chiffre") ? await dechiffrer(s.source, l) : l[s.source]]);
        yield { csv: `${valeurs.map(([, v]) => { const t = texte(v); return t === null ? "" : champCsv(t); }).join(",")}\r\n`, json: `${JSON.stringify(Object.fromEntries(valeurs.map(([k, v]) => [k, jsonValeur(v)])))}\n` };
      }
      if (lignes.length < PAGE) return;
    }
  }

  return {
    async exporter(d: DemandeExport): Promise<ResultatExport> {
      verifierIds(d.tenantId, d.demande);
      const base = await p.base(d.tenantId);
      if (!base || base.etat !== "active") throw refus("introuvable");
      const maintenant = p.maintenant();
      const versionStructure = base.versionStructure ?? 0;
      const c = await p.ouvrir(base.nomBase, "lecture");
      try {
        const tables = (await c.requete("SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND (table_schema IN ('commun', 'trace') OR table_schema LIKE 'a\\_%') ORDER BY 1, 2", []))
          .map((l) => ({ schema: nom(l["table_schema"]), table: nom(l["table_name"]) }));
        if (tables.some((t) => !schemaPermis(t.schema))) throw refus("nom_invalide");
        const fichiers: FichierManifeste[] = [];
        const date = maintenant.toISOString();
        // Le manifeste connaît chaque fichier au fur et à mesure qu'il passe dans le ZIP (taille et empreinte calculées au vol).
        async function* suivi(chemin: string, source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
          const h = createHash("sha256");
          let taille = 0;
          for await (const m of source) { h.update(m); taille += m.length; yield m; }
          fichiers.push({ fichier: chemin, taille, sha256: h.digest("hex"), date });
        }
        async function* entrees(): AsyncGenerator<EntreeZip> {
          for (const { schema, table } of tables) {
            const colonnes = (await c.requete("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", [schema, table])).map((l) => nom(l["column_name"]));
            const dechiffrer = async (col: string, ligne: Record<string, unknown>) => {
              const v = ligne[col];
              if (v === null || v === undefined) return null;
              if (!Buffer.isBuffer(v) || ligne["id"] === undefined) throw new Error("dechiffrement_impossible");
              return p.dechiffrer(d.tenantId, v, { colonne: `${table}.${col}`, idLigne: String(ligne["id"]) });
            };
            const entete = colonnes.filter((x) => !x.endsWith("_empreinte")).map((x) => champCsv(x.endsWith("_chiffre") ? x.slice(0, -8) : x)).join(",");
            const tout = async () => { const o: { csv: string; json: string }[] = []; for await (const l of lignesDeTable(c, schema, table, colonnes, d.tenantId, dechiffrer)) o.push(l); return o; };
            const lignes = await tout();
            yield { nom: `donnees/${schema}/${table}.csv`, contenu: suivi(`donnees/${schema}/${table}.csv`, (async function* () { yield Buffer.from(`${entete}\r\n${lignes.map((l) => l.csv).join("")}`); })()) };
            yield { nom: `donnees/${schema}/${table}.jsonl`, contenu: suivi(`donnees/${schema}/${table}.jsonl`, (async function* () { yield Buffer.from(lignes.map((l) => l.json).join("")); })()) };
          }
          for (const cle of await p.fichiers.lister(d.tenantId)) {
            const octets = await p.fichiers.lire(d.tenantId, cle);
            if (octets === undefined) continue;
            yield { nom: `fichiers/${cle}`, contenu: suivi(`fichiers/${cle}`, (async function* () { yield octets; })()) };
          }
          const manifeste = construireManifeste({ clientId: d.tenantId, demande: d.demande, versionStructure, genereLe: maintenant, fichiers });
          const signature = await p.signature.signer(manifeste);
          const cle = await p.signature.clePublique();
          yield { nom: "manifeste.json", contenu: manifeste };
          yield { nom: "manifeste.sig", contenu: Buffer.from(signature) };
          yield { nom: "verifier.txt", contenu: Buffer.from(modeEmploi(cle, empreinteSha256(manifeste))) };
        }
        const morceaux: Buffer[] = [];
        let total = 0;
        for await (const m of ecrireZip(entrees(), maintenant)) {
          total += m.length;
          if (total > TAILLE_MAX_ZIP) throw refus("export_trop_gros");
          morceaux.push(m);
        }
        const zip = Buffer.concat(morceaux);
        const cle = `exports/${d.demande}.zip`;
        await p.deposer(d.tenantId, cle, zip);
        const expireLe = dateExpiration(maintenant);
        // La trace ne porte aucun contenu du client : qui, quand, jusqu'à quand.
        await p.tracer({ type: "export_cree", tenantId: d.tenantId, demande: d.demande, acteur: d.acteur, expireLe: expireLe.toISOString(), octets: zip.length });
        return { cle, expireLe, octets: zip.length, sha256: empreinteSha256(zip) };
      } finally {
        await c.fermer().catch(() => undefined);
      }
    },
  };
}

const modeEmploi = (cle: string, empreinteManifeste: string) => [
  "Vérifier cet export sans nous.",
  "1. Calculez le SHA-256 de chaque fichier et comparez avec manifeste.json (taille et empreinte).",
  "2. Vérifiez manifeste.sig, signature Ed25519 de manifeste.json (les octets exacts du fichier), avec la clé publique ci-dessous.",
  "   La signature est écrite « vault:v<n>:<base64> » : la partie base64 est la signature brute.",
  "3. La clé publique est aussi publiée dans la documentation d'AXION : comparez les deux. N'utilisez jamais une clé trouvée ailleurs que chez AXION.",
  "Clé publique Ed25519 (32 octets, base64) :",
  cle,
  `SHA-256 de manifeste.json : ${empreinteManifeste}`,
  "",
].join("\n");
