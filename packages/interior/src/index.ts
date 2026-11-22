/**
 * Moteur Interior — plan 2D simple → logement 3D.
 *
 * Repère du plan (mètres, vu de dessus, rue en bas) :
 *   x = le long de la façade choisie (vers la droite quand on regarde le plan),
 *   y = profondeur vers l'intérieur du bâtiment (y = 0 : façade choisie),
 *   h = hauteur au-dessus du plancher de l'étage.
 * Les pièces sont des rectangles ; leurs bords sont les axes des murs.
 * Aucun lien avec le rendu : tout est testable seul.
 */
import { donnee, type Donnee, type Source } from '@lumen/core';

export type TypePiece =
  | 'sejour' | 'cuisine' | 'chambre' | 'salle_de_bain' | 'wc' | 'entree' | 'couloir' | 'bureau' | 'cellier';

export const PIECES: Record<TypePiece, { nom: string; couleur: number }> = {
  sejour: { nom: 'Séjour', couleur: 0xe9d8b8 },
  cuisine: { nom: 'Cuisine', couleur: 0xd9e4c8 },
  chambre: { nom: 'Chambre', couleur: 0xd8d4ea },
  salle_de_bain: { nom: 'Salle de bain', couleur: 0xc8e0ea },
  wc: { nom: 'WC', couleur: 0xcfe3e3 },
  entree: { nom: 'Entrée', couleur: 0xe6e0d6 },
  couloir: { nom: 'Couloir', couleur: 0xe6e0d6 },
  bureau: { nom: 'Bureau', couleur: 0xeadbd0 },
  cellier: { nom: 'Cellier', couleur: 0xdedede },
};

/** Côté d'une pièce. `bas` = côté façade choisie (y min). */
export type Cote = 'bas' | 'haut' | 'gauche' | 'droite';

export interface PiecePlan {
  id: string;
  type: TypePiece;
  nom?: string;
  /** Coin bas-gauche (m). */
  x: number;
  y: number;
  /** Largeur (le long de x) et profondeur (le long de y), m. */
  l: number;
  p: number;
  source: Source;
}

export interface OuverturePlan {
  id: string;
  piece: string;
  cote: Cote;
  /** Centre de l'ouverture, en m depuis le début du côté (gauche → droite, ou bas → haut). */
  position: number;
  largeur: number;
  hauteur: number;
  /** Hauteur d'allège (bas de l'ouverture au-dessus du plancher). */
  allege: number;
  type: 'fenetre' | 'porte_fenetre';
  source: Source;
}

export interface Plan {
  version: 1;
  pieces: PiecePlan[];
  ouvertures: OuverturePlan[];
  hauteurSousPlafond: number;
  epaisseurMurExt: number;
  epaisseurCloison: number;
  /** Orientation du côté `bas` du plan : azimut (degrés) vers lequel regardent ses fenêtres. Saisi par l'utilisateur. */
  azimutBas?: number;
}

export const PAS = 0.25;
export const aligner = (v: number, pas = PAS) => Math.round(v / pas) * pas;

export const planVide = (hauteurSousPlafond = 2.7): Plan => ({
  version: 1, pieces: [], ouvertures: [], hauteurSousPlafond, epaisseurMurExt: 0.3, epaisseurCloison: 0.1,
});

export const nomPiece = (p: PiecePlan) => p.nom ?? PIECES[p.type].nom;
export const surface = (p: PiecePlan): Donnee<number> =>
  donnee(Math.round(p.l * p.p * 100) / 100, p.source === 'genere' ? 'genere' : 'deduit', p.source === 'genere' ? 'Lumen (modèle)' : 'plan saisi (axes des murs)');
export const surfaceTotale = (plan: Plan) => plan.pieces.reduce((s, p) => s + p.l * p.p, 0);

export const ouvertureParDefaut = (type: OuverturePlan['type']) =>
  type === 'porte_fenetre' ? { largeur: 1.2, hauteur: 2.15, allege: 0 } : { largeur: 1.2, hauteur: 1.45, allege: 0.9 };

/** Longueur d'un côté de pièce. */
export const longueurCote = (p: PiecePlan, c: Cote) => (c === 'bas' || c === 'haut' ? p.l : p.p);

/** Segment (axe du mur) d'un côté de pièce, du début vers la fin. */
export function segmentCote(p: PiecePlan, c: Cote): [number, number, number, number] {
  switch (c) {
    case 'bas': return [p.x, p.y, p.x + p.l, p.y];
    case 'haut': return [p.x, p.y + p.p, p.x + p.l, p.y + p.p];
    case 'gauche': return [p.x, p.y, p.x, p.y + p.p];
    case 'droite': return [p.x + p.l, p.y, p.x + p.l, p.y + p.p];
  }
}

/** Normale sortante d'un côté, dans le plan. */
export const NORMALE: Record<Cote, [number, number]> = { bas: [0, -1], haut: [0, 1], gauche: [-1, 0], droite: [1, 0] };

// --- Murs -------------------------------------------------------------------

export interface SegmentMur {
  /** Axe du mur, aligné sur x ou y. */
  x1: number; y1: number; x2: number; y2: number;
  orientation: 'h' | 'v';
  exterieur: boolean;
  pieces: string[];
}

const k = (v: number) => Math.round(v / PAS);

/**
 * Découpe tous les bords des pièces en tronçons de 25 cm, compte combien de pièces
 * touchent chaque tronçon (1 = mur extérieur du logement, 2 = cloison), puis fusionne.
 */
export function segmentsMurs(plan: Plan): SegmentMur[] {
  const unites = new Map<string, Set<string>>();
  const ajoute = (cle: string, id: string) => {
    let s = unites.get(cle);
    if (!s) unites.set(cle, (s = new Set()));
    s.add(id);
  };
  for (const p of plan.pieces) {
    const x0 = k(p.x), x1 = k(p.x + p.l), y0 = k(p.y), y1 = k(p.y + p.p);
    for (let i = x0; i < x1; i++) { ajoute(`h|${y0}|${i}`, p.id); ajoute(`h|${y1}|${i}`, p.id); }
    for (let j = y0; j < y1; j++) { ajoute(`v|${x0}|${j}`, p.id); ajoute(`v|${x1}|${j}`, p.id); }
  }
  const groupes = new Map<string, { i: number; sig: string; pieces: string[] }[]>();
  for (const [cle, s] of unites) {
    const [o, ligne, i] = cle.split('|') as [string, string, string];
    const pieces = [...s].sort();
    const g = groupes.get(`${o}|${ligne}`) ?? [];
    g.push({ i: +i, sig: pieces.join(','), pieces });
    groupes.set(`${o}|${ligne}`, g);
  }
  const out: SegmentMur[] = [];
  for (const [cle, g] of groupes) {
    const [o, ligneTxt] = cle.split('|') as ['h' | 'v', string];
    const ligne = +ligneTxt * PAS;
    g.sort((a, b) => a.i - b.i);
    let debut = 0;
    for (let n = 1; n <= g.length; n++) {
      const prec = g[n - 1]!, cur = g[n];
      if (cur && cur.i === prec.i + 1 && cur.sig === prec.sig) continue;
      const a = g[debut]!.i * PAS, b = (prec.i + 1) * PAS;
      out.push({
        ...(o === 'h' ? { x1: a, y1: ligne, x2: b, y2: ligne } : { x1: ligne, y1: a, x2: ligne, y2: b }),
        orientation: o,
        exterieur: prec.pieces.length === 1,
        pieces: prec.pieces,
      });
      debut = n;
    }
  }
  return out;
}

// --- Vérification -----------------------------------------------------------

export function erreursPlan(plan: Plan): string[] {
  const e: string[] = [];
  const P = plan.pieces;
  for (let i = 0; i < P.length; i++) {
    const a = P[i]!;
    if (a.l < 0.75 || a.p < 0.75) e.push(`${nomPiece(a)} : trop petite.`);
    if (a.y < -1e-6) e.push(`${nomPiece(a)} : dépasse devant la façade.`);
    for (let j = i + 1; j < P.length; j++) {
      const b = P[j]!;
      const ox = Math.min(a.x + a.l, b.x + b.l) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.p, b.y + b.p) - Math.max(a.y, b.y);
      if (ox > 1e-6 && oy > 1e-6) e.push(`${nomPiece(a)} et ${nomPiece(b)} se chevauchent.`);
    }
  }
  const ext = segmentsMurs(plan).filter((s) => s.exterieur);
  for (const o of plan.ouvertures) {
    const p = P.find((q) => q.id === o.piece);
    if (!p) { e.push(`Ouverture ${o.id} : pièce inconnue.`); continue; }
    const L = longueurCote(p, o.cote);
    if (o.position - o.largeur / 2 < 0.1 || o.position + o.largeur / 2 > L - 0.1)
      e.push(`${nomPiece(p)} : une ouverture dépasse du mur.`);
    if (o.allege + o.hauteur > plan.hauteurSousPlafond - 0.05) e.push(`${nomPiece(p)} : une ouverture dépasse du plafond.`);
    if (!surMurExterieur(o, p, ext)) e.push(`${nomPiece(p)} : une fenêtre est sur une cloison intérieure.`);
  }
  return e;
}

function surMurExterieur(o: OuverturePlan, p: PiecePlan, ext: SegmentMur[]): boolean {
  const [x1, y1, x2, y2] = segmentCote(p, o.cote);
  const h = y1 === y2;
  const ligne = h ? y1 : x1;
  const a = (h ? x1 : y1) + o.position - o.largeur / 2;
  const b = (h ? x1 : y1) + o.position + o.largeur / 2;
  return ext.some((s) =>
    s.orientation === (h ? 'h' : 'v') &&
    Math.abs((h ? s.y1 : s.x1) - ligne) < 1e-6 &&
    (h ? s.x1 : s.y1) <= a + 1e-6 && (h ? s.x2 : s.y2) >= b - 1e-6);
}

// --- Géométrie 3D (abstraite) -----------------------------------------------

export type TypeBoite = 'mur' | 'sol' | 'plafond' | 'vitre';
export interface Boite {
  type: TypeBoite;
  piece?: string;
  /** Centre (x, y, h) dans le repère du plan, et dimensions (le long de x, y, h). */
  centre: [number, number, number];
  taille: [number, number, number];
  source: Source;
}

interface Trou { a: number; b: number; bas: number; haut: number; vitre: boolean }

/** Portes intérieures générées : une porte de 0,83 m au milieu de chaque cloison ≥ 1,2 m. */
export function portesInterieures(plan: Plan): { segment: SegmentMur; centre: number; largeur: number }[] {
  return segmentsMurs(plan)
    .filter((s) => !s.exterieur && Math.hypot(s.x2 - s.x1, s.y2 - s.y1) >= 1.2)
    .map((s) => ({ segment: s, centre: s.orientation === 'h' ? (s.x1 + s.x2) / 2 : (s.y1 + s.y2) / 2, largeur: 0.83 }));
}

export function genererVolumes(plan: Plan): Boite[] {
  const H = plan.hauteurSousPlafond;
  const out: Boite[] = [];
  const segs = segmentsMurs(plan);
  const portes = portesInterieures(plan);
  for (const s of segs) {
    const h = s.orientation === 'h';
    const ligne = h ? s.y1 : s.x1;
    const debut = h ? s.x1 : s.y1, fin = h ? s.x2 : s.y2;
    const ep = s.exterieur ? plan.epaisseurMurExt : plan.epaisseurCloison;
    const trous: Trou[] = [];
    for (const d of portes) if (d.segment === s) trous.push({ a: d.centre - d.largeur / 2, b: d.centre + d.largeur / 2, bas: 0, haut: 2.04, vitre: false });
    if (s.exterieur) {
      for (const o of plan.ouvertures) {
        const p = plan.pieces.find((q) => q.id === o.piece);
        if (!p || !s.pieces.includes(p.id)) continue;
        const [x1, y1, , y2] = segmentCote(p, o.cote);
        if ((y1 === y2) !== h || Math.abs((h ? y1 : x1) - ligne) > 1e-6) continue;
        const c = (h ? x1 : y1) + o.position;
        if (c < debut || c > fin) continue;
        trous.push({ a: c - o.largeur / 2, b: c + o.largeur / 2, bas: o.allege, haut: o.allege + o.hauteur, vitre: true });
      }
    }
    trous.sort((u, v) => u.a - v.a);
    // Bandes verticales pleines et bandes percées.
    const bande = (a: number, b: number, z0: number, z1: number, type: TypeBoite = 'mur') => {
      if (b - a < 1e-6 || z1 - z0 < 1e-6) return;
      const m = (a + b) / 2, L = b - a, eT = type === 'vitre' ? 0.02 : ep;
      out.push({
        type,
        centre: h ? [m, ligne, (z0 + z1) / 2] : [ligne, m, (z0 + z1) / 2],
        taille: h ? [L, eT, z1 - z0] : [eT, L, z1 - z0],
        source: 'genere',
      });
    };
    // Prolonge les murs de ep/2 aux extrémités pour fermer les angles.
    let curseur = debut - ep / 2;
    for (const t of trous) {
      const a = Math.max(t.a, curseur), b = Math.min(t.b, fin + ep / 2);
      if (b <= a) continue;
      bande(curseur, a, 0, H);
      bande(a, b, 0, t.bas);
      bande(a, b, t.haut, H);
      if (t.vitre) bande(a, b, t.bas, t.haut, 'vitre');
      curseur = b;
    }
    bande(curseur, fin + ep / 2, 0, H);
  }
  for (const p of plan.pieces) {
    out.push({ type: 'sol', piece: p.id, centre: [p.x + p.l / 2, p.y + p.p / 2, -0.01], taille: [p.l, p.p, 0.02], source: p.source });
    out.push({ type: 'plafond', piece: p.id, centre: [p.x + p.l / 2, p.y + p.p / 2, H + 0.1], taille: [p.l + 0.3, p.p + 0.3, 0.2], source: 'genere' });
  }
  return out;
}

// --- Ancrage dans le bâtiment ------------------------------------------------

/**
 * Ancrage du plan sur la façade choisie, dans le repère local Lumen (x = est, y = haut, z = sud).
 * `origine` : point touché sur la façade, à l'altitude du plancher de l'étage.
 * `normale` : normale sortante horizontale de la façade (nx, nz).
 * Le parement extérieur du mur `bas` est aligné sur la façade réelle.
 */
export interface Ancrage { origine: [number, number, number]; normale: [number, number]; azimutFacade: number; epaisseurMurExt: number }

/** Rotation autour de l'axe vertical à appliquer au groupe 3D (enfants placés en (x, h, -y)). */
export const rotationAncrage = (a: Ancrage) => Math.atan2(a.normale[0], a.normale[1]);

/** Point du plan (x, y, h) → repère local Lumen. */
export function planVersLocal(a: Ancrage, x: number, y: number, h: number): [number, number, number] {
  const [nx, nz] = a.normale;
  const yy = y + a.epaisseurMurExt / 2; // l'axe du mur bas est à e/2 derrière la façade
  // u = haut × n = (nz, 0, -nx) ; profondeur = -n
  return [a.origine[0] + nz * x - nx * yy, a.origine[1] + h, a.origine[2] - nx * x - nz * yy];
}

const DELTA_AZIMUT: Record<Cote, number> = { bas: 0, haut: 180, gauche: 90, droite: 270 };
export const azimutCote = (azimutFacade: number, c: Cote) => (azimutFacade + DELTA_AZIMUT[c]) % 360;

const CARDINAUX = ['Nord', 'Nord-Est', 'Est', 'Sud-Est', 'Sud', 'Sud-Ouest', 'Ouest', 'Nord-Ouest'];
export const cardinal = (az: number) => CARDINAUX[Math.round((((az % 360) + 360) % 360) / 45) % 8]!;

/** Orientation de chaque ouverture, à partir de l'orientation saisie du côté `bas` (sans 3D). */
export function orientationsOuvertures(plan: Plan): { ouverture: OuverturePlan; piece: PiecePlan; azimut: number; cardinal: string }[] {
  if (plan.azimutBas === undefined) return [];
  return plan.ouvertures.flatMap((o) => {
    const piece = plan.pieces.find((p) => p.id === o.piece);
    if (!piece) return [];
    const azimut = azimutCote(plan.azimutBas!, o.cote);
    return [{ ouverture: o, piece, azimut, cardinal: cardinal(azimut) }];
  });
}

export interface FenetreMonde {
  ouverture: OuverturePlan;
  piece: PiecePlan;
  azimut: number;
  /** Points d'échantillonnage (gauche, centre, droite à mi-hauteur), 30 cm devant le parement extérieur. */
  points: [number, number, number][];
}

export function fenetresMonde(plan: Plan, a: Ancrage): FenetreMonde[] {
  const out: FenetreMonde[] = [];
  for (const o of plan.ouvertures) {
    const p = plan.pieces.find((q) => q.id === o.piece);
    if (!p) continue;
    const [x1, y1, x2, y2] = segmentCote(p, o.cote);
    const L = longueurCote(p, o.cote);
    const [nx, ny] = NORMALE[o.cote];
    const recul = plan.epaisseurMurExt / 2 + 0.3;
    const h = o.allege + o.hauteur / 2;
    const points = [-0.35, 0, 0.35].map((f) => {
      const t = (o.position + f * o.largeur) / L;
      return planVersLocal(a, x1 + (x2 - x1) * t + nx * recul, y1 + (y2 - y1) * t + ny * recul, h);
    });
    out.push({ ouverture: o, piece: p, azimut: azimutCote(a.azimutFacade, o.cote), points });
  }
  return out;
}

// --- Modèles prêts à l'emploi ------------------------------------------------

let compteur = 0;
export const nouvelId = (prefixe: string) => `${prefixe}${Date.now().toString(36)}${(compteur++).toString(36)}`;

type Gabarit = [TypePiece, number, number, number, number, [Cote, number, OuverturePlan['type']][]];
const GABARITS: Record<'studio' | 't2' | 't3', Gabarit[]> = {
  studio: [
    ['sejour', -2.5, 0, 5, 4.5, [['bas', 1.5, 'fenetre'], ['bas', 3.6, 'porte_fenetre']]],
    ['cuisine', -2.5, 4.5, 2, 2, []],
    ['entree', -0.5, 4.5, 1.25, 2, []],
    ['salle_de_bain', 0.75, 4.5, 1.75, 2, []],
  ],
  t2: [
    ['sejour', -4, 0, 5, 4.5, [['bas', 1.5, 'fenetre'], ['bas', 3.6, 'porte_fenetre']]],
    ['chambre', 1, 0, 3.5, 3.75, [['bas', 1.75, 'fenetre']]],
    ['cuisine', -4, 4.5, 2.5, 2.5, []],
    ['entree', -1.5, 4.5, 2.5, 2.5, []],
    ['salle_de_bain', 1, 3.75, 2, 3.25, []],
    ['wc', 3, 3.75, 1.5, 3.25, []],
  ],
  t3: [
    ['sejour', -5, 0, 5.5, 5, [['bas', 1.5, 'fenetre'], ['bas', 4, 'porte_fenetre']]],
    ['chambre', 0.5, 0, 3.25, 3.75, [['bas', 1.6, 'fenetre']]],
    ['chambre', 3.75, 0, 3, 3.75, [['bas', 1.5, 'fenetre']]],
    ['cuisine', -5, 5, 3, 3, []],
    ['entree', -2, 5, 2.5, 3, []],
    ['couloir', 0.5, 3.75, 6.25, 1.25, []],
    ['salle_de_bain', 0.5, 5, 2.5, 3, []],
    ['wc', 3, 5, 1.5, 3, []],
    ['cellier', 4.5, 5, 2.25, 3, []],
  ],
};

export function planModele(nom: keyof typeof GABARITS, hauteurSousPlafond = 2.7): Plan {
  const plan = planVide(hauteurSousPlafond);
  for (const [type, x, y, l, p, ouv] of GABARITS[nom]) {
    const id = nouvelId('p');
    plan.pieces.push({ id, type, x, y, l, p, source: 'genere' });
    for (const [cote, position, t] of ouv)
      plan.ouvertures.push({ id: nouvelId('o'), piece: id, cote, position, type: t, ...ouvertureParDefaut(t), source: 'genere' });
  }
  return plan;
}
