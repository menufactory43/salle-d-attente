# Salle d'attente

Un mod pour Claude Code : pendant que Claude travaille, une ligne apparaît au-dessus du champ de saisie,
*« Claude bosse, une partie en attendant ? »*. Un clic ouvre une partie de
[Modern Claudefare](https://www.modernclaudefare.com/) dans un panneau, à côté de la conversation.
Les autres joueurs du salon attendent leur Claude, eux aussi.

Modern Claudefare est un FPS multijoueur gratuit qui tourne dans le navigateur, créé par **Vesper**.
Ce mod ne contient rien du jeu : il l'ouvre depuis son site, dans un Chrome invisible.
Tous les droits sur le jeu restent à son auteur, et ceux de Call of Duty à leurs titulaires.

## Ce qu'il faut

- macOS avec **Google Chrome** et **Node.js** (18 ou plus récent).
- Un terminal qui affiche des images : **Ghostty** ou **kitty**. Ailleurs (Terminal.app, iTerm2, tmux,
  l'app de bureau), le bouton ouvre le jeu dans ton navigateur.
- Claude Code récent, avec les mods. Le panneau se place à droite en mode plein écran, au-dessus du champ
  de saisie sinon.

## Installation

```
/plugin marketplace add menufactory43/salle-d-attente
/plugin install salle-d-attente@salle-d-attente
```

## Jouer

- **Pendant que Claude travaille** : clique sur « 🎮 Modern Claudefare » au-dessus du champ de saisie.
- **N'importe quand** : `/jouer`.
- **Clique dans l'image** pour lui donner le clavier, **Échap** le rend à Claude Code.
- WASD pour bouger (bouton AZERTY pour ZQSD), la souris pour viser et tirer, les flèches pour tourner
  quand le curseur touche le bord du panneau. Les autres touches du jeu sont affichées dans son menu.
- **Jouer avec des potes** : « Host a lobby » dans le jeu, puis le bouton **Copier l'invitation** en haut du
  panneau. Ton pote tape `/jouer <lien>` (ou ouvre le lien dans son navigateur).
- `/jouer stop` arrête la partie, `/jouer off` cache la ligne au-dessus du champ de saisie (`/jouer on` la remet).

La partie continue quand Claude a fini : une notification te le dit.

## Comment ça marche

`bridge/bridge.mjs` lance Chrome sans fenêtre sur la page du jeu, capture ses images (une vingtaine par
seconde) et les écrit en PNG dans `~/Library/Caches/salle-d-attente`. Le mod les affiche dans le panneau et
renvoie au jeu les clics, les mouvements de souris et les touches, par un petit serveur sur `127.0.0.1`
qui n'accepte que les requêtes portant un code tiré au hasard à chaque lancement.

Limites connues :

- Un terminal n'envoie jamais le relâchement d'une touche, seulement ses répétitions : le mod relâche la
  touche quand les répétitions s'arrêtent, ce qui peut faire accrocher le premier pas.
- La visée suit le curseur dans le panneau : au bord, prends les flèches.
- Plus le panneau est grand, moins il y a d'images par seconde (la page est plafonnée à 820 px de large).

En cas de problème, le journal est dans `~/Library/Caches/salle-d-attente/bridge.log`.
