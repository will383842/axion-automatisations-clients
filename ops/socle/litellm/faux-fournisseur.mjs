// Faux fournisseur d'IA (CI seulement) : format « chat completions », usage déterministe, compteur d'appels.
// Il n'écrit JAMAIS le contenu reçu : la seule sortie est la ligne « ECOUTE <port> ».
import { createServer } from "node:http";

const LIMITE = 1_000_000;
const mots = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);
let appels = 0;

const serveur = createServer((q, r) => {
  const rep = (code, corps) => r.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(corps));
  if (q.method === "GET" && q.url === "/compteur") return rep(200, { appels });
  if (q.method !== "POST" || q.url !== "/v1/chat/completions") return rep(404, {});
  let recu = 0;
  const morceaux = [];
  q.on("data", (m) => {
    recu += m.length;
    if (recu > LIMITE) {
      rep(413, {});
      q.destroy();
    } else morceaux.push(m);
  });
  q.on("end", () => {
    if (r.writableEnded) return;
    let messages;
    try {
      messages = JSON.parse(Buffer.concat(morceaux).toString("utf8")).messages;
      if (!Array.isArray(messages) || messages.some((m) => typeof m?.content !== "string")) throw new Error();
    } catch {
      return rep(400, {});
    }
    appels++;
    const question = messages.at(-1)?.content ?? "";
    const reponse = `écho : ${question}`;
    const entree = messages.reduce((n, m) => n + mots(m.content), 0);
    rep(200, {
      id: `faux-${appels}`,
      object: "chat.completion",
      model: "faux",
      choices: [{ index: 0, message: { role: "assistant", content: reponse }, finish_reason: "stop" }],
      usage: { prompt_tokens: entree, completion_tokens: mots(reponse), total_tokens: entree + mots(reponse) },
    });
  });
});

serveur.listen(Number(process.env.PORT ?? 4010), () => console.log(`ECOUTE ${serveur.address().port}`));
