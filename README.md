# Compagnon MCP — `dsh-mcp-companion`

Complète le panneau **Skill / MCP** de DeepSeek Harness : il affiche les serveurs MCP qu'un autre plugin monte lui-même — `wincu` (computer use Windows) et le pont de ressources MCP de DSH — et donne à leurs cartes un interrupteur **réellement fonctionnel et persistant**, sans modifier le code du panneau.

Il ajoute aussi un **bouton `MCP` dans la rangée de la nouvelle conversation**, juste à droite du sélecteur de mode (`Standard mode`) : son menu active ou coupe chaque serveur MCP **pour cette conversation uniquement**, sans toucher aux autres agents.

[English version → `README.en.md`](README.en.md)

## Le problème

`dsh-skill-mcp-panel` construit sa liste MCP uniquement à partir des lignes `@deepseek-ai/dsh-mcp-client` de `cordis.patch.yml` du profil.

Or deux serveurs MCP bien réels n'ont aucune ligne :

- **`wincu`** : `dsh-computer-use-win` monte lui-même le client MCP avec `ctx.plugin(bridge, bridgeConfig(...))` ;
- **`mcp-resource-servers`** : le pont `@deepseek-ai/dsh-mcp-resources` enregistre trois outils partagés (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) qui n'ont pas de préfixe `mcp__<serveur>__`.

Conséquence : ils n'apparaissent jamais dans la liste, et même ajoutés, leur interrupteur serait verrouillé puisqu'il n'y a pas de ligne à activer ou désactiver.

## Ce que fait le plugin

- Ajoute une carte **`wincu`** avec ses outils réels (26 dans la configuration computer use complète).
- Ajoute une carte **`mcp-resource-servers`** avec les trois outils du pont de ressources MCP.
- Rend les interrupteurs **fonctionnels** :
  - désactivé → les outils du serveur sont retirés du schéma du modèle pour tous les agents ;
  - réactivé → ils reviennent ;
  - l'état est persisté dans `%USERPROFILE%\.dsh\dsh-customizer\state.json` (ou `$DSH_HOME/dsh-customizer/state.json`) et survit aux redémarrages.
- `Test connection` et `Tools` fonctionnent sur ces cartes (les outils listés sont les vrais).
- Le reste reste en lecture seule avec un message clair : l'édition YAML et la suppression sont refusées, car ces serveurs appartiennent à un autre plugin.
- Ajoute un **bouton `MCP`** dans la rangée de la nouvelle conversation (à droite de `Standard mode`) : son menu liste les serveurs MCP et coupe ceux que vous ne voulez pas **dans cette conversation**. Le réglage est enregistré par conversation.

Aucun fichier d'un autre plugin n'est modifié, aucune ligne n'est ajoutée au `cordis.patch.yml` du profil, et aucun second serveur MCP n'est lancé.

## Installation

Depuis GitHub :

```sh
dsh plugin --profile desktop add github:JamesDAdams/dsh-mcp-companion
```

Ou, dans l'application, via le gestionnaire de plugins (installation d'un bundle à partir du dossier du paquet). Redémarrer DSH si le client n'est pas rechargé à chaud.

## Utilisation

1. Barre latérale → **Skill / MCP** → onglet **MCP**.
2. Les cartes `wincu` et `mcp-resource-servers` apparaissent à côté des serveurs déclarés dans le profil.
3. Basculez l'interrupteur : l'effet est immédiat et l'état est conservé après navigation dans l'application et après redémarrage.

## MCP par conversation

Sur l'écran **New Session**, la rangée qui contient le sélecteur de workspace et `Standard mode` reçoit un bouton **`MCP`** supplémentaire, placé à droite du mode.

- Le menu liste les serveurs MCP actifs (nom, nombre d'outils, origine) avec un interrupteur chacun.
- Un interrupteur coupe les outils de ce serveur **pour l'agent de cette conversation seulement** : les autres conversations et les autres agents gardent leurs outils.
- Un serveur coupé partout dans le profil peut être **réactivé pour une seule conversation** : l'override local l'emporte sur le réglage global.
- Les réglages de conversation sont persistés et suivent la session quand vous la rouvrez ; un réglage identique au défaut global n'est pas enregistré (le fichier ne garde que les différences).

Le bouton vit dans le slot additif `conversation.hero.options` : aucun onglet, aucun élément de l'interface de DSH n'est remplacé.

## Comment ça marche

**Moitié Host** (`index.js`, `filter.js`)

- `GET /local-dsh-customizer/mcp-servers` assemble l'inventaire : entrées du loader (`ctx.loader.entries()`) + outils réellement enregistrés (`mcp__<serveur>__*`) + outils du pont de ressources.
- `GET /local-dsh-customizer/mcp-servers?toggle=<nom>&enabled=true|false` bascule un serveur, écrit l'état et réapplique les restrictions.
- `...?session=<id>` renvoie la vue de cette conversation (avec `override` et `globalEnabled` par serveur) ; `...&session=<id>&toggle=...` écrit un override de conversation au lieu du défaut du profil.
- La désactivation monte un petit plugin sur chaque `agent.ctx` qui appelle `ctx.tools.restrict({ deny })` — même mécanisme que `dsh-skill-mcp-panel`, avec garde de ré-entrance sur `tools/change` pour éviter la boucle connue de cette API. La liste refusée est recalculée par agent : défaut du profil + overrides de **sa** session.
- État : `<dshHome>/dsh-customizer/state.json` — `disabled` (défaut du profil) et `sessions[<id>] = { on, off, at }` (overrides par conversation, 120 sessions max).

**Moitié Client** (`client.js`)

- Décore le service Remote du panneau au niveau de `invoke` : les résultats de `list` et `reload` reçoivent les serveurs manquants.
- Découvre le namespace du panneau **par forme** (méthodes `list`/`test`/`setEnabled`/`removeServer`), pas par nom : le panneau peut renommer son namespace sans casser le plugin.
- Intercepte `setEnabled` (formes positionnelle et objet), appelle la route Host et renvoie la vue à jour.
- Refuse `save` / `removeServer` / `writeRaw` sur ces serveurs avec un message lisible.
- Enregistre le bouton `MCP` dans `conversation.hero.options` et affiche son menu dans un élément ajouté au `body` (aucun ancêtre ne peut le rogner).

## Compatibilité

- Testé avec DeepSeek Harness Desktop `0.2.2-rc.1` et `dsh-skill-mcp-panel` `2.3.12`.
- Le nom du namespace du panneau (`skillMcpPanel`, `mcpManager`) et la forme des appels (`setEnabled(serverName, enabled, entryId)` ou `setEnabled({ serverName, enabled, entryId })`) sont pris en charge.
- Le bouton `MCP` utilise le slot `conversation.hero.options` (« options compactes de la rangée New Session, après les contrôles de workspace et de preset »). Si ce slot disparaît d'une version future, seul le bouton disparaît : le panneau continue de fonctionner.
- Si le panneau change encore son API, la découverte par forme limite la casse : ouvrez une issue avec la version du panneau.

## Limites

- Désactiver **ne stoppe pas** le processus du serveur : `wincu` doit rester lancé pour le computer use, seuls ses outils sont masqués.
- Le bouton `MCP` apparaît dans la rangée de la **nouvelle** conversation (`New Session`) ; c'est là qu'on choisit les serveurs de la conversation à venir. Le réglage reste attaché à la session une fois celle-ci créée.
- Les serveurs déclarés dans `cordis.patch.yml` restent gérés par le panneau lui-même.
- Cette version vise les serveurs stdio montés par un plugin ; les serveurs HTTP distants ne sont pas concernés.

## Désinstallation

```sh
dsh plugin --profile desktop remove dsh-mcp-companion
```

Supprimez éventuellement `%USERPROFILE%\.dsh\dsh-customizer\state.json`.

## Licence

MIT — voir [`LICENSE`](LICENSE).
