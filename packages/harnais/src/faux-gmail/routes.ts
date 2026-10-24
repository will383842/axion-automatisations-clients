import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { simpleParser, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import type { ClientMailpit } from "../mailpit.js";
import type { EtatGmail } from "./etat.js";

// Sous-ensemble de l'API Gmail v1. Comme le vrai, AUCUNE clé anti-doublon n'est lue à l'envoi.

const ADRESSE_FICTIVE = /^[^@\s]+@(?:exemple\.fr|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.test)$/i;
const JETON = /^Bearer faux\.(.+)$/;

// Les en-têtes viennent de l'analyseur (lignes dépliées comprises) ; le corps est repris octet pour octet après la ligne vide.
function sansBcc(mail: ParsedMail, brut: Buffer, idMessage: string): Buffer {
  const finEntetes = Math.min(...["\r\n\r\n", "\n\n"].map((m) => brut.indexOf(m)).filter((i) => i >= 0), brut.length);
  const longueurSeparateur = brut.subarray(finEntetes, finEntetes + 4).toString("latin1") === "\r\n\r\n" ? 4 : 2;
  const entetes = mail.headerLines.filter((l) => l.key !== "bcc").map((l) => l.line);
  if (!mail.messageId) entetes.unshift(`Message-ID: <${idMessage}>`);
  return Buffer.concat([Buffer.from(`${entetes.join("\r\n")}\r\n\r\n`, "utf8"), brut.subarray(finEntetes + longueurSeparateur)]);
}

export function routesGmail(app: FastifyInstance, etat: EtatGmail, mailpit: ClientMailpit): void {
  const transport = nodemailer.createTransport({ host: mailpit.smtp.host, port: mailpit.smtp.port, secure: false, ignoreTLS: true });

  app.addHook("preHandler", async (req, rep) => {
    // La route reconnue par le routeur, pas l'URL brute : un chemin encodé (« /%67mail/… ») atteint la même route.
    if (!req.routeOptions.url?.startsWith("/gmail/v1/")) return;
    if (!JETON.test(req.headers.authorization ?? "")) return rep.code(401).send({ error: { code: 401, status: "UNAUTHENTICATED" } });
    if (etat.mode === "panne_generale") return rep.code(503).send({ error: { code: 503, status: "UNAVAILABLE" } });
    if (etat.mode === "acces_refuse") {
      return rep.code(403).send({ error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "accessNotConfigured" }] } });
    }
    if (etat.mode === "quota") return rep.code(429).header("Retry-After", "2").send({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } });
  });

  app.post("/gmail/v1/users/me/messages/send", async (req, rep) => {
    const raw = ((req.body ?? {}) as { raw?: string }).raw;
    if (typeof raw !== "string" || raw === "") return rep.code(400).send({ error: { code: 400, status: "INVALID_ARGUMENT" } });
    const brut = Buffer.from(raw, "base64url");
    const mail = await simpleParser(brut);
    const destinataires = [mail.to, mail.cc, mail.bcc].flat().flatMap((g) => g?.value ?? []).map((a) => a.address ?? "");
    if (destinataires.length === 0 || destinataires.some((a) => !ADRESSE_FICTIVE.test(a))) {
      return rep.code(400).send({ error: { code: 400, status: "INVALID_ARGUMENT", message: "destinataire invalide" } });
    }
    const compte = JETON.exec(req.headers.authorization ?? "")?.[1] ?? "inconnu@exemple.fr";
    const rfc822msgid = (mail.messageId ?? `<${randomUUID()}@faux-gmail.test>`).replace(/^<|>$/g, "");
    // Comme le vrai Gmail : le message part tel quel (pièces jointes, fil, Cc), sans la ligne Bcc ; l'enveloppe porte tous les destinataires.
    await transport.sendMail({ envelope: { from: compte, to: destinataires }, raw: sansBcc(mail, brut, rfc822msgid) });
    const message = { id: randomUUID().replaceAll("-", ""), compte, rfc822msgid, labelIds: ["SENT"] };
    etat.envoyes.push(message);
    if (etat.mode === "reponse_perdue") {
      // Le message est parti ; la connexion est coupée avant la réponse (piège du scénario 8).
      rep.hijack();
      req.raw.socket.destroy();
      return;
    }
    return { id: message.id, threadId: message.id, labelIds: message.labelIds };
  });

  app.get("/gmail/v1/users/me/messages", async (req) => {
    const id = /rfc822msgid:(\S+)/.exec((req.query as Record<string, string>)["q"] ?? "")?.[1];
    const compte = JETON.exec(req.headers.authorization ?? "")?.[1];
    const trouves = etat.envoyes.filter((m) => m.compte === compte && (id === undefined || m.rfc822msgid === id));
    return trouves.length === 0 ? { resultSizeEstimate: 0 } : { messages: trouves.map((m) => ({ id: m.id, threadId: m.id })), resultSizeEstimate: trouves.length };
  });
}
