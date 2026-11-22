# Façades et voirie AAA

Repris de limoges-3d (dernière version : `moteur_facades` v3 du 20/11/2026, branche feat/appart-studio-lidar-real-roofs) et branché sur les vrais bâtiments IGN de Lumen.

## Façades (`apps/web/src/habillage.ts` + `src/moteurs/facades/`)
- Façades sur rue détectées automatiquement : arête du contour BD TOPO ≥ 4 m dont l'extérieur (1,5 m et 4 m devant, et aux deux bouts) n'est pas un autre bâtiment.
- Immeuble procédural en vrai relief à la longueur réelle et à la hauteur de gouttière IGN (`altitude_minimale_toit`) : trumeaux, fenêtres en creux, balcons en fonte, corniches, toit mansardé, lucarnes, descentes d'eau, portes cochères, commerces, usure.
- Style choisi par bâtiment (graine = identifiant IGN) : > 27 m moderne, < 11 m faubourien, sinon haussmannien classique / riche / modeste.
- Rayon : 170 m (110 m sur téléphone), détail complet à 70 m (45 m). Construction étalée sur plusieurs images puis fusion par matériau.
- Volume IGN des bâtiments habillés rentré de 0,6 m et arrêté sous le toit.
- Provenance : géométrie des façades **générée** (pas relevée) ; emprise et hauteur **mesurées** (IGN).

## Voirie (`apps/web/src/voirie3d.ts`)
- Photos de matières Poly Haven (CC0) en 1k (chaussée, trottoir, bordure granit, pavés du caniveau), échantillonnage sans répétition visible, mélangées aux détails procéduraux existants (reprises, huile, joints, usure).

## Suite possible
Lampadaires (`lampadaires.js` dans limoges-3d) le long des trottoirs, commerces réels (BDCOM/OSM), quartiers non parisiens (styles régionaux).
