/** @jsxRuntime automatic @jsxImportSource react */
import { Bouton, Lien } from "@axion-auto/design/src/composants/base.tsx";
import { BoutonDanger } from "@axion-auto/design/src/composants/Bouton.tsx";
import { Pastille, type CouleurPastille } from "@axion-auto/design/src/composants/Pastille.tsx";
import type { AccesEnCours, DonneesSecurite, MembreSecurite, RoleEquipe, SessionMembre } from "./donnees.ts";

const LIBELLE_ROLE: Record<RoleEquipe, string> = { dirigeant: "Dirigeant", second_administrateur: "Second administrateur" };
const teinte = (o: Record<string, unknown>): CouleurPastille => Object.keys(o)[0] as CouleurPastille;
const LIBELLE_ACCES = { vue_client: "Vue comme le client", intervention: "Intervention" } as const;
const FACTEUR = { otp: "application d'authentification", webauthn: "clé de sécurité" } as const;

const FORMAT = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" });
const date = (iso: string) => FORMAT.format(new Date(iso));

const sectionStyle = { display: "flex", flexDirection: "column", gap: "var(--espacement-16)", minWidth: 0 } as const;
const defile = { overflowX: "auto", maxWidth: "100%" } as const;

function Invitation() {
  return (
    <form method="post" aria-labelledby="titre-invitation" data-geste="inviter" style={sectionStyle}>
      <h2 id="titre-invitation">Inviter un membre</h2>
      <label htmlFor="invitation-courriel">Adresse e-mail</label>
      <input id="invitation-courriel" name="courriel" type="email" required maxLength={254} autoComplete="off" />
      <label htmlFor="invitation-role">Rôle</label>
      <select id="invitation-role" name="role" defaultValue="second_administrateur">
        <option value="dirigeant">{LIBELLE_ROLE.dirigeant}</option>
        <option value="second_administrateur">{LIBELLE_ROLE.second_administrateur}</option>
      </select>
      <Bouton variante="principal" type="submit">Inviter</Bouton>
    </form>
  );
}

function Revocation({ membre, session }: { membre: MembreSecurite; session: SessionMembre }) {
  return (
    <details>
      <summary>Révoquer</summary>
      <form method="post" data-geste="revoquer" data-session={session.id}>
        <input type="hidden" name="membreId" value={membre.id} />
        <input type="hidden" name="sessionId" value={session.id} />
        <span>Cette session sera fermée. Pour la console elle-même, l'effet est différé.</span>
        <BoutonDanger type="submit">Confirmer la révocation</BoutonDanger>
      </form>
    </details>
  );
}

function Sessions({ membres }: { membres: readonly MembreSecurite[] }) {
  const lignes = membres.flatMap((m) => m.sessions.map((s) => ({ m, s })));
  return (
    <section aria-labelledby="titre-sessions" style={sectionStyle}>
      <h2 id="titre-sessions">Sessions ouvertes</h2>
      <div style={defile}>
        <table className="r-tableau" style={{ width: "100%", borderCollapse: "collapse" }}>
          <caption style={{ textAlign: "left", fontWeight: 800 }}>Sessions ouvertes de l'équipe</caption>
          <thead>
            <tr>{["Membre", "Rôle", "Ouverte le", "Dernière activité", "Fin prévue", "Double facteur", "Action"].map((c) => <th key={c} scope="col" style={{ textAlign: "left" }}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {lignes.map(({ m, s }) => (
              <tr key={s.id} data-session={s.id}>
                <td data-libelle="Membre">{m.libelle}</td>
                <td data-libelle="Rôle">{LIBELLE_ROLE[m.role]}</td>
                <td data-libelle="Ouverte le">{date(s.ouverteLe)}</td>
                <td data-libelle="Dernière activité">{date(s.derniereActivite)}</td>
                <td data-libelle="Fin prévue">{date(s.finPrevue)}</td>
                <td data-libelle="Double facteur">
                  {s.facteurs.length > 0
                    ? <><Pastille couleur={teinte({ vert: 0 })} mot="Double facteur actif" /> {s.facteurs.map((f) => FACTEUR[f]).join(", ")}</>
                    : <Pastille couleur={teinte({ orange: 0 })} mot="Double facteur absent" />}
                </td>
                <td data-libelle="Action"><Revocation membre={m} session={s} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Acces({ acces }: { acces: readonly AccesEnCours[] }) {
  return (
    <section aria-labelledby="titre-acces" style={sectionStyle}>
      <h2 id="titre-acces">Accès en cours aux données d'un client</h2>
      {acces.length === 0 ? <span>Aucun accès en cours.</span> : (
        <div style={defile}>
          <table className="r-tableau" style={{ width: "100%", borderCollapse: "collapse" }}>
            <caption style={{ textAlign: "left", fontWeight: 800 }}>Accès en cours</caption>
            <thead>
              <tr>{["Type", "Client", "Début", "Fin"].map((c) => <th key={c} scope="col" style={{ textAlign: "left" }}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {acces.map((a) => (
                <tr key={`${a.type}-${a.clientLibelle}-${a.debut}`}>
                  <td data-libelle="Type">{LIBELLE_ACCES[a.type]}</td>
                  <td data-libelle="Client">{a.clientLibelle}</td>
                  <td data-libelle="Début">{date(a.debut)}</td>
                  <td data-libelle="Fin">{date(a.fin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Écran Sécurité et accès (T3-07d) : cinq états, données reçues d'un port. Les gestes passent par l'API d'équipe (pont : dette). */
export function EcranSecurite({ donnees }: { donnees: DonneesSecurite }) {
  return (
    <section aria-labelledby="titre" style={{ ...sectionStyle, maxWidth: "100%" }}>
      <h1 id="titre">Sécurité et accès</h1>
      {donnees.genre === "chargement" && <div role="status" aria-busy="true">Chargement de la sécurité de l'équipe…</div>}
      {donnees.genre === "acces-refuse" && (
        <>
          <h2>Accès réservé</h2>
          <p>Seul le dirigeant peut voir et modifier la sécurité de l'équipe.</p>
          <Lien href="/">Retour à l'accueil</Lien>
        </>
      )}
      {donnees.genre === "erreur" && (
        <>
          <h2>La sécurité de l'équipe ne s'est pas affichée</h2>
          <p>Le chargement s'est interrompu. Rien n'a été modifié : vous pouvez réessayer.</p>
          <Lien href="/securite">Réessayer</Lien>
        </>
      )}
      {donnees.genre === "vide" && (
        <>
          <p>Aucune session d'équipe à afficher pour le moment.</p>
          <Invitation />
        </>
      )}
      {donnees.genre === "normal" && (
        <>
          <Sessions membres={donnees.membres} />
          <Acces acces={donnees.acces} />
          <Invitation />
        </>
      )}
    </section>
  );
}
