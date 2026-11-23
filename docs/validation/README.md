# Validation des ombres contre la photo aérienne IGN

**Résultat (23/11/2026, 4 sites de Paris, 400 × 400 m chacun, ~390 000 points de sol) :**

| Site | Heure du vol déduite | Accord des ombres (IoU) | Exactitude sol | IoU à −1 h / +1 h |
|---|---|---|---|---|
| Panthéon | 14:00 | 0,74 | 90,5 % | 0,48 / 0,60 |
| Opéra (rue Scribe) | 15:00 | 0,76 | 90,4 % | 0,51 / 0,59 |
| Bd Voltaire | 14:30 | 0,66 | 81,6 % | 0,48 / 0,54 |
| Rue de Rivoli | 14:55 | 0,78 | 90,5 % | 0,67 / 0,57 |
| **Moyenne** | | **0,74** | **88 %** | |

Repère : 36 à 50 % du sol est à l'ombre sur ces photos ; répondre « tout au soleil » donnerait 50 à 64 % d'exactitude.

## Méthode
- Ombres observées : pixels sombres (seuil d'Otsu) sur la BD ORTHO 20 cm (vol du 27/08/2024, graphe de mosaïquage IGN), au sol uniquement (LiDAR : MNS − MNT < 0,4 m), hors eau (CoSIA), à plus de 4 m des immeubles et arbres.
- Ombres calculées : même principe que Lumen — rayon vers le soleil (NREL SPA) sur le LiDAR HD MNS 50 cm.
- L'heure du vol n'est pas publiée : c'est la **seule inconnue**, ajustée par site (pas de 5 min). Les 4 heures trouvées (14:00–15:00) sont cohérentes avec un vol d'après-midi.

## Limites (à dire honnêtement)
- Une inconnue (l'heure) est ajustée : le chiffre est un peu optimiste.
- La BD ORTHO n'est pas une « vraie ortho » : les immeubles penchent de quelques mètres, d'où l'exclusion des 4 m au pied des murs.
- Les ombres d'arbres, de voitures et de mobilier sur la photo ne sont pas toutes dans le modèle (en bleu sur l'image de contrôle).
- Valide les ombres au sol, pas encore l'ensoleillement à l'intérieur d'une pièce (vidéos réelles nécessaires).

Image de contrôle : vert = accord, rouge = ombre calculée seule, bleu = ombre de la photo seule.

Relancer : `python3 ombres_orthophoto.py '[["Pantheon",651983,6860854]]'` (pvlib, pyproj, scikit-image, scipy, pandas, pillow).
