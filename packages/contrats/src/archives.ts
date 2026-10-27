import { PREFIXE_C1, ROUTES_C1, type RouteC1 } from "./c1/routes.ts";
import { Fait } from "./c2/faits.ts";
import { EvenementConsole } from "./c3/evenements-console-vers-crm.ts";
import { EvenementCrm } from "./c3/evenements-crm-vers-console.ts";
import { LectureReponse, LectureRequete } from "./c3/lecture-entreprise.ts";
import { DUREE_SECONDES, PREFIXE_KID, ROUTE_C6, VERSION_JETON } from "./c6/jeton.ts";
import { verifierJeton } from "./c6/verifier.ts";
import { ErreurSchema, STATUT_PAR_CODE } from "./commun/erreurs.ts";
import { TERMES } from "./commun/identifiants.ts";
import { REGLES_FOND } from "./commun/regles-fond.ts";
import { CHAINE_SIGNEE, EN_TETES } from "./commun/signature.ts";

// Contrôle de non-régression des fixtures archivées au gel (fixtures-gelees/<version>/<contrat>/, ADR 0032 et 0033).
// Un contrôle par contrat gelé : il lit un fichier archivé et rend un verdict par exemple ([nom, vrai si toujours bon]).
// Un fichier qu'aucun contrôle ne sait lire rend faux : une archive ne peut pas échapper au test.
type Verdicts = [string, boolean][];
type Controle = (fichier: string, contenu: unknown) => Verdicts;
type Cas = { nom: string; valide: boolean; chemin: string; corps: string };
type Reponse = { nom: string; valide: boolean; statut?: number; corps: unknown };
type Fixture = { cas?: Cas[]; reponses?: Reponse[] };

const SCHEMAS = "json-schema.json";
const inconnu = (f: string): Verdicts => [[`${f} : fichier inconnu`, false]];
const valides = <T extends { valide: boolean }>(liste: T[] | undefined) => (liste ?? []).filter((x) => x.valide);
const donnees = (c: Cas) => (c.corps !== "" ? JSON.parse(c.corps) : Object.fromEntries(new URLSearchParams(c.chemin.split("?")[1] ?? "")));
const sousEnsemble = (archive: readonly unknown[] | undefined, actuel: readonly unknown[]) => (archive ?? []).every((x) => actuel.includes(x));

const c1: Controle = (f, contenu) => {
  if (f === SCHEMAS) return [];
  const route: RouteC1 | undefined = ROUTES_C1[f.replace(/\.json$/, "") as keyof typeof ROUTES_C1];
  if (!route) return inconnu(f);
  const { cas, reponses } = contenu as Fixture;
  const modele = new RegExp(`^${route.chemin.replace(/\{[^}]+\}/g, "[^/]+")}$`);
  return [
    ...valides(cas).map((c): [string, boolean] => {
      const [chemin = ""] = c.chemin.slice(PREFIXE_C1.length).split("?");
      return [c.nom, modele.test(chemin) && (!route.requete || route.requete.safeParse(donnees(c)).success)];
    }),
    ...valides(reponses).map((r): [string, boolean] => [r.nom, route.reponses[r.statut ?? 0]?.safeParse(r.corps).success === true]),
  ];
};

const c2: Controle = (f, contenu) =>
  f === SCHEMAS ? [] : valides((contenu as Fixture).cas).map((c) => [c.nom, Fait.safeParse(JSON.parse(c.corps)).success]);

const c3: Controle = (f, contenu) => {
  if (f === SCHEMAS || f === "siren-generes.json") return [];
  const { cas, reponses } = contenu as Fixture;
  if (f === "lecture-entreprise.json") {
    return [
      ...valides(cas).map((c): [string, boolean] => [c.nom, LectureRequete.safeParse(donnees(c)).success]),
      ...valides(reponses).map((r): [string, boolean] => [r.nom, (r.statut === 404 ? ErreurSchema : LectureReponse).safeParse(r.corps).success]),
    ];
  }
  if (!cas) return inconnu(f);
  return valides(cas).map((c) => {
    const v = JSON.parse(c.corps) as { producer?: string };
    return [c.nom, (v.producer === "axion-crm" ? EvenementCrm : EvenementConsole).safeParse(v).success];
  });
};

// C6 : chaque jeton archivé garde son verdict (valide ou refusé) ; les constantes du jeton ne bougent pas.
const c6: Controle = (f, contenu) => {
  if (f === "jetons.json") {
    const { cles, maintenant, cas } = contenu as { cles: { kid: string; secret: string }[]; maintenant: number; cas: { nom: string; valide: boolean; jeton: string }[] };
    return cas.map((c) => [c.nom, verifierJeton(cles, c.jeton, maintenant, () => false).ok === c.valide]);
  }
  if (f === "constantes.json") {
    const k = contenu as { route: { chemin: string }; dureeSecondes: number; versionJeton: number; prefixeKid: string };
    return [["route, durée, version et préfixe du jeton", k.route.chemin === ROUTE_C6.chemin && k.dureeSecondes === DUREE_SECONDES && k.versionJeton === VERSION_JETON && k.prefixeKid === PREFIXE_KID]];
  }
  return inconnu(f);
};

// Commun : rien ne se retire (codes d'erreur et leur statut, en-têtes, règles de fond, termes) et la chaîne signée ne change pas.
const commun: Controle = (f, contenu) => {
  if (f !== "constantes.json") return inconnu(f);
  const k = contenu as { chaineSignee: string; enTetes: Record<string, string>; codesErreur: Record<string, number>; reglesFond: string[]; termes: string[] };
  const statuts = STATUT_PAR_CODE as Record<string, number>;
  return [
    ["chaîne signée", k.chaineSignee === CHAINE_SIGNEE],
    ["en-têtes", Object.entries(k.enTetes).every(([n, v]) => (EN_TETES as Record<string, string>)[n] === v)],
    ["codes d'erreur et statuts", Object.entries(k.codesErreur).every(([code, statut]) => statuts[code] === statut)],
    ["règles de fond", sousEnsemble(k.reglesFond, Object.keys(REGLES_FOND))],
    ["termes", sousEnsemble(k.termes, TERMES)],
  ];
};

export const CONTROLES_ARCHIVE: Record<string, Controle> = { commun, c1, c2, c3, c6 };
