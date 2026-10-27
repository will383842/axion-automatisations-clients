# Surveillance du disque

- `disque.ts` : mesure, prévision de saturation et décision (rien, saturation proche, plafond des journaux atteint). `reveil: true` seulement si la saturation est prévue dans moins de 6 heures.
- `surveiller-disque.sh` : une mesure par appel, lancée à intervalle par le serveur.

## Ce que le lot 1-B ajoute
- La sonde EXTÉRIEURE (hors du serveur de la console) et son lieu.
- L'envoi Telegram réel, sans nom de client, sans adresse ni nom d'hôte.
- Les valeurs réelles de `PLAFOND_JOURNAUX_EN_ATTENTE` et `SEUIL_ALERTE_DISQUE` (lot 8a).
