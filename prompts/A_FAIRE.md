# À FAIRE — Semaine 1

Lis d'abord `ARCHITECTURE.md` et respecte-la. Une PR par tâche, sur la branche `semaine-1`. TypeScript strict. Chaque tâche est terminée seulement quand ses critères sont vérifiés.

## T0 — Socle du monorepo
- pnpm workspaces : `apps/web` (Vite + TS + Three.js), `packages/core`, `urban`, `analysis`, `render`.
- ESLint, Prettier, Vitest, GitHub Actions (lint + types + tests), déploiement de `apps/web` sur GitHub Pages.
- **Critère** : `pnpm test` passe en CI ; la page est en ligne sur Pages.

## T1 — core : types + provenance
- Types `Adresse`, `Batiment`, `Etage`, `Ouverture` ; type générique `Donnee<T> = { valeur, source: 'mesure'|'photo'|'deduit'|'genere', origine, precision_m? }`.
- Conversion WGS84 ↔ Lambert-93 (proj4) ↔ repère local en mètres.
- **Critère** : tests de conversion à moins de 1 cm près sur 3 points de référence IGN.

## T2 — analysis : position du soleil (NREL SPA)
- Implémenter SPA (azimut, élévation, lever/coucher) en TS pur, sans dépendance au rendu.
- **Critère** : écart < 0,01° avec les valeurs NOAA sur 20 cas (Paris, Limoges, Marseille ; solstices et équinoxes ; plusieurs heures).

## T3 — urban : adresse → bâtiments
- Géocodage via le service de géocodage de la Géoplateforme (data.geopf.fr).
- Bâtiments BD TOPO via WFS Géoplateforme dans un rayon de 300 m : emprise + `hauteur` + altitudes min/max du toit.
- Mise en cache dans IndexedDB.
- **Critère** : pour « 1 place du Panthéon, Paris », le bâtiment principal est trouvé avec sa hauteur ; temps < 3 s en 4G.

## T4 — render : quartier 3D + soleil + ombres
- Extrusion des emprises à la bonne hauteur, sol au relief (MNT LiDAR HD si disponible, sinon plat).
- Lumière directionnelle positionnée par T2, ombres en cascade, ciel qui suit le soleil.
- Interface : champ adresse, curseur date, curseur heure, bouton lecture (journée en accéléré).
- **Critère** : 30 i/s minimum sur iPhone 13 (Safari) ; les ombres tournent correctement au fil de la journée.

## T5 — sélection bâtiment / étage / façade
- Toucher un bâtiment → le surligner ; choisir l'étage (hauteur 3 m par défaut, modifiable) ; toucher une façade → afficher son azimut.
- Placer un point fenêtre sur la façade à l'étage choisi.
- **Critère** : l'azimut affiché correspond à l'orientation réelle de la façade (vérifié sur 3 bâtiments).

## T6 — heures de soleil d'une fenêtre (premier calcul)
- Pour le point fenêtre : rayon vers le soleil toutes les 10 min, le 21 de chaque mois, bloqué par les bâtiments voisins (Three.js Raycaster + BVH via `three-mesh-bvh`).
- Ignorer le soleil derrière la façade (angle > 90° par rapport à la normale).
- Afficher : minutes de soleil direct par mois + plages horaires, avec la provenance des données.
- **Critère** : le résultat est reproductible et testé ; un cas de validation est ajouté dans `docs/validation/`.
