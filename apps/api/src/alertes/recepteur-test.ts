// Branche une alerte de disque sur le récepteur webhook de test (T1A-12), en test seulement.
// Le port `Alertes` de T1A-10 ne connaît pas encore ce type d'alerte : écart déclaré dans la PR.
export async function envoyerAlerteDisque(urlRecepteur: string, message: string): Promise<void> {
  if (process.env["NODE_ENV"] !== "test") throw new Error("recepteur_test_hors_test");
  const r = await fetch(`${urlRecepteur}/webhook/alerte-disque`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "disque", message }),
  });
  if (!r.ok) throw new Error(`recepteur_test_${r.status}`);
}
