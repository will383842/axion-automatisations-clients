# 0104 · Image axion-moteur en mode mutualisé et module enveloppe

Date : 01/11/2026 · Statut : accepté (fiche T4-20) · Contrat touché : aucun

## Contexte
L'exécuteur doit sortir en une seule image, construite comme les images dérivées (ADR 0014). Un composant open source repris doit tourner à part, sans coffre.

## Décision
1. Une seule image `axion-moteur` : `FROM` unique épinglé par empreinte, utilisateur numérique non root, point d'entrée qui refuse le root, disque en lecture seule et seul `/tmp` en tmpfs borné (compose). Aucun paquet headscale ni tailscale.
2. Le mode est un réglage `EXECUTEUR_MODE` : seul `mutualise` est accepté en V1 ; `relie` et `autonome` sont refusés au démarrage (V2).
3. Module enveloppe : conteneur séparé, image par empreinte inscrite dans `ops/briques/`, sans variable, sans volume, sans capacité, sur le réseau interne `enveloppe` qui ne joint que l'exécuteur. Même contrat d'entrée et de sortie qu'un module en code.
4. Le compose cite l'image par empreinte, jamais par étiquette.

## Conséquences
Le workflow de publication (`image-moteur.yml`) n'est pas dans cette PR : reporté à une PR qui a le droit de toucher aux workflows. Tant qu'aucune image n'est publiée, le service du compose n'a pas de ligne `image:`.
