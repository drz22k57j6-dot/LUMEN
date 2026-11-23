/**
 * Moteur Végétation — espèces, phénologie (feuillage selon la date) et sources d'arbres.
 * Pur TypeScript, sans rendu : utilisé par le rendu 3D ET par le calcul d'ensoleillement.
 *
 * Phénologie calée sur le climat parisien (jours de l'année, moyenne 2000-2020 ; décalages ± quelques jours
 * par arbre). Sources : calendriers phénologiques (Observatoire des Saisons / TEMPO, Tela Botanica),
 * guides des arbres d'alignement de la Ville de Paris. Ordres de grandeur, pas des mesures individuelles.
 */
import type { Donnee, XY } from '@lumen/core';

export type Forme = 'ovoide' | 'ronde' | 'etalee' | 'colonne' | 'conique' | 'parasol' | 'pleureur';

export interface Espece {
  id: string;
  nom: string;
  forme: Forme;
  persistant: boolean;
  /** Jours de l'année : débourrement, feuillage complet, début de coloration, chute terminée. */
  pheno: [number, number, number, number];
  printemps: number; // couleur des jeunes feuilles
  ete: number;
  automne: number[]; // palette d'automne (mélange)
  /** Floraison : [début, fin] (jour de l'année) et couleur, si spectaculaire. */
  fleurs?: { debut: number; fin: number; couleur: number; avantFeuilles?: boolean };
  ecorce: number;
  /** Écorce en plaques (platane). */
  plaques?: boolean;
  /** Densité du feuillage en été (0..1) — sert à l'atténuation du soleil. */
  densite: number;
  /** Rapport rayon de couronne / hauteur (adulte, taille urbaine). */
  rayonSurHauteur: number;
  /** Hauteur du fût sous couronne / hauteur. */
  fut: number;
}

const E = (e: Espece) => e;
export const ESPECES: Record<string, Espece> = {
  platane: E({ id: 'platane', nom: 'Platane', forme: 'etalee', persistant: false, pheno: [105, 130, 280, 335], printemps: 0x9fbf5a, ete: 0x4f7a32, automne: [0xc9a24a, 0xa8793a, 0x8c6a3c], ecorce: 0xb9b39a, plaques: true, densite: 0.85, rayonSurHauteur: 0.32, fut: 0.3 }),
  marronnier: E({ id: 'marronnier', nom: 'Marronnier', forme: 'ronde', persistant: false, pheno: [90, 115, 245, 310], printemps: 0x9cc25a, ete: 0x3f6b2a, automne: [0xb8742e, 0x9a5a28, 0xc99a3c], fleurs: { debut: 105, fin: 135, couleur: 0xf4f0e6 }, ecorce: 0x5a5048, densite: 0.95, rayonSurHauteur: 0.36, fut: 0.25 }),
  tilleul: E({ id: 'tilleul', nom: 'Tilleul', forme: 'ovoide', persistant: false, pheno: [100, 125, 265, 315], printemps: 0xa8c95e, ete: 0x4c7a30, automne: [0xd8b44a, 0xc9a43c], fleurs: { debut: 165, fin: 185, couleur: 0xe8e0a0 }, ecorce: 0x6a6258, densite: 0.9, rayonSurHauteur: 0.3, fut: 0.25 }),
  erable: E({ id: 'erable', nom: 'Érable', forme: 'ronde', persistant: false, pheno: [95, 120, 270, 320], printemps: 0xa3c75a, ete: 0x4e7c32, automne: [0xd9542a, 0xe8a33a, 0xc23a22, 0xf0c24a], ecorce: 0x6e665c, densite: 0.85, rayonSurHauteur: 0.32, fut: 0.25 }),
  sophora: E({ id: 'sophora', nom: 'Sophora', forme: 'etalee', persistant: false, pheno: [120, 145, 285, 330], printemps: 0xa8c862, ete: 0x5a8a3a, automne: [0xd4c04a, 0xb8a03c], fleurs: { debut: 200, fin: 225, couleur: 0xf2ecc8 }, ecorce: 0x5e564c, densite: 0.7, rayonSurHauteur: 0.36, fut: 0.3 }),
  frene: E({ id: 'frene', nom: 'Frêne', forme: 'ovoide', persistant: false, pheno: [115, 140, 280, 320], printemps: 0xa6c860, ete: 0x4f7c36, automne: [0xc8b84a, 0x9c8a3c], ecorce: 0x8a8478, densite: 0.65, rayonSurHauteur: 0.28, fut: 0.3 }),
  prunus: E({ id: 'prunus', nom: 'Cerisier / prunier', forme: 'ronde', persistant: false, pheno: [100, 120, 260, 310], printemps: 0x8fb85a, ete: 0x4a7030, automne: [0xc4462a, 0xe07a34, 0x9a2e2a], fleurs: { debut: 85, fin: 112, couleur: 0xf6c8d8, avantFeuilles: true }, ecorce: 0x5a3a34, densite: 0.75, rayonSurHauteur: 0.42, fut: 0.3 }),
  micocoulier: E({ id: 'micocoulier', nom: 'Micocoulier', forme: 'ovoide', persistant: false, pheno: [110, 135, 290, 330], printemps: 0xa2c45c, ete: 0x4d7a34, automne: [0xd6c24c, 0xb8a03a], ecorce: 0x7c7a72, densite: 0.8, rayonSurHauteur: 0.3, fut: 0.3 }),
  poirier: E({ id: 'poirier', nom: 'Poirier', forme: 'colonne', persistant: false, pheno: [95, 115, 285, 335], printemps: 0x98c058, ete: 0x3f6a2c, automne: [0xc43a2a, 0x9a2a22, 0xd8822e], fleurs: { debut: 85, fin: 105, couleur: 0xfafaf4, avantFeuilles: true }, ecorce: 0x4e4640, densite: 0.85, rayonSurHauteur: 0.2, fut: 0.25 }),
  chene: E({ id: 'chene', nom: 'Chêne', forme: 'etalee', persistant: false, pheno: [110, 135, 290, 340], printemps: 0xb0c868, ete: 0x445f2a, automne: [0xa8743a, 0x8a5a2e, 0xc29a4a], ecorce: 0x5c554c, densite: 0.85, rayonSurHauteur: 0.36, fut: 0.3 }),
  bouleau: E({ id: 'bouleau', nom: 'Bouleau', forme: 'ovoide', persistant: false, pheno: [95, 115, 265, 310], printemps: 0xb8d06a, ete: 0x5c8a3a, automne: [0xe8c84a, 0xd8b03c], ecorce: 0xe8e4dc, densite: 0.55, rayonSurHauteur: 0.22, fut: 0.25 }),
  charme: E({ id: 'charme', nom: 'Charme', forme: 'ovoide', persistant: false, pheno: [100, 125, 280, 330], printemps: 0xa4c85e, ete: 0x4a7a30, automne: [0xd8b84a, 0xb8903a], ecorce: 0x7a7a74, densite: 0.9, rayonSurHauteur: 0.28, fut: 0.2 }),
  orme: E({ id: 'orme', nom: 'Orme', forme: 'etalee', persistant: false, pheno: [100, 125, 280, 325], printemps: 0xa2c45a, ete: 0x456f2c, automne: [0xd4b84a, 0xb89a3c], ecorce: 0x5a524a, densite: 0.85, rayonSurHauteur: 0.34, fut: 0.3 }),
  robinier: E({ id: 'robinier', nom: 'Robinier', forme: 'ovoide', persistant: false, pheno: [120, 140, 280, 320], printemps: 0xb0cc66, ete: 0x5a8638, automne: [0xd8cc4c], fleurs: { debut: 135, fin: 155, couleur: 0xf6f2e8 }, ecorce: 0x5e5448, densite: 0.6, rayonSurHauteur: 0.3, fut: 0.3 }),
  paulownia: E({ id: 'paulownia', nom: 'Paulownia', forme: 'etalee', persistant: false, pheno: [125, 150, 285, 320], printemps: 0x9cc05a, ete: 0x4a7632, automne: [0x8a7a3a, 0x6a5a34], fleurs: { debut: 105, fin: 135, couleur: 0xb8a0d8, avantFeuilles: true }, ecorce: 0x6a645c, densite: 0.75, rayonSurHauteur: 0.38, fut: 0.3 }),
  ginkgo: E({ id: 'ginkgo', nom: 'Ginkgo', forme: 'conique', persistant: false, pheno: [105, 130, 300, 330], printemps: 0xb4d06a, ete: 0x6a9a40, automne: [0xf2d23a, 0xeac832], ecorce: 0x6a6258, densite: 0.6, rayonSurHauteur: 0.22, fut: 0.2 }),
  liquidambar: E({ id: 'liquidambar', nom: 'Copalme', forme: 'conique', persistant: false, pheno: [110, 135, 285, 335], printemps: 0xa4c45c, ete: 0x3f6e2e, automne: [0xb82a2a, 0x7a1e34, 0xe0782e, 0xd8a43a], ecorce: 0x5a5048, densite: 0.85, rayonSurHauteur: 0.24, fut: 0.2 }),
  ailante: E({ id: 'ailante', nom: 'Ailante', forme: 'etalee', persistant: false, pheno: [120, 145, 280, 315], printemps: 0xa8b85a, ete: 0x4f7a32, automne: [0xc8b44a], ecorce: 0x8a8478, densite: 0.6, rayonSurHauteur: 0.34, fut: 0.3 }),
  magnolia: E({ id: 'magnolia', nom: 'Magnolia', forme: 'ronde', persistant: false, pheno: [105, 125, 290, 330], printemps: 0x98bc58, ete: 0x3e6a2c, automne: [0xb89a4a, 0x8a6a3a], fleurs: { debut: 80, fin: 105, couleur: 0xf2d6e2, avantFeuilles: true }, ecorce: 0x8a8478, densite: 0.8, rayonSurHauteur: 0.4, fut: 0.2 }),
  saule: E({ id: 'saule', nom: 'Saule', forme: 'pleureur', persistant: false, pheno: [80, 105, 290, 335], printemps: 0xc0d872, ete: 0x7a9a48, automne: [0xd8c85a], ecorce: 0x6a6052, densite: 0.6, rayonSurHauteur: 0.4, fut: 0.25 }),
  pin: E({ id: 'pin', nom: 'Pin', forme: 'parasol', persistant: true, pheno: [0, 0, 400, 400], printemps: 0x4a6a3a, ete: 0x3e5e32, automne: [0x3e5e32], ecorce: 0x7a5a44, densite: 0.75, rayonSurHauteur: 0.3, fut: 0.45 }),
  conifere: E({ id: 'conifere', nom: 'Conifère', forme: 'conique', persistant: true, pheno: [0, 0, 400, 400], printemps: 0x3e5a34, ete: 0x34502e, automne: [0x34502e], ecorce: 0x5a4434, densite: 0.95, rayonSurHauteur: 0.22, fut: 0.1 }),
  feuillu: E({ id: 'feuillu', nom: 'Feuillu', forme: 'ovoide', persistant: false, pheno: [100, 125, 280, 325], printemps: 0xa4c45c, ete: 0x4b7832, automne: [0xd4a63e, 0xb8783a, 0xc8b04a], ecorce: 0x625a50, densite: 0.85, rayonSurHauteur: 0.3, fut: 0.25 }),
};

/** Genre botanique (latin, données Paris / OSM) → espèce du catalogue. */
const GENRES: Record<string, string> = {
  platanus: 'platane', aesculus: 'marronnier', tilia: 'tilleul', acer: 'erable', sophora: 'sophora', styphnolobium: 'sophora',
  fraxinus: 'frene', prunus: 'prunus', malus: 'prunus', celtis: 'micocoulier', pyrus: 'poirier', quercus: 'chene', betula: 'bouleau',
  carpinus: 'charme', ulmus: 'orme', zelkova: 'orme', robinia: 'robinier', gleditsia: 'robinier', paulownia: 'paulownia', ginkgo: 'ginkgo',
  liquidambar: 'liquidambar', ailanthus: 'ailante', magnolia: 'magnolia', salix: 'saule', pinus: 'pin', cedrus: 'conifere', taxus: 'conifere',
  abies: 'conifere', picea: 'conifere', thuja: 'conifere', cupressus: 'conifere', sequoiadendron: 'conifere', metasequoia: 'liquidambar',
  catalpa: 'paulownia', koelreuteria: 'sophora', alnus: 'bouleau', populus: 'frene', corylus: 'charme', fagus: 'charme',
  cercis: 'prunus', crataegus: 'poirier', sorbus: 'frene', parrotia: 'liquidambar', juglans: 'frene', morus: 'micocoulier',
};
export const especeDuGenre = (genre?: string | null) => ESPECES[GENRES[(genre ?? '').toLowerCase().trim()] ?? 'feuillu']!;

// --- Phénologie ------------------------------------------------------------------

export interface EtatFeuillage {
  /** Part des feuilles présentes (0 = nu, 1 = pleine feuillaison). */
  feuilles: number;
  /** Couleur moyenne du feuillage (0xRRGGBB) et part « automne » (0..1) pour mélanger la palette. */
  couleur: number;
  automne: number;
  /** Part de fleurs (0..1) et couleur. */
  fleurs: number;
  couleurFleurs: number;
  /** Atténuation du soleil par mètre traversé dans la couronne (loi de Beer-Lambert). */
  attenuation: number;
}

export const jourAnnee = (d: Date) => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5);
const lisse = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const melange = (c1: number, c2: number, t: number) => {
  const r = ((c1 >> 16) & 255) * (1 - t) + ((c2 >> 16) & 255) * t;
  const g = ((c1 >> 8) & 255) * (1 - t) + ((c2 >> 8) & 255) * t;
  const b = (c1 & 255) * (1 - t) + (c2 & 255) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
};

/** État du feuillage d'une espèce à un jour de l'année (décalage = variation individuelle en jours). */
export function feuillage(e: Espece, jour: number, decalage = 0): EtatFeuillage {
  const j = jour - decalage;
  const [deb, plein, coul, chute] = e.pheno;
  let feuilles = 1, automne = 0, couleur = e.ete;
  if (!e.persistant) {
    const pousse = lisse(deb, plein, j);
    const fin = 1 - lisse(coul + (chute - coul) * 0.45, chute, j);
    feuilles = Math.min(pousse, fin);
    automne = lisse(coul, coul + (chute - coul) * 0.6, j);
    const jeunes = 1 - lisse(plein, plein + 25, j); // vert tendre des jeunes feuilles
    couleur = melange(melange(e.ete, e.printemps, jeunes), e.automne[0]!, automne);
  }
  let fleurs = 0;
  if (e.fleurs) {
    const { debut, fin } = e.fleurs;
    fleurs = Math.min(lisse(debut, debut + 6, j), 1 - lisse(fin - 6, fin, j));
  }
  // Branches seules : ~0,06 /m ; feuillage complet : jusqu'à ~0,6 /m selon la densité.
  const attenuation = 0.06 + 0.55 * e.densite * feuilles + 0.15 * fleurs;
  return { feuilles, couleur, automne, fleurs, couleurFleurs: e.fleurs?.couleur ?? 0xffffff, attenuation };
}

/** Atténuation moyenne d'un mélange d'espèces (poids = nombre d'arbres), par jour de l'année. */
export function attenuationMoyenne(compte: Record<string, number>): (jour: number) => number {
  const items = Object.entries(compte).filter(([, n]) => n > 0);
  const total = items.reduce((s, [, n]) => s + n, 0);
  if (!total) return (j) => feuillage(ESPECES.feuillu!, j).attenuation;
  return (j) => items.reduce((s, [id, n]) => s + feuillage(ESPECES[id] ?? ESPECES.feuillu!, j).attenuation * n, 0) / total;
}

// --- Arbres ------------------------------------------------------------------------

export interface Arbre {
  id: string;
  /** Position (Lambert-93). */
  p: XY;
  espece: string;
  nomLocal?: string;
  hauteur: Donnee<number>;
  rayonCouronne: Donnee<number>;
  /** Décalage phénologique individuel (jours), déterministe. */
  decalage: number;
}

const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
export const decalageDe = (id: string) => ((hash(id) % 1000) / 1000 - 0.5) * 12;

/** Enregistrement du jeu de données « Les arbres » (Ville de Paris, open data). */
export interface ArbreParis {
  idbase: number;
  libellefrancais?: string | null;
  genre?: string | null;
  espece?: string | null;
  hauteurenm?: number | null;
  circonferenceencm?: number | null;
  stadedeveloppement?: string | null;
  geo_point_2d: { lon: number; lat: number };
}

/** URL de l'export (sans limite de nombre) des arbres de Paris dans un rayon. */
export const urlArbresParis = (lon: number, lat: number, rayon: number) =>
  `https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/les-arbres/exports/json?select=idbase,libellefrancais,genre,espece,hauteurenm,circonferenceencm,stadedeveloppement,geo_point_2d&where=${encodeURIComponent(`within_distance(geo_point_2d, geom'POINT(${lon} ${lat})', ${Math.round(rayon)}m)`)}`;

/** Arbre parisien → arbre Lumen (hauteur et couronne : inventaire, à recaler ensuite sur le LiDAR). */
export function depuisParis(a: ArbreParis, versL93: (lon: number, lat: number) => XY): Arbre | null {
  if (!a.geo_point_2d) return null;
  const e = especeDuGenre(a.genre);
  const id = `paris-${a.idbase}`;
  let h = a.hauteurenm ?? 0;
  const circ = a.circonferenceencm ?? 0;
  if (!(h > 1 && h < 45)) h = circ > 0 ? Math.min(30, 3 + circ / 9) : 8; // hauteur absente ou aberrante : déduite du tronc
  const r = Math.max(1, h * e.rayonSurHauteur * (a.stadedeveloppement?.startsWith('Jeune') ? 0.8 : 1));
  return {
    id, p: versL93(a.geo_point_2d.lon, a.geo_point_2d.lat), espece: e.id, nomLocal: a.libellefrancais ?? undefined,
    hauteur: { valeur: h, source: 'mesure', origine: 'Ville de Paris (inventaire des arbres)' },
    rayonCouronne: { valeur: r, source: 'deduit', origine: `Lumen : hauteur × ${e.rayonSurHauteur} (${e.nom})` },
    decalage: decalageDe(id),
  };
}

/** Modèle numérique de hauteur de la végétation (hauteur au-dessus du sol, m) sur une grille régulière. */
export interface GrilleHauteur { x0: number; y0: number; res: number; n: number; h: Float32Array; veg: Uint8Array }

/**
 * Détection des couronnes dans le LiDAR (maxima locaux du MNH végétation, rayon de recherche
 * adapté à la hauteur), avec rayon de couronne mesuré sur 8 directions (chute sous 55 % du sommet).
 */
export function couronnesLidar(g: GrilleHauteur, hMin = 4): { p: XY; hauteur: number; rayon: number }[] {
  const { n, h, veg, res } = g;
  const out: { p: XY; hauteur: number; rayon: number }[] = [];
  const at = (r: number, c: number) => (r < 0 || c < 0 || r >= n || c >= n || !veg[r * n + c] ? 0 : h[r * n + c]!);
  for (let r = 1; r < n - 1; r++)
    for (let c = 1; c < n - 1; c++) {
      const z = at(r, c);
      if (z < hMin) continue;
      const w = Math.max(2, Math.round(Math.min(4, 1 + z * 0.12) / res)); // fenêtre ~ 1,5 à 4 m
      let max = true;
      for (let dr = -w; dr <= w && max; dr++)
        for (let dc = -w; dc <= w; dc++) {
          if ((dr || dc) && dr * dr + dc * dc <= w * w) {
            const v = at(r + dr, c + dc);
            if (v > z || (v === z && (dr < 0 || (dr === 0 && dc < 0)))) { max = false; break; }
          }
        }
      if (!max) continue;
      const rayons: number[] = [];
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4, dx = Math.cos(a), dy = Math.sin(a);
        let d = 0;
        for (let s = 1; s < 24; s++) { if (at(Math.round(r - dy * s), Math.round(c + dx * s)) < z * 0.55) break; d = s * res; }
        rayons.push(d);
      }
      rayons.sort((a, b) => a - b);
      out.push({ p: { x: g.x0 + (c + 0.5) * res, y: g.y0 - (r + 0.5) * res }, hauteur: z, rayon: Math.max(1, Math.min(12, rayons[4]! + res / 2)) });
    }
  return out;
}

/**
 * Fusion inventaire + LiDAR : chaque arbre de l'inventaire prend la hauteur et la couronne du sommet LiDAR
 * le plus proche (< 3 m) ; les couronnes LiDAR sans arbre d'inventaire deviennent des arbres « feuillu » mesurés.
 */
export function fusionner(inventaire: Arbre[], couronnes: { p: XY; hauteur: number; rayon: number }[], dansEmprise: (p: XY) => boolean): Arbre[] {
  const pris = new Set<number>();
  const out = inventaire.map((a) => {
    let best = -1, d = 3;
    couronnes.forEach((c, i) => { const di = Math.hypot(c.p.x - a.p.x, c.p.y - a.p.y); if (di < d && !pris.has(i)) (d = di), (best = i); });
    if (best < 0) return a;
    pris.add(best);
    const c = couronnes[best]!;
    return {
      ...a,
      hauteur: { valeur: c.hauteur, source: 'mesure' as const, origine: 'IGN LiDAR HD (sommet de couronne)', precision_m: 0.5 },
      rayonCouronne: { valeur: c.rayon, source: 'mesure' as const, origine: 'IGN LiDAR HD (couronne)', precision_m: 0.5 },
    };
  });
  couronnes.forEach((c, i) => {
    if (pris.has(i) || !dansEmprise(c.p)) return;
    // Un sommet LiDAR à moins d'un rayon d'un arbre déjà placé est une branche du même arbre.
    if (out.some((a) => Math.hypot(a.p.x - c.p.x, a.p.y - c.p.y) < Math.max(2.5, a.rayonCouronne.valeur * 0.7))) return;
    const id = `lidar-${Math.round(c.p.x * 2)}-${Math.round(c.p.y * 2)}`;
    out.push({
      id, p: c.p, espece: 'feuillu',
      hauteur: { valeur: c.hauteur, source: 'mesure', origine: 'IGN LiDAR HD (sommet de couronne)', precision_m: 0.5 },
      rayonCouronne: { valeur: c.rayon, source: 'mesure', origine: 'IGN LiDAR HD (couronne)', precision_m: 0.5 },
      decalage: decalageDe(id),
    });
  });
  return out;
}
