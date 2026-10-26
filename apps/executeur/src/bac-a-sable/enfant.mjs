// Amorce du processus jetable. Lancée avec le modèle de permissions de Node : elle est le seul fichier lisible.
// Autonome (imports « node: » seulement) : l'enfant ne charge aucun autre fichier.
import process from "node:process";
import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

// Défense en profondeur : Node 22 n'a pas de permission réseau, on retire donc les chemins de connexion avant le module.
const refus = () => {
  throw Object.assign(new Error("reseau_interdit"), { code: "ERR_ACCESS_DENIED" });
};
const fermer = (objet, noms) => {
  for (const nom of noms) Object.defineProperty(objet, nom, { value: refus, writable: false, configurable: false });
};
fermer(net.Socket.prototype, ["connect"]);
fermer(dgram.Socket.prototype, ["bind", "connect", "send"]);
// DNS : toute la surface est fermée en lot (fonctions de dns, dns.promises et des deux Resolver), pas une liste de noms.
const GARDES = new Set(["Resolver", "constructor", "getServers", "setServers", "getDefaultResultOrder", "setDefaultResultOrder"]);
const fermerFonctions = (objet) =>
  fermer(objet, Object.getOwnPropertyNames(objet).filter((n) => typeof objet[n] === "function" && !GARDES.has(n)));
for (const o of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) fermerFonctions(o);
// Signaux : l'enfant ne signale ni le parent ni un autre processus du même utilisateur.
fermer(process, ["kill", "_kill", "abort"]);
// Les imports nommés (« import { resolveTxt } from 'node:dns' ») doivent voir les versions fermées.
syncBuiltinESMExports();

process.once("message", async (m) => {
  let reponse;
  try {
    const module = await import(`data:text/javascript;base64,${m.code}`);
    const valeur = await module.executer(m.entree, { jeton: m.jeton });
    reponse = { type: "resultat", valeur: valeur === undefined ? null : valeur };
  } catch (e) {
    reponse = { type: "erreur", message: String(e?.message ?? "erreur") };
  }
  process.send(reponse, () => process.exit(0));
});
