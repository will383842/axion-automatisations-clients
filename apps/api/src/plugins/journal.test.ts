import { describe, expect, it, vi } from "vitest";
import { construireServeur } from "../serveur.js";
import { creerFluxJournal, creerMasqueur } from "./journal.js";

const MARQUEUR = "MARQUEUR-ESSAI-7f3a91c2d4b8";

describe("masquage des secrets dans le journal de l'API", () => {
  it("[A-005] le masqueur cache la valeur brute, en JSON, en adresse et en base64", () => {
    const m = creerMasqueur();
    const valeur = `${MARQUEUR} é/+"x`;
    m.ajouter(valeur);
    const formes = [valeur, JSON.stringify(valeur).slice(1, -1), encodeURIComponent(valeur), Buffer.from(valeur).toString("base64"), Buffer.from(valeur).toString("base64url")];
    for (const f of formes) expect(m.masquer(`avant ${f} après`)).toBe("avant [masqué] après");
  });

  it("[A-005] le masqueur cache un secret à guillemet et à barre oblique recopié dans un message qui contient déjà du JSON (double échappement)", () => {
    const m = creerMasqueur();
    const secret = `${MARQUEUR}"ab\\cd`;
    m.ajouter(secret);
    const message = `réponse du service : ${JSON.stringify({ k: secret })}`;
    const ligne = JSON.stringify({ msg: message });
    expect(ligne).not.toContain(secret);
    const sortie = m.masquer(ligne);
    expect(sortie).toContain("[masqué]");
    expect(sortie).not.toContain(MARQUEUR);
    expect(sortie).not.toContain("ab");
  });

  it("[A-005] le masqueur cache la forme de formulaire (espace → +), dans un message d'erreur (l'adresse journalisée n'a plus de paramètres)", async () => {
    const m = creerMasqueur();
    const secret = `${MARQUEUR} val+x`;
    m.ajouter(secret);
    const formulaire = new URLSearchParams({ q: secret }).toString();
    expect(formulaire).toContain("+val%2Bx");
    expect(m.masquer(formulaire)).toBe("q=[masqué]");
    const lignes: string[] = [];
    const serveur = construireServeur({ journal: creerFluxJournal(m, (l) => lignes.push(l)) });
    serveur.get("/p", async () => {
      throw new Error(`échec ${formulaire}`);
    });
    await serveur.inject({ method: "GET", url: `/p?${formulaire}` });
    await serveur.close();
    const sortie = lignes.join("");
    expect(sortie).toContain("[masqué]");
    expect(sortie).not.toContain(MARQUEUR);
    expect(sortie).not.toContain("val%2Bx");
  });

  it.each(["a", "ab", "abc", "utilisateur:"])("[A-005] le masqueur cache le base64 et le base64url d'une valeur composée (préfixe « %s », secret non aligné sur 3 octets)", (prefixe) => {
    for (const secret of [`${MARQUEUR}-12`, `${MARQUEUR}-123`, `${MARQUEUR}-1234`]) {
      const m = creerMasqueur();
      m.ajouter(secret);
      for (const codage of ["base64", "base64url"] as const) {
        const entete = `Basic ${Buffer.from(`${prefixe}${secret}`).toString(codage)}`;
        const milieu = entete.slice(6 + 4, -4); // sans les caractères de bord, qui dépendent du voisin
        expect(m.masquer(entete)).not.toContain(milieu);
        expect(m.masquer(entete)).toContain("[masqué]");
      }
    }
  });

  it("[A-005] une valeur courte inscrite au masqueur ne falsifie pas le journal (ligne JSON intacte et valide)", () => {
    const m = creerMasqueur();
    for (const courte of ['"', "1", "api"]) m.ajouter(courte);
    const ligne = '{"level":30,"reqId":"3f2b8c1e","tenant":"a1b2","url":"/api/portail/v1/identifiants"}';
    const sortie = m.masquer(ligne);
    expect(sortie).toBe(ligne);
    expect(() => JSON.parse(sortie)).not.toThrow();
  });

  it("[A-005] une valeur longue choisie par un client ne falsifie pas la structure du journal : seules les valeurs de texte sont masquées", () => {
    const m = creerMasqueur();
    for (const piege of ['","tenant":"', '{"level":', "/api/portail/v1/", MARQUEUR]) m.ajouter(piege);
    const lignes: string[] = [];
    const flux = creerFluxJournal(m, (l) => lignes.push(l));
    flux.write(`{"level":30,"reqId":"3f2b8c1e","tenant":"a1b2","url":"/api/portail/v1/identifiants","msg":"échec ${MARQUEUR}"}\n`);
    const sortie = lignes.join("");
    expect(sortie.endsWith("\n")).toBe(true);
    const ligne = JSON.parse(sortie) as Record<string, unknown>;
    expect(ligne.level).toBe(30);
    expect(ligne.reqId).toBe("3f2b8c1e");
    expect(ligne.tenant).toBe("a1b2");
    expect(ligne.msg).toBe("échec [masqué]");
  });

  it("[A-005] les champs de traçabilité (tenant, reqId) ne sont jamais masqués : un client ne peut pas effacer l'identifiant d'un autre", () => {
    const m = creerMasqueur();
    const autre = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
    m.ajouter(autre); // un client range l'identifiant d'un autre comme « secret »
    m.ajouter("req-0001-aaaa");
    const lignes: string[] = [];
    creerFluxJournal(m, (l) => lignes.push(l)).write(`${JSON.stringify({ level: 30, reqId: "req-0001-aaaa", tenant: autre, tenantId: autre, msg: "ok" })}\n`);
    const ligne = JSON.parse(lignes.join("")) as Record<string, unknown>;
    expect(ligne.tenant).toBe(autre);
    expect(ligne.tenantId).toBe(autre);
    expect(ligne.reqId).toBe("req-0001-aaaa");
  });

  it("[A-005] une ligne qui n'est pas du JSON est masquée comme texte brut", () => {
    const m = creerMasqueur();
    m.ajouter(MARQUEUR);
    const lignes: string[] = [];
    creerFluxJournal(m, (l) => lignes.push(l)).write(`texte libre ${MARQUEUR}\n`);
    expect(lignes.join("")).toBe("texte libre [masqué]\n");
  });

  it("[A-005] le masqueur ignore une valeur vide et laisse le reste du texte intact", () => {
    const m = creerMasqueur();
    m.ajouter("");
    expect(m.masquer("rien à cacher")).toBe("rien à cacher");
  });

  it("[A-005] le flux du journal masque la ligne entière avant de l'écrire", () => {
    const m = creerMasqueur();
    m.ajouter(MARQUEUR);
    const lignes: string[] = [];
    creerFluxJournal(m, (l) => lignes.push(l)).write(`{"msg":"x ${MARQUEUR}"}\n`);
    expect(lignes.join("")).not.toContain(MARQUEUR);
    expect(lignes.join("")).toContain("[masqué]");
  });

  it("[A-005] le journal de l'API ne contient jamais la valeur rangée (marqueur unique cherché dans la sortie)", async () => {
    const m = creerMasqueur();
    m.ajouter(MARQUEUR);
    const lignes: string[] = [];
    const serveur = construireServeur({ journal: creerFluxJournal(m, (l) => lignes.push(l)) });
    serveur.get("/piege", async () => {
      throw new Error(`échec avec ${MARQUEUR}`);
    });
    await serveur.inject({ method: "GET", url: `/piege?x=${encodeURIComponent(MARQUEUR)}` });
    await serveur.close();
    const sortie = lignes.join("");
    expect(sortie).toContain("erreur interne"); // le journal marche vraiment
    expect(sortie).not.toContain(MARQUEUR);
  });

  it("[A-005] sans flux fourni, le serveur n'écrit aucun journal (interrupteur fermé)", async () => {
    const ecrit = vi.spyOn(process.stdout, "write");
    const serveur = construireServeur();
    serveur.get("/piege", async () => {
      throw new Error("échec");
    });
    await serveur.inject({ method: "GET", url: "/piege" });
    await serveur.close();
    expect(ecrit).not.toHaveBeenCalled();
    ecrit.mockRestore();
  });
});
