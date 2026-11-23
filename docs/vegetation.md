# Moteur Végétation (arbres)

**Où** : `packages/vegetation` (données, phénologie, détection LiDAR — sans rendu) · `apps/web/src/arbres3d.ts` (rendu) · `packages/analysis/src/grille.ts` (soleil à travers les arbres).

## Données
- **Position, hauteur, couronne** : sommets de couronne détectés dans le LiDAR HD IGN (maxima locaux du modèle de hauteur de la végétation, rayon mesuré sur 8 directions) → partout en France.
- **Espèce** : inventaire open data de la Ville de Paris (« Les arbres » : genre, espèce, hauteur, circonférence) recalé sur le sommet LiDAR le plus proche (< 3 m). Hors Paris : « feuillu » générique (à enrichir avec OSM).
- Provenance : hauteur et couronne `mesure` (LiDAR) quand recalées, sinon inventaire / `deduit`.

## Phénologie (22 espèces)
Débourrement, vert tendre, floraison (cerisier, magnolia, paulownia avant les feuilles ; marronnier, tilleul, robinier, sophora), feuillage d'été, coloration d'automne feuille par feuille avec la palette de l'espèce (érable rouge, ginkgo jaune, copalme pourpre…), chute, branches nues. Persistants (pins, conifères) toujours verts. Chaque arbre a un décalage individuel de ± 6 jours.

## Soleil
Le calcul d'ensoleillement traite la végétation comme semi-transparente (loi de Beer-Lambert) avec l'atténuation du jour de l'année, moyennée sur les espèces à moins de 80 m de la fenêtre : un platane nu en décembre laisse passer le soleil, pas en juillet.

## Rendu
Squelette procédural par forme (étalée, ronde, ovoïde, colonne, conique, parasol, pleureur), cartes de feuillage texturées, instanciation par espèce, 2 niveaux de détail, ombres portées avec les trous du feuillage. Le LiDAR « végétation » du relief est ramené au sol et remplacé par les arbres 3D.

## Limites
Phénologie moyenne (pas d'année réelle) ; espèce inconnue hors Paris ; formes procédurales (pas de modèle par arbre).
