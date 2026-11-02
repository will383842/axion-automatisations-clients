import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

// Le script de règles (T1B-12, point 3) est essayé avec de FAUX docker, iptables et sudo : on vérifie les règles qu'il écrit, pas le noyau.
// Le vrai effet (le SSH de l'hôte n'est plus joignable depuis « interne ») se prouve dans le job socle-integration (tests/audit-1a/reseau.int.test.ts).
const SCRIPT = fileURLToPath(new URL("./pare-feu-ponts.sh", import.meta.url));
const ID_INTERNE = "0123456789abcdef".repeat(4);
const ID_AUTRE_INTERNE = "fedcba9876543210".repeat(4);
const ID_ENTREE = "a1b2c3d4e5f6a7b8".repeat(4);

const FAUX_DOCKER = `#!/usr/bin/env bash
# faux docker : « network ls » rend les identifiants, « network inspect -f FORMAT ID » rend « interne|identifiant complet|nom de pont »
if [ "$1 $2" = "network ls" ]; then cut -d'|' -f1 "$FAUX_RESEAUX"; exit 0; fi
if [ "$1 $2" = "network inspect" ]; then
  id="\${@: -1}"
  ligne="$(grep "^$id" "$FAUX_RESEAUX" | head -1)"
  [ -n "$ligne" ] || exit 1
  echo "\${ligne#*|}"
  exit 0
fi
exit 1
`;
const FAUX_IPTABLES = (nom: string) => `#!/usr/bin/env bash
# faux ${nom} : garde les règles dans un fichier d'état ; -C teste la présence, -N échoue si la chaîne existe déjà
[ "$1" = "-w" ] && shift && shift
echo "$*" >> "$FAUX_JOURNAL"
[ -n "\${FAUX_PANNE:-}" ] && exit 4
etat="$FAUX_ETAT_${nom.toUpperCase()}"; touch "$etat"
op="$1"; shift
case "$op" in
  -N) grep -qx "chaine $1" "$etat" && exit 1; echo "chaine $1" >> "$etat" ;;
  -F) { grep -v "^regle $1 " "$etat" || true; } > "$etat.n"; mv "$etat.n" "$etat" ;;
  -A) c="$1"; shift; echo "regle $c $*" >> "$etat" ;;
  -I) c="$1"; shift; shift; echo "regle $c $*" >> "$etat" ;;
  -C) c="$1"; shift; grep -qx "regle $c $*" "$etat" ;;
  *) exit 2 ;;
esac
`;

let dossier = "";
function lancer(reseaux: string[], env: Record<string, string> = {}) {
  writeFileSync(join(dossier, "reseaux.txt"), reseaux.join("\n") + "\n");
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { PATH: `${join(dossier, "bin")}:/usr/bin:/bin`, FAUX_RESEAUX: join(dossier, "reseaux.txt"), FAUX_JOURNAL: join(dossier, "journal.txt"), FAUX_ETAT_IPTABLES: join(dossier, "etat4.txt"), FAUX_ETAT_IP6TABLES: join(dossier, "etat6.txt"), ...env },
  });
  return r;
}
const lire = (f: string) => { try { return readFileSync(join(dossier, f), "utf8").split("\n").filter(Boolean); } catch { return []; } };

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "pare-feu-"));
  mkdirSync(join(dossier, "bin"));
  for (const [nom, texte] of [["docker", FAUX_DOCKER], ["iptables", FAUX_IPTABLES("iptables")], ["ip6tables", FAUX_IPTABLES("ip6tables")], ["sudo", '#!/usr/bin/env bash\n[ "$1" = "-n" ] && shift\nexec "$@"\n'], ["id", "#!/usr/bin/env bash\necho 1000\n"]] as const) {
    writeFileSync(join(dossier, "bin", nom), texte);
    chmodSync(join(dossier, "bin", nom), 0o755);
  }
});

describe("pare-feu des ponts du réseau interne", () => {
  it("[C-533] une règle par pont interne : réponses aux connexions établies acceptées, tout le reste refusé, avant les autres règles", () => {
    const r = lancer([`${ID_INTERNE.slice(0, 12)}|true|${ID_INTERNE}|`, `${ID_ENTREE.slice(0, 12)}|false|${ID_ENTREE}|`]);
    expect(r.status, r.stderr).toBe(0);
    const etat = lire("etat4.txt");
    const pont = `br-${ID_INTERNE.slice(0, 12)}`;
    expect(etat).toContain("chaine SOCLE-PONTS");
    expect(etat).toContain("regle INPUT -j SOCLE-PONTS");
    const regles = etat.filter((l) => l.startsWith("regle SOCLE-PONTS "));
    expect(regles).toHaveLength(2);
    expect(regles[0]).toMatch(new RegExp(`-i ${pont} .*ESTABLISHED,RELATED.* -j ACCEPT`));
    expect(regles[1]).toMatch(new RegExp(`-i ${pont} -j REJECT`));
    expect(etat.join("\n")).not.toContain(`br-${ID_ENTREE.slice(0, 12)}`);
  });
  it("[C-533] le nom du pont fixé par l'option Docker est respecté, sinon br-<12 premiers caractères de l'identifiant>", () => {
    const r = lancer([`${ID_AUTRE_INTERNE.slice(0, 12)}|true|${ID_AUTRE_INTERNE}|pont-socle`]);
    expect(r.status, r.stderr).toBe(0);
    const regles = lire("etat4.txt").filter((l) => l.startsWith("regle SOCLE-PONTS "));
    expect(regles.every((l) => l.includes("-i pont-socle "))).toBe(true);
  });
  it("[C-533] idempotent : deux lancements donnent le même état, un seul saut depuis INPUT, et un pont disparu perd ses règles", () => {
    const deux = [`${ID_INTERNE.slice(0, 12)}|true|${ID_INTERNE}|`, `${ID_AUTRE_INTERNE.slice(0, 12)}|true|${ID_AUTRE_INTERNE}|`];
    expect(lancer(deux).status).toBe(0);
    const premier = lire("etat4.txt");
    expect(lancer(deux).status).toBe(0);
    expect(lire("etat4.txt")).toEqual(premier);
    expect(lire("etat4.txt").filter((l) => l === "regle INPUT -j SOCLE-PONTS")).toHaveLength(1);
    expect(lancer([deux[0] as string]).status).toBe(0);
    expect(lire("etat4.txt").join("\n")).not.toContain(`br-${ID_AUTRE_INTERNE.slice(0, 12)}`);
  });
  it("[C-533] sans réseau interne, aucune règle de refus n'est posée et le script réussit", () => {
    const r = lancer([`${ID_ENTREE.slice(0, 12)}|false|${ID_ENTREE}|`]);
    expect(r.status, r.stderr).toBe(0);
    expect(lire("etat4.txt").filter((l) => l.includes("REJECT"))).toEqual([]);
  });
  it("[C-533] échec d'iptables : le script échoue (jamais un socle lancé sans pare-feu)", () => {
    const r = lancer([`${ID_INTERNE.slice(0, 12)}|true|${ID_INTERNE}|`], { FAUX_PANNE: "1" });
    expect(r.status).not.toBe(0);
  });
  it("[C-533] jamais d'adresse écrite en dur : les ponts viennent de « docker network inspect »", () => {
    const texte = readFileSync(SCRIPT, "utf8");
    expect(texte).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(texte).toContain("docker network inspect");
    expect(texte).not.toMatch(/docker0/);
  });
  it("[C-533] lancer.sh lance le pare-feu après le démarrage du socle", () => {
    const lancer_sh = readFileSync(fileURLToPath(new URL("./lancer.sh", import.meta.url)), "utf8");
    expect(lancer_sh).toContain("pare-feu-ponts.sh");
    expect(lancer_sh.indexOf("up -d --wait")).toBeLessThan(lancer_sh.indexOf("pare-feu-ponts.sh"));
  });
});
