# Sol reconstruit (zone détaillée)

La photo aérienne n'est plus affichée au sol dans la zone détaillée : elle contient le dessus des arbres, les voitures et les ombres. Le sol est reconstruit en matières physiques (`apps/web/src/sol.ts`), la photo reste sur les toits et au loin.

## Données (toutes compatibles avec un usage commercial)
| Donnée | Rôle | Licence |
|---|---|---|
| IGN CoSIA (couverture du sol par IA, 20 cm) | imperméable, perméable (allées), pelouse, sol nu, eau, bâti, végétation | Licence Ouverte 2.0 |
| OpenStreetMap (si joignable) | pavés, stabilisé, terre, eau | ODbL : œuvre produite, mention « © contributeurs OpenStreetMap » ; la base n'est pas redistribuée |
| Poly Haven (enrobé, pavés, sable stabilisé, pelouse, terre, litière) | matières photo 1k (couleur, rugosité, normales) | CC0 |

## Méthode
1. Sous les couronnes (CoSIA ne voit que le feuillage) : le sol est celui du voisinage le plus proche (trottoir sous un platane, sable sous les marronniers du Luxembourg) ; au cœur d'un vrai bois (> 25 m de tout sol visible) : litière.
2. Carte de poids (8 canaux, 0,5 m, adoucie) → matériau du relief : mélange par hauteur, anti-répétition, macro-variations, normales et rugosité, salissure au pied des murs, eau sombre et lisse.
3. Repli automatique sur la photo aérienne si CoSIA est indisponible.

## Corrigé au passage
Le fond sous le relief était posé à l'altitude d'un coin de la zone : en pente (Luxembourg plus bas que la rue), il recouvrait le sol. Il est maintenant sous le point le plus bas.

## Suite
Pavés sur la chaussée elle-même (le maillage de voirie a son propre matériau) ; dalles de granit des places ; feuilles mortes saisonnières sous les arbres.
