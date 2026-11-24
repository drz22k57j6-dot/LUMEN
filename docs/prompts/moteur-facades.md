# Prompt — Nouveau moteur de façades Lumen (pour Claude Fable 5.2)

> Copie tout ce document dans une nouvelle conversation avec le repo `drz22k57j6-dot/LUMEN` attaché.

---

## 0. Ton rôle

Tu es un ingénieur senior en mondes 3D temps réel : procédural, photogrammétrie, SIG, rendu WebGL mobile. Tu dois construire **le moteur de façades de Lumen**. Il doit produire, partout dans Paris puis en France, des façades **fidèles au bâtiment réel** : l'haussmannien d'abord, puis toutes les autres typologies. Elles doivent être assez crédibles pour une démo Y Combinator, avec un niveau visuel « AAA », et tourner à 60 i/s sur Safari iPhone.

**La fidélité passe avant la beauté.** Lumen vend un rapport d'ensoleillement précis. Une façade jolie mais fausse (mauvais nombre d'étages, fenêtres mal placées) est un bug, pas une feature.

## 1. Le produit et le repo

- **Lumen** : on tape une adresse, on voit le logement en 3D dans son vrai quartier, puis on obtient le soleil par pièce.
- **Stack** : monorepo pnpm, Vite, TypeScript strict, Three.js 0.170, Vitest.
  - Le site est `apps/web`.
  - Les moteurs testables sont dans `packages/*` : core, urban, analysis, interior, vegetation.
- **Déploiement** : GitHub Pages depuis `main`, via `.github/workflows/pages.yml`, avec `VITE_MODE_DEV=1`.
- **Mode développeur** : bouton ⚙, fichier `apps/web/src/dev/panneau.ts`.
  - Il donne la recherche d'adresse, des lieux tests, la caméra libre et le 🚁 Drone.
  - L'objet `window.__lumen` sert au diagnostic, par exemple `__lumen.cam([x,y,z],[tx,ty,tz])`.
- **Repère** :
  - Les calculs se font en Lambert-93 (EPSG:2154).
  - Le rendu se fait en repère local en mètres, avec l'origine sur l'adresse.
  - Formules : `x = X − X0` et `z = −(Y − Y0)` ; `y = altitude − alt0`.

## 2. Ce qui a été SUPPRIMÉ et pourquoi

Les fichiers supprimés sont :
- `habillage.ts`,
- `generateur/facades.js` et `generateur/commerces.js`, l'ancien générateur parisien,
- `photofacades.ts` et `photos.worker.ts`, des photos Panoramax projetées,
- les fenêtres procédurales du shader `matFacade`.

Le verdict du fondateur : **« un mélange médiocre, pas de vrais immeubles haussmanniens, des bugs d'affichage, des surfaces transparentes »**.

Les causes identifiées :
1. **Le style était tiré au hasard.** `styleDe(id, hauteur)` hachait l'identifiant pour choisir riche, classique, modeste ou moderne. Aucune donnée ne guidait le choix, ce qui donnait le patchwork incohérent.
2. **La grille de fenêtres était fausse.**
   - Elle utilisait des étages fixes de 3 m et des travées fixes de 3,1 m.
   - Elle ne suivait pas la hiérarchie haussmannienne : rez-de-chaussée plus entresol, étage noble, balcons filants au 2ᵉ et au 5ᵉ.
   - Le nombre d'étages et de travées ne correspondait pas au bâtiment réel.
3. **Il y avait deux systèmes superposés.**
   - D'un côté, des murs IGN extrudés avec fenêtres shader, rentrés de 0,8 m.
   - De l'autre, des façades générées posées devant.
   - Résultat : z-fighting, fentes, fenêtres doublées et décalées.
4. **Les photos Panoramax étaient projetées telles quelles.**
   - Arbres, voitures et passants étaient « peints » sur les murs.
   - La couverture était partielle.
   - La licence CC BY-SA crée un risque de partage à l'identique sur des textures commerciales.
5. **Des surfaces paraissaient transparentes.**
   - Le sens des faces était inversé : la normale ne sortait pas vers la rue, donc la face était culée.
   - `DoubleSide` était utilisé au hasard.
   - Des vitres étaient en `transparent: true` sans tri ni `depthWrite`.
   - Des plans coplanaires se battaient au z-buffer.

**L'état actuel est provisoire.** `apps/web/src/facadesNeutres.ts` ferme chaque façade sur rue avec un plan pierre uni, sans fenêtres. Les murs IGN sont des volumes neutres. **Ton moteur remplace `creerFacadesNeutres(taches)`.**

## 3. Ce qui fonctionne et que tu dois RÉUTILISER, pas réécrire

| Brique | Fichier | Rôle |
|---|---|---|
| `tachesFacades()` | `apps/web/src/main.ts` | Pour chaque arête BD TOPO à moins de 150 m, lit des profils LiDAR 50 cm perpendiculaires tous les ~2 m. Trouve la **vraie ligne du mur** (chute toit → sol) et la **vraie gouttière** (médianes). Ne garde que les façades sur rue ou cour (5 m dégagés devant). |
| `TacheFacade` | `facadesNeutres.ts` | Contrat d'entrée : `a`, `b` (repère local, normale sortante = (−dz, dx)), `y` (pied = **point haut** du trottoir), `socle` (rattrapage de pente), `hGout` (gouttière mesurée), `lod`. |
| `abaisserSousFacades()` | `main.ts` | Abaisse le LiDAR juste derrière la façade et le relève jusqu'à la gouttière, pour qu'il n'y ait pas de fente façade/toit. |
| `nettoyerBords()` | `main.ts` | Ramène au sol le LiDAR « bâtiment » hors des emprises IGN. Supprime les rideaux en dents de scie. |
| `creerDetailsToits()` | `toitures.ts` | Toits LiDAR fidèles : mansardes, cheminées mesurées, rideaux masqués. Ta façade doit **raccorder sa corniche** à ces toits. |
| `worker.ts` | | Grilles MNS 1 m et 50 cm, MNT 2 m (`solA` = cellule la plus proche, `solB` = **bilinéaire**, à utiliser). Trous nodata déjà bouchés par `boucherTrous`. |
| `plaques.ts` | | Numéros de rue BAN posés sur les façades. |
| `nuit.ts` | | Fenêtres éclairées la nuit selon un modèle horaire. Ton moteur doit exposer ses vitres pour ça. |
| `sol3d.ts`, `voirie3d.ts`, `arbres3d.ts`, `monuments.ts` | | Sol, trottoirs, arbres (inventaire Ville de Paris), monuments GLB. **Ne pas y toucher.** |
| `drone.ts` | | Vol libre et rechargement du quartier autour du drone. C'est ton outil d'inspection. |

## 4. Données disponibles (toutes compatibles avec un usage commercial — vérifie chaque licence)

- **IGN Géoplateforme** (Licence Ouverte 2.0) :
  - **BD TOPO bâtiment** (WFS) : emprise, hauteur, `nature`, `usage_1/2`, `nombre_d_etages`, `nombre_de_logements`, `date_d_apparition`, `materiaux_des_murs`, `materiaux_de_la_toiture`. **Vérifie quels champs sont réellement remplis à Paris.**
  - **LiDAR HD** : MNS et MNT 50 cm, nuage de points classé (sol, bâtiment, végétation). Le nuage permet de mesurer les **ressauts de façade** : balcons filants, corniches, bow-windows.
  - **BD ORTHO 20 cm** pour les toits.
  - **CoSIA** pour l'occupation du sol.
- **BDNB** (CSTB, open data) : année de construction, matériaux, nombre de niveaux par bâtiment, partout en France. **Vérifie la licence de la version ouverte.**
- **Paris Open Data / APUR** : période de construction, protections patrimoniales du PLU, volumes bâtis. Licence ODbL ou Licence Ouverte selon le jeu : vérifie.
- **Panoramax** (CC BY-SA 4.0) : photos de rue géolocalisées. Les utiliser **pour mesurer**, par exemple compter les travées, détecter les étages, les balcons et la couleur dominante. **Ne jamais les utiliser comme texture plaquée** sans validation juridique.
- **Textures** : Poly Haven et ambientCG (CC0). Pierre de taille, zinc, ardoise, ferronnerie peuvent aussi être générées procéduralement.
- **Interdit** : Google, Apple, Mapillary sous conditions restrictives, ou toute donnée qui bloquerait la commercialisation.

## 5. Ce que doit faire le moteur

### 5.1 Architecture imposée

1. **`packages/facades`** : du TypeScript pur, sans DOM ni Three.js, déterministe et testé. Il a trois parties :
   - **Classification** : `(données bâtiment) → Typologie + niveau de confiance + provenance`.
     - Typologies : haussmannien, post-haussmannien 1880-1914, faubourien pré-1850, Art nouveau/Art déco, brique HBM 1920-1939, années 50-70 (barres/tours), contemporain verre/métal, bureaux, équipement.
     - La décision repose sur la date, la hauteur, la forme du toit LiDAR (mansarde ⇒ écart haut/bas ≥ 2 m), le nombre d'étages, les matériaux et l'usage.
     - **Jamais sur un hasard.**
   - **Grammaire** : `(typologie, TacheFacade, mesures) → FacadeSpec`.
     - La FacadeSpec est un JSON qui contient les niveaux avec leurs hauteurs, les travées avec leurs largeurs, et les éléments : fenêtres, portes cochères, vitrines, balcons, corniches, bandeaux, refends, lucarnes.
     - Le nombre d'étages vient de la donnée (BD TOPO, BDNB ou `hGout` ÷ hauteurs typiques de la typologie).
     - Le nombre de travées vient de la largeur réelle, divisée par la largeur typique de travée (haussmannien ≈ 3,2–3,6 m d'axe en axe), arrondi.
   - **Provenance** : chaque valeur porte `source: mesure | photo | deduit | genere` (voir `ARCHITECTURE.md`).
2. **`apps/web/src/facades/`** : le *mesher* Three.js `FacadeSpec → géométrie`.
   - Les meshes sont fusionnés par matériau et par paquet, ou instanciés (fenêtres, garde-corps, consoles).
   - Il y a un budget de temps par image et 2 LOD minimum.
   - Les vitres sont exposées pour `nuit.ts`.

### 5.2 L'haussmannien, référence absolue

Il doit être reconnaissable au premier coup d'œil :
- **Rez-de-chaussée et entresol** : ~4–5,5 m, avec refends horizontaux en pierre, porte cochère, et commerces si `usage` le justifie.
- **2ᵉ étage noble** : balcon filant en fer forgé sur consoles, encadrements riches, plafond le plus haut (~3,2 m).
- **3ᵉ et 4ᵉ étages** : balconnets individuels et décor décroissant.
- **5ᵉ étage** : second balcon filant.
- **Corniche** à la hauteur `hGout` mesurée.
- **Combles en mansarde** : zinc et lucarnes. C'est le toit LiDAR de `toitures.ts` ; la façade s'arrête à la corniche et s'y raccorde.
- **Pierre de taille** : appareillage visible, teinte calcaire crème. La variation vient de la donnée et de l'âge, pas du hasard.
- **Les fenêtres sont des trous réels** : profondeur de tableau ~25–30 cm, garde-corps, volets ou persiennes métalliques. Ce n'est **pas** une texture peinte. L'ombre portée dans les tableaux compte pour le réalisme et pour le soleil.
- **Les travées sont alignées verticalement** sur tous les étages. Les axes de travée sont symétriques et centrés sur la façade.
- **Angle de rue** : pan coupé arrondi, avec un balcon filant qui fait le tour.

### 5.3 Les autres typologies

Chacune a sa grammaire dédiée, avec la même exigence de fidélité. Quand la confiance est faible, on utilise une façade **sobre et cohérente** de la typologie la plus probable, et on l'indique dans la provenance. Jamais un collage.

## 6. Les erreurs déjà rencontrées — INTERDITES

**Le sol et le relief**
1. **Le sol ne doit jamais arriver au niveau des fenêtres.**
   - Le pied de façade = le **point le plus haut** du profil du trottoir (MNT **bilinéaire** `solB`, échantillonné tous les mètres à 1,5 m devant la façade).
   - Un soubassement plein descend jusqu'au point bas.
   - Ne prends **jamais** l'altitude au milieu de la façade, au centroïde, ou sur la cellule MNT la plus proche.
   - Un NaN du MNT ne doit **jamais** retomber à `alt0`.
2. **Le fond de sol** ne doit pas être posé à l'altitude d'un coin de la bbox : il passerait au-dessus du sol en pente. Prends le minimum − 3 m.

**Les triangles et les rideaux**
3. **Gros triangles blancs** qui dépassent des bâtiments : ce sont des rideaux LiDAR, des marches du raster 50 cm étirées entre toit et sol.
   - Ne maille jamais le LiDAR bâtiment comme un champ de hauteur continu jusqu'au sol.
   - Utilise `nettoyerBords` et `abaisserSousFacades`, et masque les rideaux sous le haut des murs.
4. **Une seule surface par façade.**
   - Pas de mur IGN plus façade générée coplanaires : ça donne du z-fighting et des fentes.
   - Si ta façade existe, le mur IGN de ce côté est supprimé ou rentré **derrière, sans être visible**.
   - Les côtés non habillés (mitoyens, cours non détectées) restent des volumes neutres et propres.

**Les surfaces transparentes**
5. Pour chaque surface :
   - le winding doit être correct et la normale sortante vérifiée ;
   - pas de `DoubleSide` par facilité ;
   - les vitres sont **opaques** (sombres, réfléchissantes via env map et rugosité), jamais `transparent: true` ;
   - pas de faces dégénérées ;
   - utilise `polygonOffset` pour les décors plaqués.

**Les shaders**
6. **NaN dans les normales** donne des pixels noirs. Protège chaque `normalize`.
7. **Avec `onBeforeCompile`**, il faut toujours un `customProgramCacheKey`. Sinon des matériaux partagent le mauvais programme.

**Les données et les sources**
8. **Le style ne doit jamais être tiré au hasard** à partir d'un hash. Une variation aléatoire est permise *à l'intérieur* d'une typologie choisie par la donnée : teinte, ferronnerie, détails.
9. **L'orthophoto n'est pas une texture de sol sous les arbres** : elle peint les couronnes au sol. Même logique pour les photos de rue plaquées : arbres, voitures et gens deviennent des murs.

**Le repo et la mise en ligne**
10. **Les conversations parallèles cassent `main`** : moteurs en double, `main` qui ne compile plus, PR en conflit.
    - Une branche par étape, partie de `origin/main` à jour.
    - Ne modifie que tes fichiers, plus le point de branchement minimal dans `main.ts`.
    - Fais `git fetch` et `git rebase` avant chaque push.
    - Pas de force-push. Le fondateur merge lui-même.
11. **Les ids DOM doivent être uniques.** Un HUD et un bouton avec le même id ont rendu le bouton plein écran.
12. **La mise en ligne GitHub Pages peut échouer** de façon transitoire (« No artifacts named github-pages »). Après chaque merge, vérifie le site **en ligne** et relance le job si besoin. Ne dis pas « c'est le cache » sans avoir vérifié.

**Les performances mobiles**
13. Budget par image, fusion par matériau, instancing.
    - **Moins de 300 draw calls.**
    - **Moins de 1,5 M triangles** sur un rayon de 150 m sur iPhone.
    - Fabrication progressive sans saccade, LOD selon la distance.

## 7. Critères d'acceptation (à prouver avant de dire « fini »)

**Tests automatiques Vitest** dans `packages/facades` :
- Invariants :
  - aucune allège de fenêtre sous le sol (sur 100 % des façades testées, rues en pente comprises) ;
  - travées alignées ;
  - nombre d'étages égal à la donnée quand elle existe ;
  - aucune géométrie NaN ;
  - normales sortantes.
- Classification sur un jeu d'immeubles connus avec leur typologie attendue.

**Captures réelles** avec Playwright et Chrome headless.
- Passe par le proxy `HTTPS_PROXY`, **sans** `--ignore-certificate-errors`.
- Poses de caméra fixes via `__lumen.cam`.
- Adresses de référence :
  - 1 place du Panthéon (5ᵉ) ;
  - 8 rue Scribe, Opéra (9ᵉ) ;
  - 100 av. Victor-Hugo (16ᵉ) ;
  - 35 rue du Chevalier de la Barre, Montmartre en pente (18ᵉ) ;
  - un faubourg (11ᵉ) ;
  - une tour du 13ᵉ.
- Pour chacune : capture rue et capture drone, comparées à une photo Panoramax du même point de vue.
- Joins les captures à chaque PR.

**Zéro défaut visible** sur ces captures : triangle parasite, trou, surface transparente, sol aux fenêtres, z-fighting.

**Performance** mesurée en mode mobile : nombre d'i/s, draw calls, triangles et temps de fabrication, affichés dans le panneau ⚙.

## 8. Méthode de travail

1. Commence par un **audit court** de l'existant : `tachesFacades`, `toitures.ts`, `facadesNeutres.ts`. Fais aussi un **relevé réel** des champs BD TOPO et BDNB remplis sur les 6 adresses. Sans données, la conception n'est que supposition.
2. Livre **par étapes**, chacune avec sa PR et ses captures :
   - (a) classification et FacadeSpec avec tests ;
   - (b) mesher haussmannien, LOD0 et LOD1 ;
   - (c) raccord corniche/toit et suppression des murs IGN en double ;
   - (d) les autres typologies ;
   - (e) mesures Panoramax (comptage des travées et des étages) pour corriger la grammaire.
3. À chaque étape : `pnpm typecheck`, `pnpm test`, `VITE_MODE_DEV=1 pnpm build` et les captures. Ensuite seulement, la PR.
4. Réponses **très courtes** au fondateur, en français, avec le lien de la PR. Termine chaque message par 🔗 https://drz22k57j6-dot.github.io/LUMEN/
