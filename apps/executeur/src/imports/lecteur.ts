// Lecture en flux d'un fichier CSV (A-271, A-273) : jamais le fichier entier en mémoire, jamais de formule interprétée.
export const MAX_OCTETS = 200 * 1024 * 1024;
export type CodeImport = "trop_gros" | "fichier_illisible" | "colonne_adresse_absente";
const MESSAGES: Record<CodeImport, string> = { trop_gros: "Fichier trop gros : 200 Mo au plus.", fichier_illisible: "Fichier illisible.", colonne_adresse_absente: "Aucune colonne d'adresse e-mail reconnue (Email, E-mail ou Courriel)." };
export class ErreurImport extends Error {
  constructor(readonly code: CodeImport) { super(MESSAGES[code]); this.name = "ErreurImport"; }
}

// Coupe dès que le total dépasse le maximum : le reste du fichier n'est pas lu.
export async function* limiterOctets(source: AsyncIterable<Uint8Array>, max = MAX_OCTETS): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const morceau of source) {
    total += morceau.byteLength;
    if (total > max) throw new ErreurImport("trop_gros");
    yield morceau;
  }
}

export type Ligne = Record<string, string>;

// Une cellule qui commence par = + - @ est du texte ; à l'export elle est préfixée pour qu'un tableur ne l'exécute pas.
export const neutraliserPourExport = (v: string): string => (/^[=+\-@]/.test(v) ? `'${v}` : v);

// CSV à virgule ou à point-virgule (le premier séparateur de la ligne d'en-têtes décide), guillemets doublés, première ligne = en-têtes. L'état tient dans la ligne courante seulement.
export async function* lireLignes(source: AsyncIterable<Uint8Array | string>): AsyncGenerator<Ligne> {
  const decodeur = new TextDecoder();
  let entetes: string[] | undefined;
  let champ = "";
  let cellules: string[] = [];
  let guillemets = false;
  let apresGuillemet = false;
  let sep: string | undefined;
  const finLigne = function* (): Generator<Ligne> {
    cellules.push(champ);
    champ = "";
    const c = cellules;
    cellules = [];
    if (c.length === 1 && c[0] === "") return;
    if (!entetes) { entetes = c.map((e) => e.trim().replace(/^\u{FEFF}/u, "")); return; }
    yield Object.fromEntries(entetes.map((e, i) => [e, c[i] ?? ""]));
  };
  for await (const brut of source) {
    const texte = typeof brut === "string" ? brut : decodeur.decode(brut, { stream: true });
    for (const car of texte) {
      if (guillemets) {
        if (car === '"') { guillemets = false; apresGuillemet = true; } else champ += car;
      } else if (car === '"' && (champ === "" || apresGuillemet)) {
        guillemets = true;
        if (apresGuillemet) champ += '"';
        apresGuillemet = false;
      } else if ((car === "," || car === ";") && (sep ??= car) === car) { cellules.push(champ); champ = ""; apresGuillemet = false; }
      else if (car === "\n") { apresGuillemet = false; yield* finLigne(); }
      else if (car !== "\r") { champ += car; apresGuillemet = false; }
    }
  }
  if (guillemets) throw new ErreurImport("fichier_illisible");
  if (champ !== "" || cellules.length > 0) yield* finLigne();
}
