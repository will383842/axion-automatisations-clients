# connecteur-imap

Connecteur de la famille messagerie pour les boîtes IMAP/SMTP (Orange, OVH, Zoho et autres). En production, l'adresse visée est le mandataire IMAP/SMTP du courtier : le connecteur ne connaît jamais le mot de passe d'application du client, il présente le jeton court reçu à chaque appel.

## Ce qu'il fait
- Les 5 actions de la famille : `lister_nouveaux`, `lire`, `etiqueter`, `creer_brouillon`, `envoyer`.
- Curseur `UIDVALIDITY:UID` du dernier message vu ; identifiant de message `m-<UID>` dans `INBOX`.
- Étiquettes : mots-clés IMAP (`$AxionTraite`…). Brouillon : `APPEND` dans le dossier `\Drafts`.
- Envoi : SMTP avec le `Message-ID` du moteur, puis copie dans `\Sent` seulement si le serveur ne l'a pas déjà faite. Un échec de cette copie ne fait pas échouer l'envoi (alerte `copie_envoyes_echouee`).
- Dossiers trouvés par attribut spécial (RFC 6154), jamais par nom affiché.

## Garantie de l'envoi (A-319)
- `\Sent` trouvé : `verifiable_apres_coup` ; `verifierApresCoup` cherche le `Message-ID` dans `\Sent`.
- `\Sent` introuvable : `au_plus_une_fois`, aucun renvoi, alerte `dossier_envoyes_introuvable`.

## Sécurité
- Configuration stricte, sans champ de mot de passe (A-335). TLS direct (993, 465) ou STARTTLS exigé (143, 587) ; aucun repli en clair, TLS 1.2 minimum (A-389).
- Erreurs : identification refusée → `identification` ; `[OVERQUOTA]`, 421, 452 → `quota` (reprise = attente par défaut de la politique) ; coupure → `passagere` ; le reste → `definitive`. Le texte du serveur n'est jamais recopié.
- Une connexion IMAP est ouverte puis fermée à chaque appel (processus jetable).
- Fermé par défaut : `ouvrirSiOuvert` exige `CONNECTEURS_MESSAGERIE_OUVERT=1`.

## Tests
- `pnpm test -- connecteur-imap` : suite messagerie commune sur un faux serveur en mémoire, erreurs enregistrées dans `enregistrements/`.
- `connecteur.int.test.ts` : GreenMail du socle (job `socle-integration`).
