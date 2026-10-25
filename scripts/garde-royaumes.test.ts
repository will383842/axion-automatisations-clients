import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifierRoyaume } from "./garde-royaumes.ts";

type Royaume = Record<string, any>;
const lire = (nom: string) => readFileSync(new URL(`../ops/socle/keycloak/${nom}`, import.meta.url), "utf8");

// Royaume de l'équipe valide, construit ici : chaque test casse UN réglage.
function equipe(): Royaume {
  return {
    realm: "equipe",
    registrationAllowed: false,
    ssoSessionMaxLifespan: 28800,
    ssoSessionIdleTimeout: 1800,
    accessTokenLifespan: 300,
    browserFlow: "navigateur-equipe",
    requiredActions: [
      { alias: "CONFIGURE_TOTP", enabled: true, defaultAction: true },
      { alias: "webauthn-register", enabled: true, defaultAction: true },
    ],
    authenticationFlows: [
      {
        alias: "navigateur-equipe",
        authenticationExecutions: [
          { authenticator: "auth-cookie", requirement: "ALTERNATIVE" },
          { flowAlias: "formulaire-equipe", authenticatorFlow: true, requirement: "ALTERNATIVE" },
        ],
      },
      {
        alias: "formulaire-equipe",
        authenticationExecutions: [
          { authenticator: "auth-username-password-form", requirement: "REQUIRED" },
          { flowAlias: "double-facteur-equipe", authenticatorFlow: true, requirement: "REQUIRED" },
        ],
      },
      {
        alias: "double-facteur-equipe",
        authenticationExecutions: [
          { authenticator: "webauthn-authenticator", requirement: "ALTERNATIVE" },
          { authenticator: "auth-otp-form", requirement: "ALTERNATIVE" },
        ],
      },
    ],
    clients: [
      {
        clientId: "console",
        publicClient: false,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        implicitFlowEnabled: false,
        secret: "${env.KC_SECRET_CONSOLE}",
        attributes: { "pkce.code.challenge.method": "S256" },
      },
    ],
  };
}
const verifier = (r: Royaume, nom = "royaume-equipe.json") => verifierRoyaume(nom, JSON.stringify(r));
const cible = (r: Royaume, alias: string) => (r.authenticationFlows as Royaume[]).find((f) => f.alias === alias)!;

describe("garde-royaumes : royaume valide", () => {
  it("[LOT1-kc] le royaume de référence passe", () => expect(verifier(equipe())).toEqual([]));
  it("[A-062] les fichiers versionnés equipe et clients passent la garde", () => {
    expect(verifierRoyaume("royaume-equipe.json", lire("royaume-equipe.json"))).toEqual([]);
    expect(verifierRoyaume("royaume-clients.json", lire("royaume-clients.json"))).toEqual([]);
  });
  it("[LOT1-kc] un JSON illisible est refusé", () => expect(verifierRoyaume("x.json", "{pas du json")).not.toEqual([]));
});

describe("garde-royaumes : octroi direct et clients", () => {
  it("[LOT1-kc] refuse directAccessGrantsEnabled sur un client réel", () => {
    const r = equipe();
    r.clients[0].directAccessGrantsEnabled = true;
    expect(verifier(r).join()).toMatch(/directAccessGrantsEnabled/);
  });
  it("[LOT1-kc] refuse directAccessGrantsEnabled absent (valeur par défaut de Keycloak)", () => {
    const r = equipe();
    delete r.clients[0].directAccessGrantsEnabled;
    expect(verifier(r).join()).toMatch(/directAccessGrantsEnabled/);
  });
  it("[LOT1-kc] refuse le client d'essai glissé dans un fichier réel", () => {
    const r = equipe();
    r.clients.push({ ...r.clients[0], clientId: "essai-direct" });
    expect(verifier(r).join()).toMatch(/essai-direct/);
  });
  it("[LOT1-kc] refuse un secret de client en clair", () => {
    const r = equipe();
    r.clients[0].secret = "abcdef0123456789";
    expect(verifier(r).join()).toMatch(/secret/);
  });
  it("[LOT1-kc] refuse un client sans PKCE S256 et le flux implicite", () => {
    const r = equipe();
    r.clients[0].attributes = {};
    r.clients[0].implicitFlowEnabled = true;
    const e = verifier(r).join();
    expect(e).toMatch(/PKCE/);
    expect(e).toMatch(/implicitFlowEnabled/);
  });
  it("[LOT1-kc] refuse l'auto-inscription dans le royaume de l'équipe", () => {
    const r = equipe();
    r.registrationAllowed = true;
    expect(verifier(r).join()).toMatch(/registrationAllowed/);
  });
  it("[LOT1-kc] refuse un utilisateur avec identifiants dans un fichier de royaume", () => {
    const r = equipe();
    r.users = [{ username: "essai", credentials: [{ type: "password", value: "x" }] }];
    expect(verifier(r).join()).toMatch(/users/);
  });
});

describe("garde-royaumes : durées", () => {
  it("[C-001] refuse une session de plus de 8 h", () => {
    const r = equipe();
    r.ssoSessionMaxLifespan = 28801;
    expect(verifier(r).join()).toMatch(/ssoSessionMaxLifespan/);
  });
  it("[C-001] refuse une durée de session absente ou une inactivité de plus de 8 h", () => {
    const a = equipe();
    delete a.ssoSessionMaxLifespan;
    expect(verifier(a).join()).toMatch(/ssoSessionMaxLifespan/);
    const b = equipe();
    b.ssoSessionIdleTimeout = 90000;
    expect(verifier(b).join()).toMatch(/ssoSessionIdleTimeout/);
  });
  it("[C-001] refuse un jeton d'accès de plus de 5 minutes ou sans durée", () => {
    const a = equipe();
    a.accessTokenLifespan = 301;
    expect(verifier(a).join()).toMatch(/accessTokenLifespan/);
    const b = equipe();
    delete b.accessTokenLifespan;
    expect(verifier(b).join()).toMatch(/accessTokenLifespan/);
  });
});

describe("garde-royaumes : double facteur", () => {
  it("[C-002] refuse un authentificateur SMS", () => {
    const r = equipe();
    cible(r, "double-facteur-equipe").authenticationExecutions.push({ authenticator: "sms-authenticator", requirement: "ALTERNATIVE" });
    expect(verifier(r).join()).toMatch(/sms-authenticator/);
  });
  it("[C-002] refuse un double facteur facultatif (sous-flux conditionnel, désactivé ou alternatif)", () => {
    for (const exigence of ["CONDITIONAL", "DISABLED", "ALTERNATIVE"]) {
      const r = equipe();
      cible(r, "formulaire-equipe").authenticationExecutions[1].requirement = exigence;
      expect(verifier(r).join(), exigence).toMatch(/double facteur/);
    }
  });
  it("[C-002] refuse un mot de passe désactivé ou facultatif", () => {
    const r = equipe();
    cible(r, "formulaire-equipe").authenticationExecutions[0].requirement = "ALTERNATIVE";
    expect(verifier(r).join()).toMatch(/mot de passe/);
  });
  it("[C-002] refuse une méthode OTP désactivée qui laisserait un sous-flux vide", () => {
    const r = equipe();
    for (const e of cible(r, "double-facteur-equipe").authenticationExecutions) e.requirement = "DISABLED";
    expect(verifier(r).join()).toMatch(/double facteur/);
  });
  it("[C-002] refuse un contournement par un autre authentificateur (fournisseur d'identité, clé d'accès seule)", () => {
    for (const a of ["identity-provider-redirector", "webauthn-authenticator-passwordless"]) {
      const r = equipe();
      cible(r, "navigateur-equipe").authenticationExecutions.push({ authenticator: a, requirement: "ALTERNATIVE" });
      expect(verifier(r).join(), a).toMatch(new RegExp(a));
    }
  });
  it("[C-002] refuse un flux de navigateur introuvable ou non déclaré", () => {
    const r = equipe();
    r.browserFlow = "browser";
    expect(verifier(r).join()).toMatch(/browserFlow/);
  });
  it("[C-002] refuse l'absence d'action requise de configuration du double facteur par défaut", () => {
    const r = equipe();
    r.requiredActions[0].defaultAction = false;
    r.requiredActions[1].enabled = false;
    expect(verifier(r).join()).toMatch(/action requise/);
  });
  it("[LOT1-kc] le royaume clients n'exige pas de double facteur ici (lot 6) mais garde les autres règles", () => {
    const r = equipe();
    r.realm = "clients";
    delete r.browserFlow;
    r.authenticationFlows = [];
    r.requiredActions = [];
    expect(verifier(r, "royaume-clients.json")).toEqual([]);
    r.clients[0].directAccessGrantsEnabled = true;
    expect(verifier(r, "royaume-clients.json").join()).toMatch(/directAccessGrantsEnabled/);
  });
});
