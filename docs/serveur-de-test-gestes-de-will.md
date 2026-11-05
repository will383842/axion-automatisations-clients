# Serveur de test : les gestes de Will chez l'hébergeur

Ce guide est écrit pour Will, pas à pas, en français simple. Il prépare la fiche T1B-09 (restes du serveur de test).
**Règle d'or : on ne note jamais un jeton, un mot de passe, une clé ou une adresse dans ce dépôt.** On les range dans Bitwarden, puis dans OpenBao (ou Coolify) par l'équipe technique.
Rien ne se lance sur la production. Si un geste ne se passe pas comme décrit, on s'arrête et on le dit.

## 1. Créer le projet de test
1. Se connecter à l'espace de l'hébergeur.
2. Créer un NOUVEAU projet, séparé de la production, nommé « test » (le nom du projet ne contient aucun nom de client).
3. Vérifier que le projet de production n'apparaît pas dans la liste de ce projet.

## 2. Créer le jeton du projet de test
1. Dans le projet de test, ouvrir « Sécurité » puis « Jetons d'accès ».
2. Créer un jeton avec les droits de lecture et d'écriture, limité à ce projet.
3. Copier le jeton directement dans Bitwarden (entrée « jeton hébergeur de test »). Ne le coller nulle part d'autre : ni message, ni dépôt, ni session de travail.
4. Prévoir son remplacement à chaque départ d'un administrateur.

## 3. Pare-feu et réseau privé
1. Créer un pare-feu du projet à partir de `ops/pare-feu/regles.json` : en entrée, seulement TCP 443 ; en sortie, tout refusé.
2. Créer un réseau privé pour le projet et y rattacher la machine ; la plage est choisie à ce moment-là et notée dans Bitwarden, pas dans le dépôt.
3. Sur la machine, charger `ops/pare-feu/pare-feu-hote.nft`, puis ajouter les destinations de sortie permises dans l'ensemble `sorties_permises` (la liste vient de l'équipe technique, jamais du dépôt).
4. Lancer, depuis une machine HORS du serveur, `node ops/serveur-de-test/constat-ports.ts <hôte>` : seul le port 443 doit répondre. Noter le résultat daté (sans l'hôte) pour l'orchestrateur.

## 4. Disques chiffrés
1. À la création de la machine, demander des disques de données chiffrés (LUKS).
2. Sur la machine : `node ops/serveur-de-test/constat-luks.ts <montage des données> <montage des sauvegardes>`. Chaque ligne doit dire « CHIFFRE ».

## 5. Sous-compte de la Storage Box en ajout seul (C-593)
1. Dans la Storage Box déjà en service, créer un SOUS-COMPTE dédié à la console, avec sa propre clé SSH (la clé reste dans Bitwarden et sur le seul serveur de la console).
2. Restreindre ce sous-compte : accès SFTP seulement, joignable depuis le seul serveur de la console, dossier propre.
3. Vérifier l'ajout seul : le sous-compte peut déposer un fichier, mais ne peut ni effacer ni écraser une sauvegarde. Essayer d'effacer un fichier d'essai : l'opération doit être refusée.
4. **Si l'hébergeur ne sait pas faire l'ajout seul sur un sous-compte** (le sommaire 1-A dit que ce n'est pas une fonction native connue) : s'arrêter, ne rien payer de plus, et le dire à l'architecte. Autres méthodes à étudier : instantanés que le serveur ne peut pas effacer, ou serveur intermédiaire.
5. Le compte capable d'effacer (tâche `expirer.sh`) vit sur une machine distincte du serveur de la console ; sa clé n'est jamais posée sur le serveur de la console.

## 6. Mesure de la remise en service
1. Noter l'heure de la coupure (secondes depuis l'époque : `date +%s`), puis rejouer la sauvegarde sur la machine d'essai louée.
2. À la première réponse correcte du service, noter `date +%s`.
3. Lancer `node ops/serveur-de-test/remise-en-service.ts <coupure> <service rendu>` : la ligne obtenue est à transmettre à l'orchestrateur.
4. Quand la mesure est faite, détruire la machine d'essai, même en cas d'échec. Vérifier dans la liste du projet qu'elle a disparu.

## 7. Sonde extérieure
1. Choisir un lieu HORS du serveur (une petite machine ou un service de planification séparé).
2. Y poser `ops/sonde-exterieure/sonde.ts` avec `SONDE_URL` (adresse de santé) et `ALERTE_COMMANDE`, lancée toutes les minutes.
3. Éteindre le service de test quelques minutes : l'alerte « serveur muet » doit arriver après deux passages ; au retour, un message de reprise.

## À remettre à l'orchestrateur
Pour chaque étape : la date, le mot « conforme » ou l'écart, jamais une valeur secrète ni une adresse.
