import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { expressionPermise, LIVRE } from "./garde-licences.ts";

// Garde des briques (A-375, A-378, A-379, A-381, A-326, C-493). Lecture des fichiers par de vrais analyseurs (JSON.parse, js-yaml) : aucune expression régulière pour lire un format.

const CLES = ["nom", "image", "version", "empreinte", "licence", "livree", "lieu", "source", "verifie_le"];
const OPTIONNELLES = ["note", "exception_trivy"];
const CLES_EXCEPTION = ["avis", "adr", "decidee_le", "expire_le", "motif"];
const AVIS = /^(?:CVE-\d{4}-\d{4,}|GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})$/;
const DUREE_MAX_JOURS = 30;
const FRAGMENT_ESSAI = /^ops\/socle\/compose\.zz-essai-[^/]*\.ya?ml$/;
const LIEUX = new Set(["UE", "hors UE", "local"]);
// Liste fermée (ADR 0012, A-379) : seules briques serveur admises sous une licence hors livre, et seulement non livrées.
const LISTE_FERMEE = new Set(["stockage-objet", "openbao", "litellm"]);
const EMPREINTE = /^sha256:[0-9a-f]{64}$/;
export const DELAIS_JOURS: Record<string, number> = { CRITICAL: 7, HIGH: 30 };
const JOUR = 86_400_000;

export interface Image {
  depot: string;
  version: string;
  empreinte: string;
}
export interface Brique {
  nom: string;
  image: string;
  version: string;
  empreinte: string;
  licence: string;
  livree: boolean;
  lieu: string;
  source: string;
  verifie_le: string;
  note?: string;
  exception_trivy?: ExceptionTrivy;
}
// Exception nommée, datée, qui expire d'elle-même (ADR 0013) : réservée aux images d'essai.
export interface ExceptionTrivy {
  avis: string[];
  adr: string;
  decidee_le: string;
  expire_le: string;
  motif: string;
}
export interface Options {
  adrs?: string[];
  maintenant?: Date;
}
interface Fichier {
  fichier: string;
  contenu: unknown;
}
interface Compose {
  nom: string;
  texte: string;
}

export function lireImage(ref: string): Image {
  const [nom = "", empreinte = ""] = ref.split("@") as [string, string?];
  const barre = nom.lastIndexOf("/");
  const deuxPoints = nom.indexOf(":", barre + 1);
  const sansVersion = deuxPoints < 0 ? nom : nom.slice(0, deuxPoints);
  const depot = sansVersion
    .toLowerCase()
    .replace(/^(?:index\.docker\.io|registry-1\.docker\.io|docker\.io)\//, "")
    .replace(/^library\//, "");
  return { depot, version: deuxPoints < 0 ? "" : nom.slice(deuxPoints + 1), empreinte };
}

const estRedis = (depot: string) => depot.split("/").some((s) => s === "redis" || /^redis[-_.]/.test(s));
const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function sourceSure(source: string): boolean {
  try {
    const u = new URL(source);
    const hote = u.hostname;
    const ip = /^\d+\.\d+\.\d+\.\d+$/.test(hote) || hote.startsWith("[");
    return u.protocol === "https:" && !u.username && !u.password && !ip && hote !== "localhost" && !/\.(?:local|internal|lan)$/.test(hote);
  } catch {
    return false;
  }
}

function dateReelle(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

function verifierBrique(fichier: string, contenu: unknown): string[] {
  if (!estObjet(contenu)) return [`${fichier} : le contenu doit être un objet`];
  const erreurs: string[] = [];
  const echec = (msg: string) => erreurs.push(`${fichier} : ${msg}`);
  for (const cle of Object.keys(contenu)) if (!CLES.includes(cle) && !OPTIONNELLES.includes(cle)) echec(`clé inconnue « ${cle} »`);
  for (const cle of CLES) if (!(cle in contenu)) echec(`clé « ${cle} » absente`);
  const texte = (cle: string) => {
    const v = contenu[cle];
    if (cle in contenu && (typeof v !== "string" || !v || v !== v.trim())) echec(`« ${cle} » doit être un texte non vide, sans espace autour`);
    return typeof v === "string" ? v : "";
  };
  const [nom, image, version, empreinte, licence, lieu, source, verifie] = ["nom", "image", "version", "empreinte", "licence", "lieu", "source", "verifie_le"].map(texte) as string[];
  if (typeof contenu.note !== "string" && "note" in contenu) echec("« note » doit être un texte");
  if (nom !== basename(fichier, ".json") || !/^[a-z0-9][a-z0-9-]*$/.test(nom ?? "")) echec(`nom « ${nom} » différent du nom du fichier ou mal écrit`);
  const lue = lireImage(image ?? "");
  if (image && (image !== lue.depot || lue.version || lue.empreinte)) echec(`image « ${image} » : le dépôt seul, en minuscules, sans version ni empreinte`);
  if (estRedis(lue.depot) || estRedis(nom ?? "")) echec("redis interdit : Valkey seulement (A-378, C-493)");
  if (version && (version.toLowerCase() === "latest" || /[\s@/]/.test(version))) echec(`version « ${version} » interdite`);
  if (!EMPREINTE.test(empreinte ?? "")) echec("empreinte absente ou mal formée (sha256: et 64 signes hexadécimaux en minuscules)");
  if (typeof contenu.livree !== "boolean") echec("« livree » doit être un booléen");
  const livree = contenu.livree === true;
  if (licence) {
    const permises = livree ? LIVRE : new Set([...LIVRE, "MPL-2.0"]);
    const lisible = expressionPermise(licence, () => true);
    const horsLivre = livree === false && contenu.livree === false && LISTE_FERMEE.has(nom ?? "");
    if (!lisible || (!expressionPermise(licence, (id) => permises.has(id)) && !horsLivre)) echec(`licence « ${licence} » non permise${livree ? " pour une brique livrée" : ""} (A-375, A-379)`);
  }
  if (lieu && !LIEUX.has(lieu)) echec(`lieu « ${lieu} » inconnu (UE, hors UE, local)`);
  if (source && !sourceSure(source)) echec("source : adresse https d'un projet, sans adresse IP ni hôte interne");
  if (verifie && !dateReelle(verifie)) echec(`verifie_le « ${verifie} » n'est pas une date AAAA-MM-JJ réelle`);
  return erreurs;
}

// Une exception n'est valable que pour une image citée par des fragments d'essai et par rien d'autre (statut déduit des composes, jamais déclaré).
function verifierException(fichier: string, b: Record<string, unknown>, composes: Compose[], options: Options): string[] {
  const ex = b.exception_trivy;
  const erreurs: string[] = [];
  const echec = (msg: string) => erreurs.push(`${fichier} : exception_trivy : ${msg}`);
  if (!estObjet(ex)) return [`${fichier} : exception_trivy : doit être un objet`];
  for (const cle of Object.keys(ex)) if (!CLES_EXCEPTION.includes(cle)) echec(`clé inconnue « ${cle} »`);
  const avis = ex.avis;
  if (!Array.isArray(avis) || !avis.length || !avis.every((a) => typeof a === "string" && AVIS.test(a))) echec("« avis » : liste non vide d'identifiants CVE-… ou GHSA-…");
  else if (new Set(avis).size !== avis.length) echec("« avis » : doublon");
  for (const cle of ["motif", "adr"]) if (typeof ex[cle] !== "string" || !ex[cle].trim()) echec(`« ${cle} » doit être un texte non vide`);
  if (typeof ex.adr === "string" && !(options.adrs ?? []).some((a) => /^\d{4}-.+\.md$/.test(a) && a.startsWith(`${ex.adr}-`))) echec(`ADR « ${ex.adr} » absent de docs/adr`);
  const [decidee, expire] = ["decidee_le", "expire_le"].map((c) => (typeof ex[c] === "string" && dateReelle(ex[c]) ? Date.parse(`${ex[c]}T00:00:00Z`) : Number.NaN)) as [number, number];
  if (Number.isNaN(decidee) || Number.isNaN(expire)) echec("« decidee_le » et « expire_le » : dates AAAA-MM-JJ réelles");
  else {
    if (expire <= decidee || (expire - decidee) / JOUR > DUREE_MAX_JOURS) echec(`la durée doit être de 1 à ${DUREE_MAX_JOURS} jours (30 jours au plus)`);
    if (!exceptionValable(ex as unknown as ExceptionTrivy, options.maintenant ?? new Date())) echec("expirée : expire_le est atteint ; renouveler par une nouvelle PR et un nouvel ADR");
  }
  if (b.livree !== false) echec("refusée sur une brique livrée");
  const depot = lireImage(String(b.image)).depot;
  const citent = composes.filter((c) => imagesDuCompose(c).images.some((i) => lireImage(i).depot === depot));
  if (!citent.length) echec("refusée : aucun compose ne cite l'image");
  for (const c of citent) if (!FRAGMENT_ESSAI.test(c.nom)) echec(`refusée : l'image est citée par ${c.nom}, qui n'est pas un fragment d'essai`);
  return erreurs;
}

export function exceptionValable(ex: ExceptionTrivy, maintenant: Date): boolean {
  const aujourdhui = Date.parse(`${maintenant.toISOString().slice(0, 10)}T00:00:00Z`);
  return aujourdhui < Date.parse(`${ex.expire_le}T00:00:00Z`);
}

function imagesDuCompose(c: Compose): { images: string[]; erreurs: string[] } {
  let doc: unknown;
  try {
    doc = load(c.texte);
  } catch {
    return { images: [], erreurs: [`${c.nom} : compose illisible`] };
  }
  const services = estObjet(doc) && estObjet(doc.services) ? Object.values(doc.services) : [];
  const images = services.flatMap((s) => (estObjet(s) && typeof s.image === "string" ? [s.image] : []));
  const erreurs = images.filter((i) => i.includes("$")).map((i) => `${c.nom} : image « ${i} » donnée par une variable, non vérifiable`);
  return { images: images.filter((i) => !i.includes("$")), erreurs };
}

export function verifierBriques(fichiers: Fichier[], composes: Compose[], options: Options = {}): string[] {
  const erreurs = fichiers.flatMap((f) => verifierBrique(f.fichier, f.contenu));
  for (const f of fichiers) if (estObjet(f.contenu) && "exception_trivy" in f.contenu) erreurs.push(...verifierException(f.fichier, f.contenu, composes, options));
  const briques = fichiers.map((f) => f.contenu).filter(estObjet) as unknown as Brique[];
  const parCle = new Map<string, Set<string>>();
  for (const b of briques) {
    const cle = `${lireImage(String(b.image)).depot}:${String(b.version)}`;
    parCle.set(cle, (parCle.get(cle) ?? new Set()).add(String(b.empreinte)));
  }
  for (const [cle, empreintes] of parCle) if (empreintes.size > 1) erreurs.push(`${cle} : deux empreintes différentes dans les fichiers de briques`);
  for (const c of composes) {
    const lu = imagesDuCompose(c);
    erreurs.push(...lu.erreurs);
    for (const ref of lu.images) {
      const image = lireImage(ref);
      if (estRedis(image.depot)) erreurs.push(`${c.nom} : image « ${ref} » : redis interdit, Valkey seulement (A-378, C-493)`);
      const candidates = briques.filter((b) => lireImage(String(b.image)).depot === image.depot && (!image.version || b.version === image.version));
      if (!candidates.length) erreurs.push(`${c.nom} : image « ${image.depot}${image.version ? `:${image.version}` : ""} » : aucune brique inscrite dans ops/briques`);
      else if (image.empreinte && !candidates.some((b) => b.empreinte === image.empreinte)) erreurs.push(`${c.nom} : image « ${image.depot} » : empreinte différente de celle de la brique`);
    }
  }
  return erreurs;
}

// A-326 : ni bullmq-pro ni @taskforcesh/bullmq-pro dans le verrou, sous aucune écriture (clé, version, alias, adresse). Verrou illisible ou vide : échec.
export function verifierVerrou(texte: string): string[] {
  let doc: unknown;
  try {
    doc = load(texte);
  } catch {
    return ["pnpm-lock.yaml illisible"];
  }
  if (!estObjet(doc) || !Object.keys(doc).length) return ["pnpm-lock.yaml vide ou sans structure"];
  const visite = (n: unknown): boolean => {
    if (typeof n === "string") return n.toLowerCase().includes("bullmq-pro");
    if (Array.isArray(n)) return n.some(visite);
    return estObjet(n) && Object.entries(n).some(([k, v]) => visite(k) || visite(v));
  };
  return visite(doc) ? ["bullmq-pro (licence commerciale) présent dans pnpm-lock.yaml (A-326)"] : [];
}

// Même règle que l'audit des dépendances : critique corrigeable sous 7 jours, haute sous 30 jours. Ne sort que « identifiant brique ».
export function evaluerTrivy(rapport: unknown, brique: string, maintenant: Date, exception?: ExceptionTrivy): string[] {
  const exemptes = new Set(exception && exceptionValable(exception, maintenant) ? exception.avis : []);
  if (!estObjet(rapport) || !Array.isArray(rapport.Results)) return [`rapport Trivy invalide pour ${brique}`];
  const sorties = new Set<string>();
  for (const r of rapport.Results) {
    const vulns = estObjet(r) && Array.isArray(r.Vulnerabilities) ? r.Vulnerabilities : [];
    for (const v of vulns) {
      if (!estObjet(v)) continue;
      if (exemptes.has(String(v.VulnerabilityID))) continue;
      const delai = DELAIS_JOURS[String(v.Severity)];
      if (delai === undefined || !v.FixedVersion) continue;
      const publie = Date.parse(String(v.PublishedDate));
      if (Number.isNaN(publie) || (maintenant.getTime() - publie) / JOUR > delai) sorties.add(`${String(v.VulnerabilityID ?? "avis-inconnu")} ${brique}`);
    }
  }
  return [...sorties];
}

export function listerImages(briques: Brique[]): string[] {
  return [...new Set(briques.map((b) => `${b.image}:${b.version}@${b.empreinte}`))];
}

function lireBriques(dossier: string): Fichier[] {
  return readdirSync(dossier)
    .filter((f) => f.endsWith(".json") && f !== "schema.json")
    .sort()
    .map((f) => {
      try {
        return { fichier: join(dossier, f), contenu: JSON.parse(readFileSync(join(dossier, f), "utf8")) as unknown };
      } catch {
        return { fichier: join(dossier, f), contenu: "JSON illisible" };
      }
    });
}

function lireComposes(): Compose[] {
  return [
    ...readdirSync("ops/socle").filter((f) => /^compose.*\.ya?ml$/.test(f)).sort().map((f) => join("ops/socle", f)),
    "ops/compose.test.yml",
  ].map((nom) => ({ nom, texte: readFileSync(nom, "utf8") }));
}

// Usage : node scripts/garde-briques.ts | --lister | --trivy <rapport.json> <brique>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, rapport, brique] = process.argv.slice(2);
  const briques = lireBriques("ops/briques");
  let erreurs: string[];
  if (mode === "--lister") {
    erreurs = verifierBriques(briques, lireComposes(), { adrs: readdirSync("docs/adr"), maintenant: new Date() });
    if (!erreurs.length) for (const i of listerImages(briques.map((b) => b.contenu as Brique))) console.log(i);
  } else if (mode === "--trivy") {
    try {
      // Ne fait pas confiance à l'étape précédente : les composes et l'ADR sont revérifiés avant d'appliquer une exception.
      const maintenant = new Date();
      const trouvee = briques.map((b) => b.contenu).find((c) => estObjet(c) && c.image === brique);
      let exception: ExceptionTrivy | undefined;
      erreurs = [];
      if (estObjet(trouvee) && "exception_trivy" in trouvee) {
        erreurs = verifierException(String(trouvee.nom), trouvee, lireComposes(), { adrs: readdirSync("docs/adr"), maintenant });
        if (!erreurs.length) exception = (trouvee as unknown as Brique).exception_trivy;
      }
      erreurs.push(...evaluerTrivy(JSON.parse(readFileSync(rapport ?? "", "utf8")), brique ?? "brique-inconnue", maintenant, exception));
    } catch {
      erreurs = [`rapport Trivy illisible pour ${brique ?? "brique-inconnue"}`];
    }
  } else {
    erreurs = [...verifierBriques(briques, lireComposes(), { adrs: readdirSync("docs/adr"), maintenant: new Date() }), ...verifierVerrou(readFileSync("pnpm-lock.yaml", "utf8"))];
  }
  for (const e of erreurs) console.error(e);
  process.exit(erreurs.length ? 1 : 0);
}
