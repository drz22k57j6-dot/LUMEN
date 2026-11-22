/**
 * Modèle de logement commun à toutes les sources (plan Lumen, scan Apple RoomPlan, plan DXF d'architecte, scan 3D).
 * Repère : x vers la droite, y vers le haut du plan (vu de dessus, non miroir), h = hauteur au-dessus du sol fini.
 * Murs quelconques (pas seulement rectangulaires), ouvertures rattachées à un mur.
 */
import type { Source } from '@lumen/core';
import { nomPiece, PIECES, portesInterieures, segmentCote, segmentsMurs, type Plan, type TypePiece } from './index';

export type P2 = [number, number];
export type TypeOuverture = 'fenetre' | 'porte_fenetre' | 'porte' | 'baie';

export interface Mur { id: string; a: P2; b: P2; epaisseur: number; hauteur: number; exterieur: boolean; source: Source }
export interface Ouverture3D {
  id: string;
  mur: string;
  /** Distance du point a du mur au centre de l'ouverture (m). */
  t: number;
  largeur: number;
  hauteur: number;
  allege: number;
  type: TypeOuverture;
  source: Source;
}
export interface Piece3D { id: string; type: TypePiece; nom?: string; contour: P2[]; source: Source }
export interface Objet3D { id: string; categorie: string; centre: [number, number, number]; taille: [number, number, number]; angle: number; source: Source }

export interface Modele {
  version: 1;
  origine: 'plan' | 'roomplan' | 'dxf' | 'vide';
  murs: Mur[];
  ouvertures: Ouverture3D[];
  pieces: Piece3D[];
  objets: Objet3D[];
  hauteurSousPlafond: number;
  /** Azimut (degrés) vers lequel regarde la normale (0, -1) du plan. Optionnel. */
  azimutBas?: number;
}

export const modeleVide = (h = 2.7): Modele => ({ version: 1, origine: 'vide', murs: [], ouvertures: [], pieces: [], objets: [], hauteurSousPlafond: h });

let n = 0;
const id = (p: string) => `${p}${(n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// --- Géométrie de base ---------------------------------------------------------

export const longueur = (m: Mur) => Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]);
export const direction = (m: Mur): P2 => { const L = longueur(m) || 1; return [(m.b[0] - m.a[0]) / L, (m.b[1] - m.a[1]) / L]; };
export const pointSurMur = (m: Mur, t: number): P2 => { const d = direction(m); return [m.a[0] + d[0] * t, m.a[1] + d[1] * t]; };

/** Projection d'un point sur un mur : abscisse t (bornée) et distance. */
export function projeter(m: Mur, p: P2): { t: number; d: number } {
  const L = longueur(m), [dx, dy] = direction(m);
  const t = Math.min(L, Math.max(0, (p[0] - m.a[0]) * dx + (p[1] - m.a[1]) * dy));
  const q = pointSurMur(m, t);
  return { t, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
}

export const aireContour = (c: P2[]) => Math.abs(c.reduce((s, p, i) => { const q = c[(i + 1) % c.length]!; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
export const centreContour = (c: P2[]): P2 => [c.reduce((s, p) => s + p[0], 0) / c.length, c.reduce((s, p) => s + p[1], 0) / c.length];
export function dansContour(c: P2[], p: P2): boolean {
  let d = false;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
    const a = c[i]!, b = c[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) d = !d;
  }
  return d;
}

export function emprise(m: Modele): [number, number, number, number] {
  const pts: P2[] = [...m.murs.flatMap((w) => [w.a, w.b]), ...m.pieces.flatMap((p) => p.contour)];
  if (!pts.length) return [0, 0, 0, 0];
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

/**
 * Normale sortante d'un mur : du côté opposé au centre de la pièce la plus proche
 * (ou du centre du logement). Sert à orienter fenêtres et cadres.
 */
export function normaleExterieure(m: Modele, w: Mur): P2 {
  const [dx, dy] = direction(w);
  const nrm: P2 = [dy, -dx];
  const mil = pointSurMur(w, longueur(w) / 2);
  const test: P2 = [mil[0] + nrm[0] * 0.3, mil[1] + nrm[1] * 0.3];
  const dedans = m.pieces.length
    ? m.pieces.some((p) => dansContour(p.contour, test))
    : (() => { const e = emprise(m); const c: P2 = [(e[0] + e[2]) / 2, (e[1] + e[3]) / 2]; return (c[0] - mil[0]) * nrm[0] + (c[1] - mil[1]) * nrm[1] > 0; })();
  return dedans ? [-nrm[0], -nrm[1]] : nrm;
}

/** Azimut d'une direction du plan, connaissant l'azimut de (0, -1). */
export const azimutPlan = (azimutBas: number, d: P2) =>
  (((azimutBas + 180 + (Math.atan2(d[0], d[1]) * 180) / Math.PI) % 360) + 360) % 360;

/** Direction du plan correspondant à un azimut (inverse de azimutPlan). */
export const directionPlan = (azimutBas: number, azimut: number): P2 => {
  const phi = ((azimut - azimutBas - 180) * Math.PI) / 180;
  return [Math.sin(phi), Math.cos(phi)];
};

// --- Vérification ----------------------------------------------------------------

export function erreursModele(m: Modele): string[] {
  const e: string[] = [];
  for (const w of m.murs) if (longueur(w) < 0.05) e.push(`Mur ${w.id} trop court.`);
  for (const o of m.ouvertures) {
    const w = m.murs.find((x) => x.id === o.mur);
    if (!w) { e.push(`Ouverture ${o.id} sans mur.`); continue; }
    if (o.t - o.largeur / 2 < -0.01 || o.t + o.largeur / 2 > longueur(w) + 0.01) e.push(`Une ouverture dépasse de son mur.`);
    if (o.allege + o.hauteur > w.hauteur + 0.01) e.push(`Une ouverture dépasse du plafond.`);
  }
  return e;
}

// --- Source 1 : plan 2D Lumen (pièces rectangulaires) ------------------------------

export function depuisPlan(plan: Plan): Modele {
  const m = modeleVide(plan.hauteurSousPlafond);
  m.origine = 'plan';
  if (plan.azimutBas !== undefined) m.azimutBas = plan.azimutBas;
  const segs = segmentsMurs(plan);
  for (const s of segs) {
    const w: Mur = {
      id: id('m'), a: [s.x1, s.y1], b: [s.x2, s.y2], exterieur: s.exterieur,
      epaisseur: s.exterieur ? plan.epaisseurMurExt : plan.epaisseurCloison, hauteur: plan.hauteurSousPlafond, source: 'deduit',
    };
    m.murs.push(w);
  }
  for (const o of plan.ouvertures) {
    const p = plan.pieces.find((x) => x.id === o.piece);
    if (!p) continue;
    const [x1, y1, x2, y2] = segmentCote(p, o.cote);
    const L = Math.hypot(x2 - x1, y2 - y1);
    const c: P2 = [x1 + ((x2 - x1) * o.position) / L, y1 + ((y2 - y1) * o.position) / L];
    const w = m.murs.filter((x) => x.exterieur).map((x) => ({ x, ...projeter(x, c) })).sort((a, b) => a.d - b.d)[0];
    if (!w || w.d > 0.01) continue;
    m.ouvertures.push({ id: id('o'), mur: w.x.id, t: w.t, largeur: o.largeur, hauteur: o.hauteur, allege: o.allege, type: o.type, source: o.source });
  }
  for (const d of portesInterieures(plan)) {
    const g = d.segment;
    const w = m.murs.find((x) => x.a[0] === g.x1 && x.a[1] === g.y1 && x.b[0] === g.x2 && x.b[1] === g.y2);
    if (!w) continue;
    const t = d.segment.orientation === 'h' ? d.centre - d.segment.x1 : d.centre - d.segment.y1;
    m.ouvertures.push({ id: id('o'), mur: w.id, t, largeur: d.largeur, hauteur: 2.04, allege: 0, type: 'porte', source: 'genere' });
  }
  for (const p of plan.pieces)
    m.pieces.push({ id: p.id, type: p.type, nom: nomPiece(p), contour: [[p.x, p.y], [p.x + p.l, p.y], [p.x + p.l, p.y + p.p], [p.x, p.y + p.p]], source: p.source });
  return m;
}

// --- Source 2 : scan Apple RoomPlan (CapturedRoom exporté en JSON) ----------------

type Mat = number[];
interface SurfaceRP { identifier?: string; dimensions: number[]; transform: Mat | Mat[]; category?: unknown; polygonCorners?: number[][] }
interface ObjetRP { identifier?: string; dimensions: number[]; transform: Mat | Mat[]; category?: unknown }
interface SectionRP { label?: string; center?: number[] }
export interface CapturedRoomJSON {
  walls?: SurfaceRP[]; doors?: SurfaceRP[]; windows?: SurfaceRP[]; openings?: SurfaceRP[];
  floors?: SurfaceRP[]; objects?: ObjetRP[]; sections?: SectionRP[];
}

/** Matrice 4×4 RoomPlan (simd, colonnes) → 16 nombres en ordre colonnes. */
const aplatir = (t: Mat | Mat[]): number[] => (Array.isArray(t[0]) ? (t as Mat[]).flat() : (t as Mat));
/** Clé de catégorie RoomPlan, quel que soit l'encodage ({ "door": { isOpen } } ou "door"). */
const cat = (c: unknown): string => (typeof c === 'string' ? c : c && typeof c === 'object' ? Object.keys(c)[0] ?? '' : '');

const SECTIONS: Record<string, TypePiece> = {
  livingRoom: 'sejour', bedroom: 'chambre', kitchen: 'cuisine', bathroom: 'salle_de_bain', diningRoom: 'sejour', unidentified: 'sejour',
};

export function depuisRoomPlan(json: CapturedRoomJSON): Modele {
  const m = modeleVide();
  m.origine = 'roomplan';
  const walls = json.walls ?? [];
  if (!walls.length) throw new Error('Aucun mur dans le fichier RoomPlan.');
  // ARKit : y vers le haut ; plan : x = X, y = −Z (vue de dessus non miroir).
  const surf = (s: SurfaceRP) => {
    const t = aplatir(s.transform);
    const [w = 0, h = 0, d = 0] = s.dimensions;
    return { centre: [t[12]!, t[13]!, t[14]!] as const, ax: [t[0]!, t[2]!] as const, w, h, d };
  };
  const sw = walls.map(surf);
  const sol = Math.min(...sw.map((s) => s.centre[1] - s.h / 2));
  m.hauteurSousPlafond = Math.round(Math.max(...sw.map((s) => s.h)) * 100) / 100;
  sw.forEach((s) => {
    const L = Math.hypot(s.ax[0], s.ax[1]) || 1;
    const ux = s.ax[0] / L, uy = -s.ax[1] / L;
    const cx = s.centre[0], cy = -s.centre[2];
    m.murs.push({
      id: id('m'), a: [cx - (ux * s.w) / 2, cy - (uy * s.w) / 2], b: [cx + (ux * s.w) / 2, cy + (uy * s.w) / 2],
      epaisseur: s.d > 0.04 ? s.d : 0.15, hauteur: s.h, exterieur: false, source: 'mesure',
    });
  });
  const types: [SurfaceRP[] | undefined, (s: SurfaceRP) => TypeOuverture][] = [
    [json.windows, () => 'fenetre'],
    [json.doors, () => 'porte'],
    [json.openings, () => 'baie'],
  ];
  for (const [liste, type] of types)
    for (const s of liste ?? []) {
      const o = surf(s);
      const c: P2 = [o.centre[0], -o.centre[2]];
      const best = m.murs.map((x) => ({ x, ...projeter(x, c) })).sort((a, b) => a.d - b.d)[0];
      if (!best || best.d > 0.4) continue;
      const allege = Math.max(0, o.centre[1] - o.h / 2 - sol);
      let t = type(s);
      if (t === 'porte' && allege < 0.1 && o.h > 1.9 && best.x.exterieur) t = 'porte_fenetre';
      m.ouvertures.push({ id: id('o'), mur: best.x.id, t: best.t, largeur: o.w, hauteur: Math.min(o.h, best.x.hauteur - allege), allege, type: t, source: 'mesure' });
    }
  // Murs avec fenêtre = murs extérieurs (déduit).
  for (const w of m.murs) if (m.ouvertures.some((o) => o.mur === w.id && o.type === 'fenetre')) { w.exterieur = true; w.epaisseur = Math.max(w.epaisseur, 0.3); }
  // Sols (iOS 17+) : polygone dans le repère local du sol.
  for (const f of json.floors ?? []) {
    if (!f.polygonCorners?.length) continue;
    const t = aplatir(f.transform);
    const contour = f.polygonCorners.map(([x = 0, y = 0, z = 0]) => {
      const X = t[0]! * x + t[4]! * y + t[8]! * z + t[12]!;
      const Z = t[2]! * x + t[6]! * y + t[10]! * z + t[14]!;
      return [X, -Z] as P2;
    });
    m.pieces.push({ id: id('p'), type: 'sejour', contour, source: 'mesure' });
  }
  if (!m.pieces.length) {
    const [x0, y0, x1, y1] = emprise(m);
    m.pieces.push({ id: id('p'), type: 'sejour', contour: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], source: 'deduit' });
  }
  for (const s of json.sections ?? []) {
    if (!s.center || !s.label) continue;
    const c: P2 = [s.center[0] ?? 0, -(s.center[2] ?? 0)];
    const p = m.pieces.find((x) => dansContour(x.contour, c));
    if (p && SECTIONS[s.label]) p.type = SECTIONS[s.label]!;
  }
  for (const s of json.objects ?? []) {
    const o = surf(s);
    m.objets.push({
      id: id('x'), categorie: cat(s.category) || 'objet', centre: [o.centre[0], -o.centre[2], o.centre[1] - sol],
      taille: [o.w, o.d, o.h], angle: Math.atan2(-o.ax[1], o.ax[0]), source: 'mesure',
    });
  }
  return m;
}

// --- Source 3 : plan d'architecte DXF (LINE / LWPOLYLINE) ----------------------------

export function depuisDXF(texte: string): Modele {
  const lignes = texte.split(/\r?\n/);
  const paires: [number, string][] = [];
  for (let i = 0; i + 1 < lignes.length; i += 2) paires.push([parseInt(lignes[i]!.trim(), 10), lignes[i + 1]!.trim()]);
  let insunits = 0;
  const iu = paires.findIndex(([c, v]) => c === 9 && v === '$INSUNITS');
  if (iu >= 0) insunits = parseInt(paires[iu + 1]?.[1] ?? '0', 10);
  const debut = paires.findIndex(([c, v]) => c === 2 && v === 'ENTITIES');
  const segs: { a: P2; b: P2; calque: string }[] = [];
  const contours: { pts: P2[]; calque: string }[] = [];
  let i = debut < 0 ? 0 : debut;
  while (i < paires.length) {
    const [c, v] = paires[i]!;
    if (c === 0 && (v === 'LINE' || v === 'LWPOLYLINE')) {
      const ent: [number, string][] = [];
      i++;
      while (i < paires.length && paires[i]![0] !== 0) ent.push(paires[i++]!);
      const calque = ent.find(([k]) => k === 8)?.[1] ?? '0';
      if (v === 'LINE') {
        const g = (k: number) => parseFloat(ent.find(([x]) => x === k)?.[1] ?? 'NaN');
        segs.push({ a: [g(10), g(20)], b: [g(11), g(21)], calque });
      } else {
        const xs = ent.filter(([k]) => k === 10).map(([, x]) => parseFloat(x));
        const ys = ent.filter(([k]) => k === 20).map(([, y]) => parseFloat(y));
        const ferme = (parseInt(ent.find(([k]) => k === 70)?.[1] ?? '0', 10) & 1) === 1;
        const pts = xs.map((x, k) => [x, ys[k] ?? 0] as P2);
        contours.push({ pts, calque });
        for (let k = 0; k + 1 < pts.length; k++) segs.push({ a: pts[k]!, b: pts[k + 1]!, calque });
        if (ferme && pts.length > 2) segs.push({ a: pts[pts.length - 1]!, b: pts[0]!, calque });
      }
      continue;
    }
    if (c === 0 && v === 'ENDSEC' && debut >= 0) break;
    i++;
  }
  const estMur = (l: string) => /mur|wall|cloison|a-wall/i.test(l);
  const estPiece = (l: string) => /piece|pièce|room|surface|local/i.test(l);
  const murs = segs.some((s) => estMur(s.calque)) ? segs.filter((s) => estMur(s.calque)) : segs.filter((s) => !estPiece(s.calque));
  if (!murs.length) throw new Error('Aucune ligne de mur trouvée dans le DXF.');
  // Unité : $INSUNITS (4 = mm, 5 = cm, 6 = m), sinon déduite de la taille.
  const tous = murs.flatMap((s) => [s.a, s.b]);
  const etendue = Math.max(...tous.map((p) => p[0])) - Math.min(...tous.map((p) => p[0]));
  const k = insunits === 4 ? 0.001 : insunits === 5 ? 0.01 : insunits === 6 ? 1 : etendue > 300 ? 0.001 : etendue > 60 ? 0.01 : 1;
  const x0 = Math.min(...tous.map((p) => p[0])), y0 = Math.min(...tous.map((p) => p[1]));
  const tr = (p: P2): P2 => [Math.round((p[0] - x0) * k * 1000) / 1000, Math.round((p[1] - y0) * k * 1000) / 1000];
  const m = modeleVide();
  m.origine = 'dxf';
  for (const s of murs) {
    const a = tr(s.a), b = tr(s.b);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.05) continue;
    m.murs.push({ id: id('m'), a, b, epaisseur: 0.12, hauteur: 2.7, exterieur: false, source: 'deduit' });
  }
  for (const c of contours.filter((x) => estPiece(x.calque) && x.pts.length > 2))
    m.pieces.push({ id: id('p'), type: 'sejour', contour: c.pts.map(tr), source: 'deduit' });
  if (!m.pieces.length) {
    const [a, b, c, d] = emprise(m);
    m.pieces.push({ id: id('p'), type: 'sejour', contour: [[a, b], [c, b], [c, d], [a, d]], source: 'genere' });
  }
  return m;
}

// --- Volumes 3D (abstraits, testables) ----------------------------------------------

export interface Bloc {
  /** Centre (x, y, h) et dimensions (le long du mur, épaisseur, hauteur), angle du mur (rad, depuis +x vers +y). */
  centre: [number, number, number];
  taille: [number, number, number];
  angle: number;
  type: 'mur' | 'vitre' | 'cadre' | 'plinthe';
  mur: string;
}

/** Découpe chaque mur autour de ses ouvertures (allège, linteau, trumeaux) ; murs prolongés de e/2 pour fermer les angles. */
export function blocsMurs(m: Modele): Bloc[] {
  const out: Bloc[] = [];
  for (const w of m.murs) {
    const L = longueur(w), [dx, dy] = direction(w), ang = Math.atan2(dy, dx), e = w.epaisseur, H = w.hauteur;
    const bande = (a: number, b: number, z0: number, z1: number, type: Bloc['type'] = 'mur', ep = e) => {
      if (b - a < 1e-4 || z1 - z0 < 1e-4) return;
      const c = (a + b) / 2;
      out.push({ centre: [w.a[0] + dx * c, w.a[1] + dy * c, (z0 + z1) / 2], taille: [b - a, ep, z1 - z0], angle: ang, type, mur: w.id });
    };
    const trous = m.ouvertures.filter((o) => o.mur === w.id).map((o) => ({ ...o, a: o.t - o.largeur / 2, b: o.t + o.largeur / 2 })).sort((u, v) => u.a - v.a);
    let cur = -e / 2;
    for (const o of trous) {
      const a = Math.max(o.a, cur), b = o.b;
      if (b <= a) continue;
      bande(cur, a, 0, H);
      bande(a, b, 0, o.allege);
      bande(a, b, o.allege + o.hauteur, H);
      if (o.type !== 'porte' && o.type !== 'baie') bande(a, b, o.allege, o.allege + o.hauteur, 'vitre', 0.02);
      cur = b;
    }
    bande(cur, L + e / 2, 0, H);
  }
  return out;
}

export const nomPiece3D = (p: Piece3D) => p.nom ?? PIECES[p.type].nom;
