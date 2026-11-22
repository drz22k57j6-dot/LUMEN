# Lumen — Architecture

SaaS : visualiser un logement en 3D dans son vrai quartier et produire un rapport d'ensoleillement précis par pièce.

## Principes
1. **La précision avant la beauté** : un pixel joli mais faux ne sert à rien.
2. **Provenance partout** : chaque donnée porte `source` = `mesure | photo | deduit | genere` + `origine` (ex. `IGN BD TOPO`). On n'affiche jamais une donnée générée comme réelle.
3. **Moteurs indépendants** : chaque moteur est un package testable seul, sans dépendre du rendu.
4. **Web d'abord**, iPhone ensuite (le scan RoomPlan nécessite Mac + Xcode).
5. **Mobile-first** : tout doit tourner sur Safari iPhone.

## Structure du repo
```
lumen/
├─ apps/
│  ├─ web/            # Plateforme web (Vite + TypeScript + Three.js)
│  └─ ios/            # (plus tard) App de scan Swift/RoomPlan
├─ packages/
│  ├─ core/           # Types communs, coordonnées, provenance
│  ├─ urban/          # Adresse → bâtiments, relief, végétation
│  ├─ building/       # Étages, façades, toits, fenêtres
│  ├─ interior/       # Plan 2D, import USDZ/JSON, génération 3D
│  ├─ analysis/       # Soleil, masques, heures d'ensoleillement, rapport
│  └─ render/         # Scène Three.js, matériaux, ciel, ombres
├─ docs/              # Décisions, validations, sources
└─ prompts/A_FAIRE.md # Tâches pour l'agent de code
```

## Les 4 moteurs
| Moteur | Entrée | Sortie | Sources |
|---|---|---|---|
| **Urban** | adresse | emprises + hauteurs des bâtiments, relief, arbres (rayon 300–500 m) | Géoplateforme : géocodage, BD TOPO (WFS), LiDAR HD (MNS/MNT/MNH) |
| **Building** | bâtiment + étage | volume, toit, façades orientées, fenêtres | BD TOPO, LiDAR HD (toits), Panoramax (photos rue) |
| **Interior** | plan / USDZ / builder | pièces, murs, ouvertures, logement 3D | saisie, RoomPlan (via Polycam / 3D Scanner App) |
| **Analysis** | fenêtres + MNS | minutes de soleil direct sur 365 jours, cause des ombres (bâti, arbres, relief) ; rapport PDF | VSOP87, lancer de rayons sur le MNS LiDAR HD 50 cm |

## Modèle de données (core)
```
Adresse ─ Batiment(id BD TOPO) ─ Etage(n, altitude_plancher)
   └─ Logement ─ Piece(type, surface) ─ Ouverture(type, largeur, hauteur,
                                         allege, position, normale/azimut)
Chaque champ : { valeur, source, origine, precision_m? }
```
Repère : Lambert-93 (EPSG:2154) pour les calculs, converti en repère local (mètres, origine = bâtiment) pour le rendu.

## Calcul d'ensoleillement (Analysis)
1. Position du soleil : éphémérides VSOP87 (astronomy-engine, précision < 1″), réfraction incluse.
2. Pour chaque fenêtre, on échantillonne des points (grille 3×3), puis on trace un rayon vers le soleil toutes les 10 min, sur 12 jours types (le 21 de chaque mois).
3. Un rayon est bloqué par : les bâtiments voisins, le relief, les arbres (MNH, avec transparence selon la saison), le propre bâtiment (tableau de fenêtre, balcon).
4. Sortie : minutes de soleil direct par jour et par pièce, plages horaires, synthèse par saison.
5. **Validation obligatoire** : comparer avec des vidéos réelles (heure d'entrée/sortie du soleil). Cible : ±15 min.

## Interfaces
- **Web** : recherche d'adresse → quartier 3D → choix du bâtiment, de l'étage et de la façade → plan → rapport.
- **iOS (plus tard)** : scan RoomPlan → USDZ + JSON → envoi au serveur.

## Passage à l'échelle (France entière)
- **Pipeline de tuiles (serveur, hors ligne)** : LiDAR HD + BD TOPO → maillages simplifiés en tuiles glTF/3D Tiles de 1 km², 3 niveaux de détail, stockées sur un CDN (Cloudflare R2). Le client ne fait qu'afficher.
- **Calcul solaire côté serveur** pour les rapports officiels (déterministe, versionné) ; calcul côté client pour l'aperçu temps réel.
- **Cache** : le résultat est indexé par (bâtiment, étage, fenêtre, version du moteur, version des données).

## API B2B (avantage durable)
```
POST /v1/ensoleillement  { adresse, etage, fenetres[] } → { heures_par_mois, plages, precision }
GET  /v1/rapports/{id}.pdf
```
Clés API par client, quotas, webhooks. Les portails et réseaux d'agences s'intègrent sans passer par l'interface.

## Précision = métrique publique
- `docs/validation/` : base de cas réels (vidéo + heure + fenêtre + résultat attendu).
- Les tests automatiques (CI) recalculent tous les cas à chaque PR ; une PR qui dégrade l'écart moyen est bloquée.
- SPA testé contre les valeurs de référence NOAA.
- Le rapport affiche sa marge d'erreur.

## Socle SaaS
- Auth + organisations multi-agences (Supabase), paiement Stripe (à l'acte + abonnement).
- Observabilité : Sentry (erreurs), journaux structurés.
- CI/CD : GitHub Actions (lint, types, tests, validation, déploiement).
- TypeScript strict, monorepo pnpm, tests Vitest.

## Données et conformité
- Chaque jeu de données est versionné (date de vol LiDAR, millésime BD TOPO) et figure dans le rapport.
- Mention « IGN » obligatoire (Licence Ouverte 2.0).
- Zones ZICAD (pas de LiDAR publié) : repli sur BD TOPO avec la précision dégradée affichée.
- RGPD : les adresses des clients sont des données personnelles ; hébergement en UE.

## Hébergement
- MVP : statique sur GitHub Pages ; les API IGN sont appelées depuis le navigateur.
- V1 : Vercel (web) + Supabase (base, auth) + R2 (tuiles) + worker de calcul (Fly.io), tout en UE.

## Roadmap
| Semaine | Livrable |
|---|---|
| 1 | Quartier 3D depuis une adresse + soleil temps réel + ombres |
| 2 | Choix étage/façade/fenêtre + heures de soleil calculées |
| 3 | Validation terrain (5 fenêtres réelles) |
| 4 | Plan 2D simple + rapport PDF par pièce |
| 5–6 | Toits LiDAR, fenêtres réelles, rendu ×10, import USDZ |
| 7–8 | Test avec 10 agents immobiliers |
