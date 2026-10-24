import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Garde du compose du socle (A-066, A-084, A-086). Lecture d'un sous-ensemble de YAML : aucune dépendance, aucun code exécuté.
// Lancée sur chaque fichier ET sur la sortie assemblée de « docker compose config ».

const PROXY = "traefik";
const INTERNES = ["postgres", "pgbouncer", "valkey", "openbao", "litellm", "stockage", "keycloak-admin"];
const EMPREINTE = /@sha256:[0-9a-f]{64}$/;
const REGLE_HOTE = /Host(?:SNI|Regexp)?\(/;
const EXTENSIONS_FICHIER = new Set(["yml", "yaml", "json", "ts", "crt", "key", "pem", "sock", "toml", "conf", "env", "txt"]);

type Noeud = string | Noeud[] | { [cle: string]: Noeud };
type Objet = { [cle: string]: Noeud };
interface Ligne {
  indent: number;
  texte: string;
}

const estObjet = (n: Noeud | undefined): n is Objet => typeof n === "object" && n !== null && !Array.isArray(n);

function sansCommentaire(l: string): string {
  let guillemet = "";
  for (let i = 0; i < l.length; i++) {
    const c = l[i] ?? "";
    if (guillemet) {
      if (c === guillemet) guillemet = "";
    } else if (c === '"' || c === "'") guillemet = c;
    else if (c === "#" && (i === 0 || /\s/.test(l[i - 1] ?? ""))) return l.slice(0, i);
  }
  return l;
}

function decouperCle(texte: string): [string, string] | undefined {
  let guillemet = "";
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i] ?? "";
    if (guillemet) {
      if (c === guillemet) guillemet = "";
    } else if (c === '"' || c === "'") guillemet = c;
    else if (c === ":" && (i === texte.length - 1 || texte[i + 1] === " ")) return [retirerGuillemets(texte.slice(0, i).trim()), texte.slice(i + 1).trim()];
  }
  return undefined;
}

function retirerGuillemets(s: string): string {
  return /^(["']).*\1$/.test(s) && s.length >= 2 ? s.slice(1, -1) : s;
}

function scalaire(s: string): Noeud {
  if (s === "{}") return {};
  if (s === "[]") return [];
  if (s.startsWith("[") && s.endsWith("]")) {
    return s
      .slice(1, -1)
      .split(",")
      .map((x) => retirerGuillemets(x.trim()))
      .filter(Boolean);
  }
  if (s.startsWith("{") || s.startsWith("[")) throw new Error(`YAML non pris en charge par la garde : ${s}`);
  return retirerGuillemets(s);
}

const estElement = (l: Ligne) => l.texte === "-" || l.texte.startsWith("- ");

function bloc(ls: Ligne[], debut: number, indent: number): [Noeud, number] {
  let pos = debut;
  if (estElement(ls[pos] as Ligne)) {
    const liste: Noeud[] = [];
    while (pos < ls.length && (ls[pos] as Ligne).indent === indent && estElement(ls[pos] as Ligne)) {
      const l = ls[pos] as Ligne;
      const contenu = l.texte.slice(1).trimStart();
      const decalage = l.texte.length - contenu.length;
      if (!contenu) {
        pos++;
        if (pos < ls.length && (ls[pos] as Ligne).indent > indent) {
          const [v, p] = bloc(ls, pos, (ls[pos] as Ligne).indent);
          liste.push(v);
          pos = p;
        } else liste.push("");
      } else if (decouperCle(contenu) && !contenu.startsWith("[") && !contenu.startsWith("{") && !/^["'].*["']$/.test(contenu)) {
        ls[pos] = { indent: indent + decalage, texte: contenu };
        const [v, p] = bloc(ls, pos, indent + decalage);
        liste.push(v);
        pos = p;
      } else {
        liste.push(scalaire(contenu));
        pos++;
      }
    }
    return [liste, pos];
  }
  const objet: Objet = {};
  while (pos < ls.length && (ls[pos] as Ligne).indent === indent && !estElement(ls[pos] as Ligne)) {
    const l = ls[pos] as Ligne;
    const kv = decouperCle(l.texte);
    if (!kv) throw new Error(`YAML illisible : « ${l.texte} »`);
    const [cle, valeur] = kv;
    pos++;
    if (/^[>|][+-]?$/.test(valeur)) {
      const morceaux: string[] = [];
      while (pos < ls.length && (ls[pos] as Ligne).indent > indent) morceaux.push((ls[pos++] as Ligne).texte);
      objet[cle] = morceaux.join(" ");
    } else if (valeur) objet[cle] = scalaire(valeur);
    else if (pos < ls.length && ((ls[pos] as Ligne).indent > indent || ((ls[pos] as Ligne).indent === indent && estElement(ls[pos] as Ligne)))) {
      const [v, p] = bloc(ls, pos, (ls[pos] as Ligne).indent);
      objet[cle] = v;
      pos = p;
    } else objet[cle] = "";
  }
  return [objet, pos];
}

export function lireYaml(texte: string): Noeud {
  const ls: Ligne[] = texte
    .split("\n")
    .map((l) => sansCommentaire(l.replace(/\r$/, "")).trimEnd())
    .filter((l) => l.trim() && l.trim() !== "---")
    .map((l) => ({ indent: l.length - l.trimStart().length, texte: l.trim() }));
  if (!ls.length) return {};
  const [v, fin] = bloc(ls, 0, (ls[0] as Ligne).indent);
  if (fin < ls.length) throw new Error(`YAML illisible : « ${(ls[fin] as Ligne).texte} »`);
  return v;
}

const chaine = (n: Noeud | undefined) => (typeof n === "string" ? n : "");
const liste = (n: Noeud | undefined): Noeud[] => (Array.isArray(n) ? n : []);

function reseauxDuService(service: Objet): string[] {
  const r = service.networks;
  return Array.isArray(r) ? r.map(chaine) : estObjet(r) ? Object.keys(r) : [];
}

// Port du proxy accepté : seulement 127.0.0.1 → 8443 (forme courte « ip:publié:cible » ou forme longue de « docker compose config »).
function portProxyConforme(p: Noeud): boolean {
  if (estObjet(p)) return chaine(p.host_ip) === "127.0.0.1" && chaine(p.published) === "8443" && chaine(p.target) === "8443";
  return /^127\.0\.0\.1:8443:8443(?:\/tcp)?$/.test(chaine(p));
}

function etiquettes(service: Objet): [string, string][] {
  const l = service.labels;
  if (Array.isArray(l)) {
    return l.map((e) => {
      const i = chaine(e).indexOf("=");
      return i < 0 ? [chaine(e), ""] : [chaine(e).slice(0, i), chaine(e).slice(i + 1)];
    });
  }
  return estObjet(l) ? Object.entries(l).map(([k, v]) => [k, chaine(v)]) : [];
}

function montageSocket(service: Objet): boolean {
  return liste(service.volumes).some((v) => (estObjet(v) ? `${chaine(v.source)} ${chaine(v.target)}` : chaine(v)).includes("docker.sock"));
}

// Valeurs seules : on retire les clés (et les clés d'étiquettes) pour ne pas prendre « traefik.http.routers.x.rule » pour un domaine.
function valeursDuTexte(texte: string): string[] {
  const sorties: string[] = [];
  for (const brute of texte.split("\n")) {
    let l = sansCommentaire(brute).trim().replace(/^-\s+/, "");
    if (!l) continue;
    const kv = decouperCle(l);
    if (kv) {
      if (kv[0] === "image" || kv[0] === "name") continue;
      l = kv[1];
    } else {
      const egal = /^[\w.-]+=/.exec(l);
      if (egal) l = l.slice(egal[0].length);
    }
    if (/^[\w./-]+@sha256:|^[\w./-]+:[\w.-]+@sha256:/.test(l)) continue;
    sorties.push(l);
  }
  return sorties;
}

function domainesReels(texte: string): string[] {
  const trouves = new Set<string>();
  for (const v of valeursDuTexte(texte)) {
    for (const m of v.matchAll(/(?<![\w-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,}))(?![\w-])/gi)) {
      const [, nom = "", fin = ""] = m;
      const dernier = fin.toLowerCase();
      if (dernier !== "test" && !EXTENSIONS_FICHIER.has(dernier)) trouves.add(nom);
    }
  }
  return [...trouves];
}

function verifierServices(nom: string, services: Objet): string[] {
  const erreurs: string[] = [];
  for (const [id, valeur] of Object.entries(services)) {
    if (!estObjet(valeur)) continue;
    const interne = INTERNES.includes(id);
    const echec = (msg: string) => erreurs.push(`${nom}: service ${id} : ${msg}`);
    if (id !== PROXY && liste(valeur.ports).length > 0) echec("ports: publiés, seul le proxy peut en publier");
    if (id === PROXY && liste(valeur.ports).length > 0) {
      const ports = liste(valeur.ports);
      if (ports.length !== 1 || !portProxyConforme(ports[0] as Noeud)) echec("ports: le proxy publie seulement 127.0.0.1:8443");
    }
    const image = chaine(valeur.image);
    if (image) {
      if (!EMPREINTE.test(image)) echec(`image sans empreinte @sha256: (${image})`);
      if (/:latest(?:@|$)/.test(image)) echec(`image « latest » interdite (${image})`);
    }
    if (valeur.privileged === "true") echec("privileged: true interdit");
    if (valeur.network_mode === "host") echec("network_mode: host interdit");
    if (montageSocket(valeur)) echec("montage du socket Docker interdit");
    if (liste(valeur.cap_add).length > 0) echec("cap_add interdit");
    if (valeur.pid === "host") echec("pid: host interdit");
    if (valeur.ipc === "host") echec("ipc: host interdit");
    if (valeur.userns_mode === "host") echec("userns_mode: host interdit");
    if (liste(valeur.devices).length > 0) echec("devices interdit");
    if (interne && reseauxDuService(valeur).includes("entree")) echec("service interne sur le réseau entree");
    // Sans « networks: », Compose place le service sur « default », qui a une sortie.
    const reseaux = reseauxDuService(valeur);
    if (interne && (reseaux.length === 0 || reseaux.some((r) => r !== "interne"))) echec("réseau : un service interne est seulement sur le réseau interne");
    if (interne) {
      for (const [cle, v] of etiquettes(valeur)) {
        if (cle.startsWith("traefik.") && REGLE_HOTE.test(v)) echec(`nom d'hôte donné à un service interne (${cle})`);
      }
    }
  }
  return erreurs;
}

// Configuration dynamique du proxy : aucune route ne mène à un service interne.
function verifierRoutes(nom: string, http: Objet): string[] {
  const erreurs: string[] = [];
  const echec = (cible: string) => erreurs.push(`${nom}: service ${cible} : nom d'hôte donné à un service interne`);
  if (estObjet(http.services)) {
    for (const s of Object.values(http.services)) {
      const serveurs = estObjet(s) && estObjet(s.loadBalancer) ? liste(s.loadBalancer.servers) : [];
      for (const srv of serveurs) {
        const hote = /^[a-z]+:\/\/([^/:]+)/i.exec(estObjet(srv) ? chaine(srv.url) : "")?.[1] ?? "";
        if (INTERNES.includes(hote)) echec(hote);
      }
    }
  }
  if (estObjet(http.routers)) {
    for (const r of Object.values(http.routers)) if (estObjet(r) && INTERNES.includes(chaine(r.service))) echec(chaine(r.service));
  }
  return erreurs;
}

export function verifierCompose(nom: string, texte: string): string[] {
  let doc: Noeud;
  try {
    doc = lireYaml(texte);
  } catch (e) {
    return [`${nom}: ${(e as Error).message}`];
  }
  const erreurs: string[] = [];
  if (estObjet(doc)) {
    if (estObjet(doc.services)) erreurs.push(...verifierServices(nom, doc.services));
    if (estObjet(doc.http)) erreurs.push(...verifierRoutes(nom, doc.http));
    const interne = estObjet(doc.networks) ? doc.networks.interne : undefined;
    if (estObjet(interne) && interne.internal !== "true") erreurs.push(`${nom}: le réseau interne doit déclarer internal: true`);
  }
  for (const d of domainesReels(texte)) erreurs.push(`${nom}: nom de domaine réel ou hors .test : ${d}`);
  return erreurs;
}

// Usage : node scripts/garde-compose.ts <fichier>...
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fichiers = process.argv.slice(2);
  if (!fichiers.length) {
    console.error("usage : node scripts/garde-compose.ts <fichier>...");
    process.exit(2);
  }
  const erreurs = fichiers.flatMap((f) => verifierCompose(f, readFileSync(f, "utf8")));
  for (const e of erreurs) console.error(e);
  process.exit(erreurs.length ? 1 : 0);
}
