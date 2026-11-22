# Moteur Interior — générateur d'appartement

**Étape 1 — plan 2D (sans 3D, sans adresse)** : bouton « Mon plan 2D » → importer son plan (photo/capture) et régler l'échelle sur une cote connue (📏), ou partir d'un modèle Studio / T2 / T3, ou dessiner → indiquer vers où regardent les fenêtres du côté bas (N, NE… NO) → l'orientation de chaque fenêtre s'affiche → « Enregistrer le plan ».

**Étape 2 — 3D (à refaire sur la version LiDAR)** : adresse → bâtiment → étage → façade → placer le plan au bon étage (`planVersLocal`, `genererVolumes`, `fenetresMonde` sont prêts dans packages/interior) → rapport par pièce (`ensoleillementPieceAnnuel` dans analysis). L'orientation réelle de la façade remplacera l'orientation saisie.

## Plan (packages/interior)
- Repère : `x` le long de la façade choisie, `y` profondeur vers l'intérieur (y = 0 = façade), `h` hauteur au-dessus du plancher. Grille 25 cm.
- Pièces = rectangles (axes des murs). Les murs sont déduits : 1 pièce sur un tronçon → mur extérieur (30 cm), 2 pièces → cloison (10 cm).
- Ouvertures (fenêtre 1,20 × 1,45, allège 0,90 ; porte-fenêtre 1,20 × 2,15) uniquement sur murs extérieurs. Portes intérieures (0,83 m) générées automatiquement.
- Provenance : dessin de l'utilisateur = `deduit` ; modèles et portes = `genere`.
- Ancrage : le parement extérieur du mur `bas` est aligné sur la façade touchée, plancher = sol IGN + étage × hauteur d'étage.

## Ensoleillement par pièce (packages/analysis)
- `ensoleillementPieceAnnuel` : chaque fenêtre échantillonnée en 3 points, 30 cm devant la façade ; à chaque pas, fraction éclairée = max sur les fenêtres ; minutes pondérées.
- Une fenêtre dont le point tombe dans l'emprise IGN du bâtiment est ignorée et signalée (pas sur une façade réelle).

## Limites connues / suite
- Pièces rectangulaires seulement (pas de L, pas de murs biais) ; façade supposée droite.
- Plan et image importée stockés dans le navigateur (localStorage) ; à migrer vers Supabase.
- Import PDF : pas encore (faire une capture d'écran du plan).
- Import RoomPlan/USDZ, rapport PDF, cas de validation terrain : à faire.

## Studio 3D (générateur d'appartement 3D multi-sources)
Bouton « Studio 3D » sur l'accueil, ou « Voir en 3D » depuis le plan 2D.
- **Sources** : plan 2D Lumen · image de plan (via l'éditeur 2D) · scan Apple RoomPlan (`CapturedRoom` en JSON : murs, portes, fenêtres, baies, sols, meubles, pièces) · scan 3D photo GLB/glTF/OBJ (USDZ texte seulement) affiché tel quel · plan d'architecte DXF (LINE/LWPOLYLINE, calques « mur/wall/cloison », unités $INSUNITS).
- **Modèle commun** (`packages/interior/src/modele.ts`) : murs à n'importe quel angle, ouvertures rattachées à un mur, pièces polygonales, meubles ; provenance par élément (scan = `mesure`).
- **Plan 2D éditable en profondeur** : choisir, déplacer les extrémités des murs (aimant 5 cm + coins), dessiner des murs (aimant orthogonal), poser/glisser fenêtres, portes-fenêtres, portes ; longueur, épaisseur, hauteur, intérieur/extérieur, couper, supprimer ; dimensions et allège des ouvertures ; type et nom des pièces ; pincer pour zoomer ; annuler.
- **Rendu** : parquet / carrelage / enduit procéduraux, plinthes, menuiseries, portes entrouvertes, vitrage, ciel physique, soleil réel (éphémérides) selon l'orientation, ombres douces, occlusion ambiante (GTAO, « Qualité Ultra »), maquette à murs coupés, visite à hauteur d'yeux (joystick sur iPhone, ZQSD sur ordinateur).
- **Limites** : USDZ binaire non lu (exporter en GLB) ; DXF sans fenêtres (à poser dans l'éditeur) ; pièces DXF seulement si calque « pièce/room » ; lieu du soleil = Paris tant que le logement n'est pas placé à son adresse (étape suivante).
