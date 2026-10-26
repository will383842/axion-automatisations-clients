export type PartieTexte = { numero: string; encodage: string; charset: string };
type Noeud = { part?: string | undefined; type?: string | undefined; encoding?: string | undefined; parameters?: { charset?: string | undefined } | undefined; childNodes?: Noeud[] | undefined };

// Première partie text/plain de la structure MIME, ou rien.
export function choisirPartieTexte(n: Noeud): PartieTexte | undefined {
  if (n.type === "text/plain") return { numero: n.part ?? "1", encodage: (n.encoding ?? "7bit").toLowerCase(), charset: (n.parameters?.charset ?? "utf-8").toLowerCase() };
  for (const f of n.childNodes ?? []) {
    const trouve = choisirPartieTexte(f);
    if (trouve) return trouve;
  }
  return undefined;
}

export function decoderCorps(brut: Buffer, encodage: string, charset: string): string {
  const octets =
    encodage === "base64" ? Buffer.from(brut.toString("latin1"), "base64")
    : encodage === "quoted-printable" ? Buffer.from(brut.toString("latin1").replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1")
    : brut;
  try {
    return new TextDecoder(charset).decode(octets);
  } catch {
    return new TextDecoder().decode(octets);
  }
}
