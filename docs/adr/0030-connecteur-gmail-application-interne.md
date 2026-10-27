# 0030 · Connecteur Gmail par l'application interne du client

Date : 26/10/2026 · Statut : proposé, à confirmer par l'architecte

## Contexte
Un client Google se relie par une application Google INTERNE créée dans son propre compte Workspace : aucune application Google d'AXION IA, aucune vérification de sécurité externe en V1. Le connecteur Gmail (T4-13) suit le modèle du connecteur Microsoft 365 : appels HTTP par `fetch`, aucune bibliothèque Google.

## Décision
1. Garantie d'effet de `envoyer` : `verifiable_apres_coup`. Gmail n'a pas de clé anti-doublon ; le message porte le `Message-ID` choisi par le moteur et l'en-tête `X-Axion-Intention`. `verifierApresCoup` cherche `rfc822msgid:<id> in:sent` : `trouve`, `absent` ou `indetermine` ; une erreur ou un délai donne `indetermine`, jamais `absent`. Le message envoyé est construit par le connecteur (saut de ligne refusé dans l'objet et le destinataire).
2. Portées : les plus étroites qui couvrent les actions demandées par les modules installés : `gmail.readonly` + `gmail.compose`, et `gmail.modify` seulement si un module étiquette.
3. Deux interrupteurs fermés par défaut : `CONNECTEURS_MESSAGERIE_OUVERT` (famille) et `CONNECTEUR_GMAIL_OUVERT` (Gmail), tous deux à `1` pour ouvrir. Gmail reste fermé tant que sa fiche de conformité n'est pas signée. L'adresse vient de `GMAIL_URL`, sans valeur par défaut.
4. Curseur : la liste complète de `INBOX` retient l'`historyId` lu AVANT la liste ; le curseur suivant `h:<historyId>` se lit par `curseurHistorique()`. Même limite que l'ADR 0021 : l'interface de famille n'a pas de curseur final, le moteur doit le mémoriser (évolution du contrat, décision de l'architecte). `history.list` en 404 : repli sur une liste complète qui ne redonne pas les messages déjà rendus par ce processus ; après un redémarrage, c'est le journal d'étapes du moteur qui évite les doublons.

## Conséquences
- À vérifier la nuit avec un vrai compte de test : Gmail doit conserver le `Message-ID` fourni ; sinon la recherche après coup devra s'appuyer sur un autre repère.
- Aucune dépendance ajoutée.

## À vérifier la nuit, sur un vrai compte
La vérification après coup passe par la recherche `rfc822msgid:` de Gmail, donc par son index de recherche. Il faut mesurer si un message tout juste envoyé y est trouvé tout de suite ; sinon une vérification immédiate rendrait `absent` à tort et permettrait un doublon.
