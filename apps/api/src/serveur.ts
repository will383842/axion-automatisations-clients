import Fastify from "fastify";
import { routeSante } from "./routes/sante.js";

export function construireServeur() {
  const serveur = Fastify();
  routeSante(serveur);
  return serveur;
}
