// Lecture de la configuration du pare-feu (A-066, C-533). Elle ne touche à aucun noyau : elle lit un texte et rend la liste des écarts.
// Liste blanche stricte : voir plus bas. Tout ce qui n'est pas reconnu est un écart.
import { lireYaml } from "../../scripts/garde-compose.ts";

// LISTE BLANCHE STRICTE : le fichier ne peut contenir QUE les instructions ci-dessous, mot pour mot. Tout le reste est un écart, sans exception
// (instruction de haut niveau, autre table, autre famille, autre chaîne, autre crochet, autre règle, autre accept, d'entrée, de sortie ou de transfert).
// Ce que le lecteur ne comprend pas est refusé : il échoue fermé. La syntaxe permise est volontairement étroite (une instruction par ligne).
const REGLES_ENTREE = [
  "ct state invalid drop",
  "ct state established,related accept",
  'iif "lo" accept',
  // Sans ces trois messages, IPv6 ne fonctionne pas du tout (découverte des voisins) ; aucun port n'est ouvert pour autant.
  "icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert } accept",
  "tcp dport 443 accept",
];
const REGLES_SORTIE = ['oif "lo" accept', "ct state established,related accept", "ip daddr @sorties_permises tcp dport 443 accept"];
// La chaîne de transfert, si elle existe, ne porte aucune règle : tout est refusé (les ponts internes sont gardés par ops/socle/pare-feu-ponts.sh).
const CHAINES: Record<string, { hook: string; regles: string[] }> = {
  entree: { hook: "input", regles: REGLES_ENTREE },
  sortie: { hook: "output", regles: REGLES_SORTIE },
  forward: { hook: "forward", regles: [] },
};
const ENSEMBLE = "sorties_permises";
const LIGNES_ENSEMBLE = ["type ipv4_addr", "flags interval"];

export function analyserPareFeu(texte: string): string[] {
  const ecarts: string[] = [];
  type Contexte = "haut" | "table" | "ensemble" | { chaine: string };
  let ctx: Contexte = "haut";
  let flush = false;
  let tables = 0;
  let ensemble = false;
  const chaines = new Map<string, { typeVu: boolean; ferme: boolean }>();
  let ouverteEntree = false; // règle TCP 443 présente
  let courante: { typeVu: boolean } | null = null;
  const refuser = (n: number, l: string, quoi = "instruction non permise") => ecarts.push(`${quoi} (ligne ${n}) : ${l}`);

  texte.split("\n").forEach((brute, i) => {
    const n = i + 1;
    const l = brute.replace(/#.*/, "").replace(/\s+/g, " ").trim();
    if (!l) return;
    if (ctx === "haut") {
      if (l === "flush ruleset" && !flush && tables === 0) flush = true;
      else if (l === "table inet axion {" && tables === 0) { tables++; ctx = "table"; }
      else refuser(n, l);
      return;
    }
    if (ctx === "table") {
      let m: RegExpExecArray | null;
      if (l === "}") ctx = "haut";
      else if (l === `set ${ENSEMBLE} {` && !ensemble) { ensemble = true; ctx = "ensemble"; }
      else if ((m = /^chain (\w+) \{$/.exec(l)) && m[1] && m[1] in CHAINES && !chaines.has(m[1])) {
        courante = { typeVu: false };
        chaines.set(m[1], { typeVu: false, ferme: false });
        ctx = { chaine: m[1] };
      } else if (/^chain\b/.test(l)) refuser(n, l, "chaîne non permise");
      else refuser(n, l);
      return;
    }
    if (ctx === "ensemble") {
      if (l === "}") ctx = "table";
      else if (!LIGNES_ENSEMBLE.includes(l)) refuser(n, l, "ligne non permise dans l'ensemble");
      return;
    }
    // Dans une chaîne.
    const nom = ctx.chaine;
    const def = CHAINES[nom]!;
    const type = `type filter hook ${def.hook} priority 0; policy drop;`;
    if (l === "}") {
      if (!courante?.typeVu) ecarts.push(`chaîne « ${nom} » sans la ligne « ${type} » (ligne ${n})`);
      chaines.get(nom)!.ferme = true;
      ctx = "table";
    } else if (l === type || l === type.replace(/;$/, "")) {
      if (courante?.typeVu) refuser(n, l, "ligne type en double");
      else if (courante) courante.typeVu = true;
    } else if (!courante?.typeVu) refuser(n, l, `règle avant la ligne type de la chaîne « ${nom} »`);
    else if (def.regles.includes(l)) { if (nom === "entree" && l === "tcp dport 443 accept") ouverteEntree = true; }
    else refuser(n, l, `règle non permise dans la chaîne « ${nom} »${nom === "sortie" ? " (la sortie est fermée par défaut, C-533)" : ""}`);
  });

  if (ctx !== "haut") ecarts.push("accolade non fermée en fin de fichier");
  if (!chaines.has("entree")) ecarts.push("aucune chaîne d'entrée trouvée : rien n'est vérifié");
  else if (!ouverteEntree) ecarts.push("la règle « tcp dport 443 accept » manque en entrée : rien ne serait servi");
  if (!chaines.has("sortie")) ecarts.push("aucune chaîne de sortie fermée par défaut (C-533)");
  return ecarts;
}

// Règles de l'hébergeur : entrée = TCP 443 seulement, sortie fermée par défaut.
export function analyserReglesJson(regles: unknown): string[] {
  const ecarts: string[] = [];
  if (typeof regles !== "object" || regles === null || Array.isArray(regles)) return ["fichier de règles de l'hébergeur illisible : un objet est attendu"];
  const r = regles as Record<string, unknown>;
  for (const cle of Object.keys(r)) if (!["commentaire", "entrant", "sortant", "reseau_prive"].includes(cle)) ecarts.push(`clé non permise : ${cle}`);
  const entrant = Array.isArray(r.entrant) ? (r.entrant as unknown[]) : [];
  if (entrant.length === 0) ecarts.push("aucune règle entrante");
  for (const e of entrant) {
    const o = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
    if (o.protocole !== "tcp" || o.port !== "443") ecarts.push(`règle entrante non permise : ${String(o.protocole)} ${String(o.port)}`);
    if (o.source !== "tout") ecarts.push("règle entrante : la source doit être « tout » (aucune adresse écrite dans le dépôt)");
    for (const cle of Object.keys(o)) if (!["protocole", "port", "source"].includes(cle)) ecarts.push(`règle entrante : clé non permise : ${cle}`);
  }
  if ((r.sortant as { politique?: unknown } | undefined)?.politique !== "refuser") ecarts.push("sortie non fermée par défaut");
  return ecarts;
}

// Un port publié sans adresse locale passe par les règles de Docker et contourne le pare-feu de l'hôte.
export function portsMalPublies(compose: string): string[] {
  const doc = lireYaml(compose) as unknown as { services?: Record<string, { ports?: unknown; network_mode?: unknown }> };
  const mal: string[] = [];
  for (const [nom, s] of Object.entries(doc.services ?? {})) {
    if (s.network_mode === "host") mal.push(`${nom}: network_mode host (contourne le pare-feu)`);
    const liste = Array.isArray(s.ports) ? s.ports : [];
    for (const p of liste) {
      if (typeof p === "string") {
        if (!/^(127\.0\.0\.1|\[::1\]):/.test(p)) mal.push(`${nom}: ${p}`);
      } else if (typeof p === "object" && p !== null && ["127.0.0.1", "::1"].includes(String((p as { host_ip?: unknown }).host_ip ?? ""))) continue;
      else mal.push(`${nom}: port sans adresse locale`);
    }
  }
  return mal;
}
