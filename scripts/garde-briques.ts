import { readdirSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { expressionPermise, LIVRE } from "./garde-licences.ts";

// Garde des briques (A-375, A-378, A-379, A-381, A-326, C-493). Lecture des fichiers par de vrais analyseurs (JSON.parse, js-yaml) : aucune expression régulière pour lire un format.

const CLES = ["nom", "image", "version", "empreinte", "licence", "livree", "lieu", "source", "verifie_le"];
const OPTIONNELLES = ["note", "derivee"];
// Image dérivée (ADR 0014, ADR 0016) : publiée par notre CI seulement, attestée par images-derivees.yml sur main.
const DEPOT_DERIVEES = "ghcr.io/will383842/axion-automatisations-clients/";
const COMPTE_GHCR = "ghcr.io/will383842";
const DEPOT_GITHUB = "https://github.com/will383842/axion-automatisations-clients";
const SIGNATAIRE = `${DEPOT_GITHUB}/.github/workflows/images-derivees.yml@refs/heads/main`;
const AMONT_EPINGLE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const NOM_SECRET = /TOKEN|KEY|SECRET|PASSWORD/i;
const TELECHARGE = /\b(?:curl|wget)\b|\|\s*(?:ba|z|da)?sh\b/i;
const LIEUX = new Set(["UE", "hors UE", "local"]);
// Liste fermée (ADR 0012, A-379) : seules briques serveur admises sous une licence hors livre, et seulement non livrées.
const LISTE_FERMEE = new Set(["stockage-objet", "openbao", "litellm"]);
const EMPREINTE = /^sha256:[0-9a-f]{64}$/;

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
  derivee?: { amont: string; dockerfile: string };
}
export interface Options {
  dockerfiles?: Array<{ chemin: string; texte: string }>;
}
interface Fichier {
  fichier: string;
  contenu: unknown;
}
interface Compose {
  nom: string;
  texte: string;
}

// Tout le compte, racine et autres paquets compris : une image poussée à la main ou par une branche n'a pas de provenance.
const estDuCompte = (image: string) => {
  const { depot } = lireImage(image);
  return depot === COMPTE_GHCR || depot.startsWith(`${COMPTE_GHCR}/`);
};

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

// Instructions d'un Dockerfile : retours à la ligne échappés recollés (comme Docker), commentaires et lignes vides ignorés.
function instructions(texte: string): string[] {
  const sortie: string[] = [];
  let cours = "";
  for (const ligne of texte.split(/\r?\n/)) {
    if (cours === "" && (ligne.trim() === "" || ligne.trim().startsWith("#"))) continue;
    if (cours !== "" && ligne.trim().startsWith("#")) continue;
    if (ligne.endsWith("\\")) cours += ligne.slice(0, -1);
    else {
      sortie.push((cours + ligne).trim());
      cours = "";
    }
  }
  if (cours.trim()) sortie.push(cours.trim());
  return sortie;
}

function verifierDockerfile(fichier: string, amont: string, texte: string): string[] {
  const erreurs: string[] = [];
  const echec = (msg: string) => erreurs.push(`${fichier} : derivee : Dockerfile : ${msg}`);
  const liste = instructions(texte);
  const froms = liste.filter((i) => i.split(/\s+/)[0]?.toUpperCase() === "FROM");
  if (froms.length !== 1) echec(`un seul FROM attendu, ${froms.length} trouvé(s)`);
  else if (froms[0]?.split(/\s+/).length !== 2 || froms[0].split(/\s+/)[1] !== amont) echec("le FROM doit être exactement amont, épinglé par empreinte");
  for (const i of liste) {
    const [mot = "", ...reste] = i.split(/\s+/);
    const M = mot.toUpperCase();
    if (M === "ADD" && i.includes("://")) echec("ADD d'une adresse interdit");
    if (M === "COPY" && reste.some((r) => r.toLowerCase().startsWith("--from"))) echec("COPY --from interdit (source non épinglée)");
    if (TELECHARGE.test(i)) echec("téléchargement ou « | sh » interdit");
    if (M === "ARG" || M === "ENV") {
      const noms = M === "ENV" && !reste[0]?.includes("=") ? reste.slice(0, 1) : reste.map((r) => r.split("=")[0] ?? "");
      if (noms.some((n) => NOM_SECRET.test(n))) echec(`${M} avec un nom de secret (TOKEN, KEY, SECRET, PASSWORD) interdit`);
    }
  }
  return erreurs;
}

function verifierDerivee(fichier: string, b: Record<string, unknown>, options: Options): string[] {
  const d = b.derivee;
  const echec = (msg: string) => `${fichier} : derivee : ${msg}`;
  if (!estObjet(d)) return [echec("doit être un objet")];
  const erreurs: string[] = [];
  for (const cle of Object.keys(d)) if (cle !== "amont" && cle !== "dockerfile") erreurs.push(echec(`clé inconnue « ${cle} »`));
  const { amont, dockerfile } = d;
  const image = String(b.image);
  const reste = image.startsWith(DEPOT_DERIVEES) ? image.slice(DEPOT_DERIVEES.length) : "";
  if (!reste || !reste.split("/").every((s) => SEGMENT.test(s))) erreurs.push(echec(`image hors ${DEPOT_DERIVEES}`));
  if (typeof amont !== "string" || !AMONT_EPINGLE.test(amont)) erreurs.push(echec("amont doit être épinglé par @sha256: (64 signes hexadécimaux en minuscules)"));
  else if (amont.endsWith(String(b.empreinte))) erreurs.push(echec("amont a la même empreinte que la brique : image non modifiée"));
  if (typeof dockerfile !== "string" || posix.normalize(dockerfile) !== dockerfile || !dockerfile.startsWith("ops/images/") || basename(dockerfile) !== "Dockerfile") {
    erreurs.push(echec("dockerfile : chemin ops/images/<dossier>/Dockerfile, normalisé"));
    return erreurs;
  }
  const trouve = options.dockerfiles?.find((f) => f.chemin === dockerfile);
  if (!trouve) erreurs.push(echec(`Dockerfile « ${dockerfile} » absent`));
  else if (typeof amont === "string") erreurs.push(...verifierDockerfile(fichier, amont, trouve.texte));
  return erreurs;
}

// Attestation Sigstore lue dans la sortie JSON de « gh attestation verify » : l'empreinte et le workflow signataire sont revérifiés ici.
export function verifierAttestation(sortie: string, image: string, empreinte: string): string[] {
  const echec = (msg: string) => [`${image} : attestation : ${msg}`];
  let doc: unknown;
  try {
    doc = JSON.parse(sortie);
  } catch {
    return echec("illisible");
  }
  if (!Array.isArray(doc) || !doc.length) return echec("absente");
  const signees = doc.filter((a) => {
    const r = estObjet(a) ? a.verificationResult : undefined;
    const cert = estObjet(r) && estObjet(r.signature) ? r.signature.certificate : undefined;
    return estObjet(cert) && cert.buildSignerURI === SIGNATAIRE && cert.sourceRepositoryURI === DEPOT_GITHUB;
  });
  if (!signees.length) return echec(`signataire attendu : ${SIGNATAIRE}`);
  const sujets = (a: unknown) => {
    const st = estObjet(a) && estObjet(a.verificationResult) ? a.verificationResult.statement : undefined;
    return estObjet(st) && Array.isArray(st.subject) ? st.subject : [];
  };
  const memeEmpreinte = (s: unknown) => estObjet(s) && estObjet(s.digest) && `sha256:${String(s.digest.sha256)}` === empreinte;
  const sujetsBons = signees.flatMap(sujets).filter(memeEmpreinte);
  if (!sujetsBons.length) return echec(`empreinte attestée différente de ${empreinte}`);
  const depot = lireImage(image).depot;
  return sujetsBons.some((s) => estObjet(s) && typeof s.name === "string" && lireImage(s.name).depot === depot) ? [] : echec(`nom du sujet attesté différent de ${depot}`);
}

export function listerDerivees(briques: Brique[]): string[] {
  return briques.filter((b) => b.derivee !== undefined).map((b) => `${b.image}@${b.empreinte}`);
}

function verifierBrique(fichier: string, contenu: unknown, options: Options = {}): string[] {
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
  if (image && (image.split("/")[0] ?? "").includes(":")) echec("image : port interdit dans le nom d'hôte du registre (A-381)");
  if (image && ((image.split("/")[0] ?? "").endsWith(".") || image.split("@")[0]?.includes("//"))) echec("image : hôte terminé par un point ou double barre interdits (A-381)");
  if ("derivee" in contenu) erreurs.push(...verifierDerivee(fichier, contenu, options));
  else if (estDuCompte(image)) echec("derivee obligatoire pour toute image du compte GHCR will383842 : l'attestation ne se vérifie que par elle (ADR 0016)");
  return erreurs;
}

function imagesDuCompose(c: Compose): { images: string[]; erreurs: string[] } {
  let doc: unknown;
  try {
    doc = load(c.texte);
  } catch {
    return { images: [], erreurs: [`${c.nom} : compose illisible`] };
  }
  const entrees = estObjet(doc) && estObjet(doc.services) ? Object.entries(doc.services) : [];
  const images = entrees.flatMap(([, s]) => (estObjet(s) && typeof s.image === "string" ? [s.image] : []));
  const erreurs = images.filter((i) => i.includes("$")).map((i) => `${c.nom} : image « ${i} » donnée par une variable, non vérifiable`);
  // Un service construit sur place, ou venu d'un autre fichier, échappe à la garde et à Trivy : il doit citer une image publiée.
  if (estObjet(doc) && "include" in doc) erreurs.push(`${c.nom} : include: refusé, la garde ne lit pas le fichier inclus (A-381)`);
  for (const [nom, s] of entrees) {
    if (!estObjet(s)) continue;
    if ("provider" in s) erreurs.push(`${c.nom} : service « ${nom} » : provider: refusé, il lance un greffon sans image (A-381)`);
    if ("image" in s && typeof s.image !== "string") erreurs.push(`${c.nom} : service « ${nom} » : image doit être un texte`);
    if ("build" in s) erreurs.push(`${c.nom} : service « ${nom} » : build: refusé, une image se tire du registre (A-381)`);
    if (s.pull_policy !== undefined && s.pull_policy !== "always" && s.pull_policy !== "missing") erreurs.push(`${c.nom} : service « ${nom} » : pull_policy « ${String(s.pull_policy)} » refusé (always ou missing)`);
    if (estObjet(s.extends) && "file" in s.extends) erreurs.push(`${c.nom} : service « ${nom} » : extends.file refusé, la garde ne lit pas le fichier cité`);
  }
  for (const [nom, s] of entrees) if (estObjet(s) && "build" in s && !(typeof s.image === "string" && s.image)) erreurs.push(`${c.nom} : service « ${nom} » construit avec build: sans image: publiée (A-381)`);
  return { images: images.filter((i) => !i.includes("$")), erreurs };
}

export function verifierBriques(fichiers: Fichier[], composes: Compose[], options: Options = {}): string[] {
  const erreurs = fichiers.flatMap((f) => verifierBrique(f.fichier, f.contenu, options));
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
      else if (!image.empreinte) erreurs.push(`${c.nom} : image « ${image.depot} » : empreinte @sha256 absente (A-381)`);
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

function lireDockerfiles(briques: Fichier[]): Array<{ chemin: string; texte: string }> {
  return briques.flatMap((b) => {
    const d = estObjet(b.contenu) && estObjet(b.contenu.derivee) ? b.contenu.derivee.dockerfile : undefined;
    if (typeof d !== "string" || posix.normalize(d) !== d || !d.startsWith("ops/images/")) return [];
    try {
      return [{ chemin: d, texte: readFileSync(d, "utf8") }];
    } catch {
      return [];
    }
  });
}

function lireComposes(): Compose[] {
  return [
    ...readdirSync("ops/socle").filter((f) => /^compose.*\.ya?ml$/.test(f)).sort().map((f) => join("ops/socle", f)),
    "ops/compose.test.yml",
  ].map((nom) => ({ nom, texte: readFileSync(nom, "utf8") }));
}

// Usage : node scripts/garde-briques.ts | --lister | --derivees | --attestation <sortie.json> <image@empreinte>
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, rapport, brique] = process.argv.slice(2);
  const briques = lireBriques("ops/briques");
  const options = { dockerfiles: lireDockerfiles(briques) };
  let erreurs: string[];
  if (mode === "--attestation") {
    const [image = "", empreinte = ""] = (brique ?? "").split("@");
    try {
      erreurs = verifierAttestation(readFileSync(rapport ?? "", "utf8"), image, empreinte);
    } catch {
      erreurs = [`${image} : attestation : fichier illisible`];
    }
  } else {
    erreurs = verifierBriques(briques, lireComposes(), options);
    if (mode === "--lister") {
      if (!erreurs.length) for (const i of listerImages(briques.map((b) => b.contenu as Brique))) console.log(i);
    } else if (mode === "--derivees") {
      if (!erreurs.length) for (const i of listerDerivees(briques.map((b) => b.contenu as Brique))) console.log(i);
    } else erreurs.push(...verifierVerrou(readFileSync("pnpm-lock.yaml", "utf8")));
  }
  for (const e of erreurs) console.error(e);
  process.exit(erreurs.length ? 1 : 0);
}
