// Lecture de la configuration du pare-feu (A-066, C-533). Elle ne touche à aucun noyau : elle lit un texte et rend la liste des écarts.
// Forme attendue du fichier nftables : une instruction par ligne, une chaîne par bloc. Tout ce qui n'est pas reconnu en entrée est un écart.
import { lireYaml } from "../../scripts/garde-compose.ts";

const PERMIS_ENTREE = [
  /^ct state established,related accept$/,
  /^ct state invalid drop$/,
  /^iif "lo" accept$/,
  /^tcp dport 443 accept$/,
  // Sans ces trois messages, IPv6 ne fonctionne pas du tout (découverte des voisins) ; aucun port n'est ouvert pour autant.
  /^icmpv6 type \{ nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert \} accept$/,
];

export function analyserPareFeu(texte: string): string[] {
  const ecarts: string[] = [];
  let famille = "";
  let chaine: { hook: string } | null = null;
  let entrees = 0;
  for (const brute of texte.split("\n")) {
    const l = brute.replace(/#.*/, "").trim().replace(/;$/, "").trim();
    if (!l) continue;
    const table = /^table\s+(\S+)\s+\S+\s*\{$/.exec(l);
    if (table) { famille = table[1] ?? ""; chaine = null; continue; }
    if (/^chain\b/.test(l)) {
      if (l.includes("}")) ecarts.push(`chaîne sur une seule ligne non lisible : ${l}`);
      chaine = { hook: "" };
      continue;
    }
    if (l === "}") { if (chaine) chaine = null; continue; }
    if (!chaine) continue;
    const type = /^type\s+\w+\s+hook\s+(\w+)/.exec(l);
    if (type) {
      chaine.hook = type[1] ?? "";
      const politique = /policy\s+(\w+)/.exec(l)?.[1];
      if (chaine.hook === "input") {
        entrees++;
        if (famille !== "inet") ecarts.push(`chaîne d'entrée dans une table « ${famille} » : IPv6 reste ouvert`);
        if (politique !== "drop") ecarts.push("politique d'entrée différente de drop");
      }
      if (chaine.hook === "output" && politique !== "drop") ecarts.push("politique de sortie différente de drop (C-533)");
      continue;
    }
    if (chaine.hook === "input" && !PERMIS_ENTREE.some((r) => r.test(l))) {
      const ferme = /(^|\s)(drop|reject)$/.test(l) && !/accept/.test(l);
      if (!ferme) ecarts.push(`règle d'entrée non permise : ${l}`);
    }
  }
  if (entrees === 0) ecarts.push("aucune chaîne d'entrée trouvée : rien n'est vérifié");
  return ecarts;
}

// Règles de l'hébergeur : entrée = TCP 443 seulement, sortie fermée par défaut.
export function analyserReglesJson(regles: unknown): string[] {
  const ecarts: string[] = [];
  const r = regles as { entrant?: { protocole?: string; port?: string }[]; sortant?: { politique?: string } };
  if (!Array.isArray(r.entrant) || r.entrant.length === 0) ecarts.push("aucune règle entrante");
  for (const e of Array.isArray(r.entrant) ? r.entrant : []) {
    if (e.protocole !== "tcp" || e.port !== "443") ecarts.push(`règle entrante non permise : ${String(e.protocole)} ${String(e.port)}`);
  }
  if (r.sortant?.politique !== "refuser") ecarts.push("sortie non fermée par défaut");
  return ecarts;
}

// Un port publié sans adresse locale passe par les règles de Docker et contourne le pare-feu de l'hôte.
export function portsMalPublies(compose: string): string[] {
  const doc = lireYaml(compose) as unknown as { services?: Record<string, { ports?: unknown }> };
  const mal: string[] = [];
  for (const [nom, s] of Object.entries(doc.services ?? {})) {
    const liste = Array.isArray(s.ports) ? s.ports : [];
    for (const p of liste) {
      const texte = typeof p === "string" ? p : String((p as { host_ip?: string }).host_ip ?? "") ;
      if (!/^(127\.0\.0\.1|\[::1\])/.test(texte)) mal.push(`${nom}: ${typeof p === "string" ? p : "port sans adresse locale"}`);
    }
  }
  return mal;
}
