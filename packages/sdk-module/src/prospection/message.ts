// Les textes fixes (désinscription, informations dues au premier contact) viennent du catalogue de
// messages, à relire par le juriste : le SDK n'en écrit aucun.
export type TextesProspection = {
  ligneDesinscription: (url: string) => string;
  informationsPremierContact: string;
};

export type EntreeMessage = {
  expediteur: { raisonSociale: string; adresse: string };
  destinataire: { adresse: string };
  fonction: string;
  motifLien: string;
  objet: string;
  corps: string;
  desinscription: { mailto: string; url: string };
  textes: TextesProspection;
  premierContact?: boolean;
};

export type MessageDeProspection = {
  readonly a: string;
  readonly objet: string;
  readonly corps: string;
  readonly entetes: Readonly<Record<string, string>>;
};

const vide = (s: string) => s.trim() === "";
const SAUT = /[\r\n]/;

export function messageDeProspection(e: EntreeMessage): MessageDeProspection {
  if (vide(e.expediteur.raisonSociale)) throw new Error("message de prospection : raison sociale de l'expéditeur obligatoire");
  if (vide(e.expediteur.adresse)) throw new Error("message de prospection : adresse de l'expéditeur obligatoire");
  if (vide(e.fonction)) throw new Error("message de prospection : fonction du destinataire obligatoire");
  if (vide(e.motifLien)) throw new Error("message de prospection : motif du lien avec la fonction obligatoire");
  const { mailto, url } = e.desinscription;
  if (!mailto.startsWith("mailto:") || SAUT.test(mailto) || mailto.includes(">")) throw new Error("désinscription : adresse mailto invalide");
  if (!url.startsWith("https://") || /[\s<>]/.test(url)) throw new Error("désinscription : URL HTTPS obligatoire");
  if (SAUT.test(e.objet) || SAUT.test(e.destinataire.adresse)) throw new Error("message de prospection : saut de ligne interdit dans l'objet ou l'adresse");

  const parties = [e.corps];
  if (e.premierContact) parties.push(e.textes.informationsPremierContact);
  parties.push(`${e.expediteur.raisonSociale}, ${e.expediteur.adresse}`, e.textes.ligneDesinscription(url));
  return Object.freeze({
    a: e.destinataire.adresse,
    objet: e.objet,
    corps: parties.join("\n\n"),
    entetes: Object.freeze({
      "List-Unsubscribe": `<${mailto}>, <${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    }),
  });
}
