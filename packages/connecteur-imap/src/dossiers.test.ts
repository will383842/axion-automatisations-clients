import { describe, expect, it } from "vitest";
import { trouverDossiers } from "./dossiers.ts";

describe("dossiers trouvés par leurs attributs spéciaux (RFC 6154)", () => {
  it("[A-319] \\Sent et \\Drafts sont trouvés quel que soit le nom affiché", () => {
    const d = trouverDossiers([
      { chemin: "INBOX" },
      { chemin: "Éléments envoyés", usageSpecial: "\\Sent" },
      { chemin: "Entwürfe", usageSpecial: "\\Drafts" },
    ]);
    expect(d).toEqual({ envoyes: "Éléments envoyés", brouillons: "Entwürfe" });
  });
  it("[A-319] un dossier appelé « Sent » sans attribut n'est pas pris pour \\Sent", () => {
    expect(trouverDossiers([{ chemin: "INBOX" }, { chemin: "Sent" }, { chemin: "Drafts" }])).toEqual({});
  });
});
