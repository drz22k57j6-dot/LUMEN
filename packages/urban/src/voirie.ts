// Moteur de voirie Lumen : tronçons IGN BD TOPO → chaussée, trottoirs, bordures, caniveaux, marquages.
// Successeur du générateur de routes de limoges-3d (commun/chaussee.js, moteur_sol/) :
//  - largeurs ajustées à l'espace réel entre façades (au lieu d'une largeur type par classe) ;
//  - chaussée fusionnée en un seul polygone, carrefours propres et angles de trottoir arrondis ;
//  - trottoirs qui vont jusqu'aux façades, bordures seulement là où il y a un trottoir ;
//  - marquages, passages piétons et stationnement aux cotes françaises, coupés aux carrefours.
// Chaque élément porte sa provenance : rien de généré n'est présenté comme relevé.
import ClipperLib from 'clipper-lib';
import { donnee, versL93, type Batiment, type Donnee, type LonLat, type Source, type XY } from '@lumen/core';

const GEOPF = 'https://data.geopf.fr';

export type Sens = 'double' | 'direct' | 'inverse';
export interface Troncon {
  id: string;
  /** Axe en Lambert-93 (m). */
  axe: XY[];
  nature: string;
  importance: number;
  largeur: Donnee<number>;
  voies: number;
  sens: Sens;
  /** Sentier, chemin, piste : allée piétonne, sans chaussée. */
  pieton: boolean;
}

/** Polygone : premier anneau = contour, suivants = trous (Lambert-93, sans point de fermeture). */
export type Poly = XY[][];
/** Rectangle de marquage (4 sommets dans l'ordre). */
export type Quad = [XY, XY, XY, XY];

export interface Bordure {
  /** Ligne de bordure ; la chaussée est à gauche, le trottoir à droite. */
  pts: XY[];
  ferme: boolean;
}

export interface Voirie {
  chaussee: Poly[];
  trottoirs: Poly[];
  allees: Poly[];
  bordures: Bordure[];
  marquages: Quad[];
  passages: Quad[];
  avaloirs: { p: XY; dir: XY }[];
  regards: XY[];
  largeurs: Map<string, Donnee<number>>;
  provenance: Record<string, { source: Source; origine: string }>;
}

// ---------------------------------------------------------------------------
// Données IGN
// ---------------------------------------------------------------------------
interface ProprietesTroncon {
  nature: string | null;
  importance: string | null;
  largeur_de_chaussee: number | null;
  nombre_de_voies: number | null;
  sens_de_circulation: string | null;
  position_par_rapport_au_sol: string | null;
  etat_de_l_objet: string | null;
}
export interface EntiteTroncon {
  id: string;
  geometry: { type: 'LineString' | 'MultiLineString'; coordinates: number[][] | number[][][] } | null;
  properties: ProprietesTroncon;
}

const PIETON = new Set(['Sentier', 'Chemin', 'Piste cyclable']);
const IGNORE = new Set(['Escalier', 'Bac ou liaison maritime', 'Bac ou liaison fluviale', 'Type autoroutier']);

export function versTroncon(e: EntiteTroncon): Troncon | null {
  const p = e.properties;
  if (!e.geometry || !p.nature || IGNORE.has(p.nature)) return null;
  if ((p.position_par_rapport_au_sol ?? '0') !== '0') return null; // ponts et tunnels : rendu dédié plus tard
  if (p.etat_de_l_objet && p.etat_de_l_objet !== 'En service') return null;
  const lignes = (e.geometry.type === 'LineString' ? [e.geometry.coordinates] : e.geometry.coordinates) as number[][][];
  const axe: XY[] = [];
  for (const l of lignes) for (const [lon, lat] of l) axe.push(versL93({ lon: lon!, lat: lat! }));
  if (axe.length < 2) return null;
  const pieton = PIETON.has(p.nature);
  const voies = p.nombre_de_voies && p.nombre_de_voies > 0 ? p.nombre_de_voies : pieton ? 0 : 1;
  const largeur =
    p.largeur_de_chaussee && p.largeur_de_chaussee > 0
      ? donnee(p.largeur_de_chaussee, 'deduit', 'IGN BD TOPO (largeur_de_chaussee)')
      : donnee(pieton ? 2.2 : Math.max(3, voies * 3), 'genere', 'Lumen (largeur type)');
  const s = p.sens_de_circulation;
  const sens: Sens = s === 'Sens direct' ? 'direct' : s === 'Sens inverse' ? 'inverse' : 'double';
  return { id: e.id, axe, nature: p.nature, importance: Number(p.importance ?? 5) || 5, largeur, voies, sens, pieton };
}

/** Tronçons de route BD TOPO dans un carré de ± rayon mètres autour d'un point. */
export async function tronconsAutour(centre: LonLat, rayon = 300): Promise<Troncon[]> {
  const dLat = rayon / 111_320;
  const dLon = rayon / (111_320 * Math.cos((centre.lat * Math.PI) / 180));
  const bbox = [centre.lat - dLat, centre.lon - dLon, centre.lat + dLat, centre.lon + dLon].join(',');
  const out: Troncon[] = [];
  const parPage = 1000;
  for (let debut = 0; debut < 10_000; debut += parPage) {
    const url =
      `${GEOPF}/wfs/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=BDTOPO_V3:troncon_de_route` +
      `&outputFormat=application/json&srsName=EPSG:4326&count=${parPage}&startIndex=${debut}` +
      `&bbox=${bbox},urn:ogc:def:crs:EPSG::4326`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`BD TOPO routes indisponible (${r.status})`);
    const j = (await r.json()) as { features: EntiteTroncon[] };
    for (const f of j.features) {
      const t = versTroncon(f);
      if (t) out.push(t);
    }
    if (j.features.length < parPage) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cotes (voirie urbaine française)
// ---------------------------------------------------------------------------
export const COTES = {
  pas: 4, // ré-échantillonnage des axes (m)
  trottoirMin: 1.4, // largeur utile minimale (PMR)
  rayonAngle: 4, // rayon de bordure aux angles de rue
  passage: { longueur: 3, bande: 0.5, intervalle: 0.5, recul: 1 }, // bandes de 50 cm espacées de 50 cm
  axe: { largeur: 0.12, trait: 3, periode: 13 }, // ligne T1 : 3 m / 10 m
  stationnement: { largeur: 2, pas: 5 },
  caniveau: 0.35,
  bordure: { hauteur: 0.14, largeur: 0.2 },
} as const;

// ---------------------------------------------------------------------------
// Géométrie 2D
// ---------------------------------------------------------------------------
type P2 = [number, number];
/** Liste d'anneaux (remplissage non nul) et polygones avec trous. */
type Anneaux = P2[][];
type ExPoly = P2[][];

// Opérations booléennes robustes (Clipper, coordonnées entières au millimètre).
const ECH = 1000;
const versC = (rs: Anneaux) => rs.map((r) => r.map(([x, y]) => ({ X: Math.round(x * ECH), Y: Math.round(y * ECH) })));
function booleen(type: 'union' | 'inter' | 'diff', sujet: Anneaux, clip: Anneaux = []): ExPoly[] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(versC(sujet), ClipperLib.PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(versC(clip), ClipperLib.PolyType.ptClip, true);
  const t = new ClipperLib.PolyTree();
  const ct = ClipperLib.ClipType;
  c.Execute(type === 'union' ? ct.ctUnion : type === 'inter' ? ct.ctIntersection : ct.ctDifference, t, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  return ClipperLib.JS.PolyTreeToExPolygons(t).map((e) => [e.outer, ...e.holes].map((r) => r.map((p) => [p.X / ECH, p.Y / ECH] as P2)));
}
const aplatir = (ps: ExPoly[]): Anneaux => ps.flat();
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const hash = (a: number, b: number) => {
  let h = Math.imul(Math.floor(a) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.floor(b), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

function aireSignee(r: P2[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] - r[i]![0]) * (r[j]![1] + r[i]![1]);
  return a / 2;
}

function simplifier(r: P2[], tol: number): P2[] {
  if (r.length < 4) return r;
  const garder = new Uint8Array(r.length);
  garder[0] = garder[r.length - 1] = 1;
  const pile: [number, number][] = [[0, r.length - 1]];
  while (pile.length) {
    const [a, b] = pile.pop()!;
    const A = r[a]!, B = r[b]!, dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
    let dm = 0, im = -1;
    for (let i = a + 1; i < b; i++) {
      const d = L < 1e-6 ? Math.hypot(r[i]![0] - A[0], r[i]![1] - A[1]) : Math.abs((r[i]![0] - A[0]) * dy - (r[i]![1] - A[1]) * dx) / L;
      if (d > dm) (dm = d), (im = i);
    }
    if (dm > tol && im > 0) (garder[im] = 1), pile.push([a, im], [im, b]);
  }
  return r.filter((_, i) => garder[i]);
}

/** Arrondit les angles d'un anneau (intérieur à gauche) : rentrants au rayon de bordure, saillants à 0,6 m. */
function arrondir(r: P2[], rRentrant: number, rSaillant: number): P2[] {
  const n = r.length, out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const P = r[(i - 1 + n) % n]!, C = r[i]!, N = r[(i + 1) % n]!;
    const e1: P2 = [C[0] - P[0], C[1] - P[1]], e2: P2 = [N[0] - C[0], N[1] - C[1]];
    const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const u1: P2 = [e1[0] / l1, e1[1] / l1], u2: P2 = [e2[0] / l2, e2[1] / l2];
    const cr = u1[0] * u2[1] - u1[1] * u2[0], d = Math.atan2(cr, u1[0] * u2[0] + u1[1] * u2[1]);
    if (Math.abs(d) < 0.3) {
      out.push(C);
      continue;
    }
    let R = d > 0 ? rSaillant : rRentrant;
    let t = R * Math.tan(Math.abs(d) / 2);
    const tMax = 0.48 * Math.min(l1, l2);
    if (t > tMax) (t = tMax), (R = t / Math.tan(Math.abs(d) / 2));
    if (t < 0.05) {
      out.push(C);
      continue;
    }
    const P1: P2 = [C[0] - u1[0] * t, C[1] - u1[1] * t];
    const nrm: P2 = d > 0 ? [-u1[1], u1[0]] : [u1[1], -u1[0]];
    const O: P2 = [P1[0] + nrm[0] * R, P1[1] + nrm[1] * R];
    const a1 = Math.atan2(P1[1] - O[1], P1[0] - O[0]), k = Math.max(2, Math.ceil(Math.abs(d) / (Math.PI / 12)));
    for (let j = 0; j <= k; j++) out.push([O[0] + R * Math.cos(a1 + (d * j) / k), O[1] + R * Math.sin(a1 + (d * j) / k)]);
  }
  return out;
}

/** Nettoie un multipolygone : anneaux orientés (intérieur à gauche), simplifiés, petits morceaux retirés. */
function nettoyer(mp: ExPoly[], aireMin: number, arrondi?: [number, number]): ExPoly[] {
  const out: ExPoly[] = [];
  for (const poly of mp) {
    const anneaux: P2[][] = [];
    poly.forEach((ring, i) => {
      let r = simplifier([...ring, ring[0]!], 0.05).slice(0, -1);
      if (r.length < 3) return;
      const a = aireSignee(r);
      if (Math.abs(a) < (i === 0 ? aireMin : 0.5)) return;
      if ((i === 0) !== a > 0) r.reverse();
      if (arrondi) r = arrondir(r, arrondi[0], arrondi[1]);
      anneaux.push(r);
    });
    if (anneaux.length && Math.abs(aireSignee(anneaux[0]!)) >= aireMin) out.push(anneaux);
  }
  return out;
}


function dansPoly(poly: P2[][], x: number, y: number): boolean {
  let dedans = false;
  for (const r of poly)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i]!, b = r[j]!;
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) dedans = !dedans;
    }
  return dedans;
}

/** Index spatial des murs (segments de façade) pour lancer des rayons. */
class Murs {
  private grille = new Map<number, number[]>();
  private segs: number[] = [];
  constructor(private c = 10) {}
  private cle = (i: number, j: number) => i * 100003 + j;
  ajouter(a: P2, b: P2) {
    const id = this.segs.length / 4;
    this.segs.push(a[0], a[1], b[0], b[1]);
    const i0 = Math.floor(Math.min(a[0], b[0]) / this.c), i1 = Math.floor(Math.max(a[0], b[0]) / this.c);
    const j0 = Math.floor(Math.min(a[1], b[1]) / this.c), j1 = Math.floor(Math.max(a[1], b[1]) / this.c);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const k = this.cle(i, j);
        const l = this.grille.get(k);
        l ? l.push(id) : this.grille.set(k, [id]);
      }
  }
  /** Distance au premier mur le long d'un rayon (Infinity si aucun). */
  rayon(o: P2, d: P2, max: number): number {
    const fx = o[0] + d[0] * max, fy = o[1] + d[1] * max;
    const i0 = Math.floor(Math.min(o[0], fx) / this.c), i1 = Math.floor(Math.max(o[0], fx) / this.c);
    const j0 = Math.floor(Math.min(o[1], fy) / this.c), j1 = Math.floor(Math.max(o[1], fy) / this.c);
    let best = Infinity;
    const vus = new Set<number>();
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++)
        for (const id of this.grille.get(this.cle(i, j)) ?? []) {
          if (vus.has(id)) continue;
          vus.add(id);
          const s = this.segs, ax = s[4 * id]!, ay = s[4 * id + 1]!, ex = s[4 * id + 2]! - ax, ey = s[4 * id + 3]! - ay;
          const den = d[0] * ey - d[1] * ex;
          if (Math.abs(den) < 1e-9) continue;
          const wx = ax - o[0], wy = ay - o[1];
          const t = (wx * ey - wy * ex) / den, u = (wx * d[1] - wy * d[0]) / den;
          if (t > 0.3 && t < best && u >= 0 && u <= 1) best = t;
        }
    return best <= max ? best : Infinity;
  }
}

// ---------------------------------------------------------------------------
// Rues
// ---------------------------------------------------------------------------
interface Rue {
  t: Troncon;
  c: P2[]; // centre de la chaussée (axe IGN décalé vers le milieu de la rue)
  n: P2[]; // normale gauche
  s: number[];
  W: number[]; // largeur de chaussée
  g: number[]; // limite extérieure du trottoir gauche (depuis le centre)
  d: number[]; // idem à droite
  L: number;
}

function reechantillonner(axe: P2[], pas: number): P2[] {
  const out: P2[] = [axe[0]!];
  for (let k = 1; k < axe.length; k++) {
    const A = axe[k - 1]!, B = axe[k]!, l = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const m = Math.ceil(l / pas);
    for (let j = 1; j <= m; j++) out.push([A[0] + ((B[0] - A[0]) * j) / m, A[1] + ((B[1] - A[1]) * j) / m]);
  }
  return out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1]![0], p[1] - out[i - 1]![1]) > 0.05);
}

function lisser(v: number[], r: number, median = false): number[] {
  return v.map((_, i) => {
    const w = v.slice(Math.max(0, i - r), i + r + 1).filter(Number.isFinite);
    if (!w.length) return v[i]!;
    if (median) return w.sort((a, b) => a - b)[w.length >> 1]!;
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
}

function normales(c: P2[]): P2[] {
  return c.map((_, k) => {
    const a = c[Math.max(0, k - 1)]!, b = c[Math.min(c.length - 1, k + 1)]!;
    const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    return [-ty / l, tx / l] as P2;
  });
}

function preparerRue(t: Troncon, axe: P2[], murs: Murs): { rue: Rue; entreFacades: boolean } {
  const c0 = reechantillonner(axe, COTES.pas);
  const n0 = normales(c0);
  const m = c0.length, base = Math.max(2.5, t.largeur.valeur);
  const W: number[] = [], off: number[] = [], dl: number[] = [], dr: number[] = [];
  let mesures = 0;
  for (let k = 0; k < m; k++) {
    const p = c0[k]!, nk = n0[k]!;
    const a = murs.rayon(p, nk, 40), b = murs.rayon(p, [-nk[0], -nk[1]], 40);
    dl.push(a), dr.push(b);
    if (t.pieton) (W.push(base), off.push(0));
    else if (Number.isFinite(a) && Number.isFinite(b)) {
      const G = a + b, tt = clamp(0.2 * G, COTES.trottoirMin, 6);
      let w = clamp(G - 2 * tt, base * 0.9, base * 1.9);
      w = Math.max(2.5, Math.min(w, G - 2 * COTES.trottoirMin));
      W.push(w), off.push(clamp((a - b) / 2, -2, 2));
      mesures++;
    } else W.push(Number.isFinite(a) || Number.isFinite(b) ? base * 1.15 : base), off.push(0);
  }
  // Aux carrefours les rayons ne trouvent plus de façade : on garde la dernière mesure (jusqu'à 30 m).
  const mes = W.map((_, k) => Number.isFinite(dl[k]!) && Number.isFinite(dr[k]!));
  if (!t.pieton && mesures)
    for (let k = 0; k < m; k++) {
      if (mes[k]) continue;
      let best = -1;
      for (let j = 1; j <= Math.ceil(30 / COTES.pas) && best < 0; j++)
        for (const q of [k - j, k + j]) if (q >= 0 && q < m && mes[q] && best < 0) best = q;
      if (best >= 0) (W[k] = W[best]!), (off[k] = off[best]!);
    }
  const Ws = lisser(lisser(W, 3, true), 1);
  const os = lisser(off, 3);
  const s: number[] = [0];
  for (let k = 1; k < m; k++) s.push(s[k - 1]! + Math.hypot(c0[k]![0] - c0[k - 1]![0], c0[k]![1] - c0[k - 1]![1]));
  const L = s[m - 1]!;
  const c: P2[] = c0.map((p, k) => {
    const f = clamp(Math.min(s[k]!, L - s[k]!) / 12, 0, 1); // pas de décalage aux carrefours
    return [p[0] + n0[k]![0] * os[k]! * f, p[1] + n0[k]![1] * os[k]! * f];
  });
  const n = normales(c);
  const dls = lisser(dl, 2, true), drs = lisser(dr, 2, true);
  const g: number[] = [], d: number[] = [];
  for (let k = 0; k < m; k++) {
    const h = Ws[k]! / 2, o = os[k]! * clamp(Math.min(s[k]!, L - s[k]!) / 12, 0, 1);
    g.push(Number.isFinite(dls[k]!) ? clamp(dls[k]! - o + 0.5, h + COTES.trottoirMin, h + 7) : h + 2.5);
    d.push(Number.isFinite(drs[k]!) ? clamp(drs[k]! + o + 0.5, h + COTES.trottoirMin, h + 7) : h + 2.5);
  }
  return { rue: { t, c, n, s, W: Ws, g, d, L }, entreFacades: mesures > m / 2 };
}

/** Bande le long d'une rue : quadrilatères par segment + disques aux extrémités. */
function bande(r: Rue, gauche: (k: number) => number, droite: (k: number) => number, bouts: (k: number) => number): Anneaux {
  const out: Anneaux = [];
  const pt = (k: number, l: number): [number, number] => {
    const C = r.c[k]!, N = r.n[k]!;
    return [C[0] + N[0] * l, C[1] + N[1] * l];
  };
  // un seul anneau par rue (côté gauche à l'aller, côté droit au retour) : le remplissage non nul
  // de Clipper absorbe les auto-intersections dans les virages serrés
  const ring: P2[] = [];
  for (let k = 0; k < r.c.length; k++) ring.push(pt(k, gauche(k)));
  for (let k = r.c.length - 1; k >= 0; k--) ring.push(pt(k, -droite(k)));
  if (aireSignee(ring) < 0) ring.reverse();
  out.push(ring);
  for (const k of [0, r.c.length - 1]) {
    const R = bouts(k), C = r.c[k]!, ring: P2[] = [];
    for (let j = 0; j < 16; j++) ring.push([C[0] + R * Math.cos((j * Math.PI) / 8), C[1] + R * Math.sin((j * Math.PI) / 8)]);
    out.push(ring);
  }
  return out;
}

/** Point, normale et largeur à l'abscisse s le long d'une rue. */
function en(r: Rue, s: number): { p: P2; n: P2; W: number } {
  s = clamp(s, 0, r.L);
  let k = 0;
  while (k < r.s.length - 2 && r.s[k + 1]! < s) k++;
  const l = r.s[k + 1]! - r.s[k]! || 1, f = clamp((s - r.s[k]!) / l, 0, 1);
  const A = r.c[k]!, B = r.c[k + 1]!;
  const tx = (B[0] - A[0]) / l, ty = (B[1] - A[1]) / l;
  return { p: [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f], n: [-ty, tx], W: r.W[k]! + (r.W[k + 1]! - r.W[k]!) * f };
}

/** Bande peinte entre s0 et s1, centrée sur l'écart latéral lat (fonction de la largeur locale). */
function peindre(out: P2[][], r: Rue, s0: number, s1: number, lat: (W: number) => number, w: number) {
  const n = Math.max(1, Math.ceil((s1 - s0) / 2));
  let prev = en(r, s0);
  for (let j = 1; j <= n; j++) {
    const cur = en(r, s0 + ((s1 - s0) * j) / n);
    const a = lat(prev.W), b = lat(cur.W);
    const q = (P: { p: P2; n: P2 }, l: number): P2 => [P.p[0] + P.n[0] * l, P.p[1] + P.n[1] * l];
    out.push([q(prev, a - w / 2), q(cur, b - w / 2), q(cur, b + w / 2), q(prev, a + w / 2)]);
    prev = cur;
  }
}

/** Petit trait perpendiculaire à l'axe (marques de stationnement). */
function trait(out: P2[][], r: Rue, s: number, l0: (W: number) => number, l1: (W: number) => number, w: number) {
  const P = en(r, s), tx = P.n[1], ty = -P.n[0];
  const a = l0(P.W), b = l1(P.W);
  const q = (l: number, e: number): P2 => [P.p[0] + P.n[0] * l + tx * e, P.p[1] + P.n[1] * l + ty * e];
  out.push([q(a, -w / 2), q(b, -w / 2), q(b, w / 2), q(a, w / 2)]);
}

export interface OptionsVoirie {
  /** Emprise de calcul [xmin, ymin, xmax, ymax] en Lambert-93. */
  emprise: [number, number, number, number];
}

/** Construit toute la voirie d'un quartier. Pur et déterministe (testable sans rendu). */
export function construireVoirie(troncons: Troncon[], batiments: Batiment[], opt: OptionsVoirie): Voirie {
  const [x0, y0, x1, y1] = opt.emprise;
  const L = (p: XY): P2 => [p.x - x0, p.y - y0];
  const G = (q: P2): XY => ({ x: q[0] + x0, y: q[1] + y0 });
  const cadre: Anneaux = [[[0, 0], [x1 - x0, 0], [x1 - x0, y1 - y0], [0, y1 - y0]]];

  const murs = new Murs();
  const emprises: Anneaux = [];
  for (const b of batiments) {
    const r = b.contour.map(L);
    if (r.length < 3) continue;
    for (let i = 0; i < r.length; i++) murs.ajouter(r[i]!, r[(i + 1) % r.length]!);
    emprises.push(r);
  }

  const rues: Rue[] = [];
  const largeurs = new Map<string, Donnee<number>>();
  for (const t of troncons) {
    const axe = t.axe.map(L);
    if (axe.every(([x, y]) => x < -60 || y < -60 || x > x1 - x0 + 60 || y > y1 - y0 + 60)) continue;
    const { rue, entreFacades } = preparerRue(t, axe, murs);
    if (rue.L < 0.5) continue;
    rues.push(rue);
    const med = [...rue.W].sort((a, b) => a - b)[rue.W.length >> 1]!;
    largeurs.set(
      t.id,
      entreFacades && !t.pieton
        ? donnee(Math.round(med * 10) / 10, 'deduit', 'Lumen : largeur IGN ajustée à l’espace entre façades BD TOPO')
        : t.largeur,
    );
  }
  const routes = rues.filter((r) => !r.t.pieton);

  // Carrefours : extrémités qui se touchent (BD TOPO coupe les tronçons aux intersections).
  const noeuds = new Map<string, { r: Rue; fin: 0 | 1 }[]>();
  const cleN = (p: P2) => `${Math.round(p[0])},${Math.round(p[1])}`;
  for (const r of routes)
    for (const fin of [0, 1] as const) {
      const k = cleN(r.c[fin ? r.c.length - 1 : 0]!);
      const l = noeuds.get(k);
      l ? l.push({ r, fin }) : noeuds.set(k, [{ r, fin }]);
    }
  const voisins = (r: Rue, fin: 0 | 1) =>
    (noeuds.get(cleN(r.c[fin ? r.c.length - 1 : 0]!)) ?? []).filter((e) => e.r !== r || e.fin !== fin);

  // Chaussée : union de toutes les bandes, clippée, angles de rue arrondis.
  const bandesCh = routes.flatMap((r) => bande(r, (k) => r.W[k]! / 2, (k) => r.W[k]! / 2, (k) => r.W[k]! / 2));
  // arrondi avant le découpage à l'emprise, pour ne pas arrondir les coins du cadre
  const chaussee = nettoyer(booleen('inter', aplatir(nettoyer(booleen('union', bandesCh), 4, [COTES.rayonAngle, 0.6])), cadre), 4);
  const chPoly = aplatir(chaussee);

  // Trottoirs : de la chaussée jusqu'aux façades, moins les bâtiments.
  const zones = routes.flatMap((r) => bande(r, (k) => r.g[k]!, (k) => r.d[k]!, (k) => r.W[k]! / 2 + 1.5));
  const tr = booleen('diff', aplatir(booleen('inter', zones, cadre)), [...chPoly, ...emprises]);
  const trottoirs = nettoyer(tr, 2);

  // Allées piétonnes (sentiers, chemins) hors chaussée et bâtiments.
  const piet = rues.filter((r) => r.t.pieton).flatMap((r) => bande(r, () => 1.1, () => 1.1, () => 1.1));
  const al = piet.length ? booleen('diff', aplatir(booleen('inter', piet, cadre)), [...chPoly, ...aplatir(trottoirs), ...emprises]) : [];
  const allees = nettoyer(al, 2);

  // Bordures : arêtes de la chaussée bordées par un trottoir (trottoir à droite, à 25 cm).
  const bboxes = trottoirs.map((p) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of p[0]!) (a = Math.min(a, x)), (b = Math.min(b, y)), (c = Math.max(c, x)), (d = Math.max(d, y));
    return [a, b, c, d] as const;
  });
  const surTrottoir = (x: number, y: number) =>
    trottoirs.some((p, i) => {
      const b = bboxes[i]!;
      return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && dansPoly(p, x, y);
    });
  const bordures: { pts: P2[]; ferme: boolean }[] = [];
  for (const poly of chaussee)
    for (const ring of poly) {
      const n = ring.length, ok: boolean[] = [];
      for (let i = 0; i < n; i++) {
        const A = ring[i]!, B = ring[(i + 1) % n]!, l = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
        const mx = (A[0] + B[0]) / 2 + ((B[1] - A[1]) / l) * 0.25, my = (A[1] + B[1]) / 2 - ((B[0] - A[0]) / l) * 0.25;
        ok.push(surTrottoir(mx, my));
      }
      if (ok.every(Boolean)) {
        bordures.push({ pts: ring, ferme: true });
        continue;
      }
      const debut = ok.findIndex((v, i) => v && !ok[(i - 1 + n) % n]);
      if (debut < 0) continue;
      let cur: P2[] | null = null;
      for (let j = 0; j < n; j++) {
        const i = (debut + j) % n;
        if (ok[i]) {
          cur ??= [ring[i]!];
          cur.push(ring[(i + 1) % n]!);
        } else if (cur) (cur.length > 1 && bordures.push({ pts: cur, ferme: false }), (cur = null));
      }
      if (cur && cur.length > 1) bordures.push({ pts: cur, ferme: false });
    }

  // Marquages, passages piétons, stationnement, regards.
  const marquages: P2[][] = [], passages: P2[][] = [], regards: P2[] = [];
  const { passage: PP, axe: AX, stationnement: ST } = COTES;
  for (const r of routes) {
    const recul = [0, 0], zebra = [false, false];
    for (const fin of [0, 1] as const) {
      const v = voisins(r, fin);
      const W = r.W[fin ? r.W.length - 1 : 0]!;
      if (v.length >= 2) {
        recul[fin] = Math.max(...v.map((e) => e.r.W[e.fin ? e.r.W.length - 1 : 0]! / 2)) + PP.recul;
        zebra[fin] = W >= 4 && r.L > recul[fin]! + PP.longueur + 4;
      } else if (v.length === 0) recul[fin] = 1;
    }
    const sA = recul[0]! + (zebra[0] ? PP.longueur + 1.5 : 0);
    const sB = r.L - recul[1]! - (zebra[1] ? PP.longueur + 1.5 : 0);
    for (const fin of [0, 1] as const) {
      if (!zebra[fin]) continue;
      const a = fin ? r.L - recul[1]! - PP.longueur : recul[0]!;
      const W = en(r, a).W, nb = Math.floor((W - 0.6 + PP.intervalle) / (PP.bande + PP.intervalle));
      const l0 = -((nb - 1) * (PP.bande + PP.intervalle)) / 2;
      for (let i = 0; i < nb; i++) peindre(passages, r, a, a + PP.longueur, () => l0 + i * (PP.bande + PP.intervalle), PP.bande);
    }
    if (sB - sA < 3 || r.t.importance >= 6) continue;
    const Wm = r.W.reduce((a, b) => a + b, 0) / r.W.length;
    // côté du stationnement : à droite du sens de circulation
    const cote = r.t.sens === 'inverse' ? 1 : -1;
    const voiesW = r.t.voies * 3.1;
    const parkDeux = r.t.sens === 'double' && Wm - voiesW >= 2 * ST.largeur - 0.2;
    const parkUn = !parkDeux && Wm - voiesW >= ST.largeur - 0.1;
    const tirets = (lat: (W: number) => number) => {
      for (let s = sA + (hash(r.c[0]![0], r.c[0]![1]) * AX.periode) % AX.periode; s < sB; s += AX.periode)
        peindre(marquages, r, s, Math.min(s + AX.trait, sB), lat, AX.largeur);
    };
    const bord = (sg: number) => (W: number) => sg * (W / 2 - ST.largeur);
    if (r.t.sens === 'double' && r.t.voies >= 2 && Wm >= 5.5) tirets(() => 0);
    if (r.t.sens !== 'double' && r.t.voies >= 2) {
      for (let i = 1; i < r.t.voies; i++)
        tirets((W) => {
          const libre = W - (parkUn ? ST.largeur : 0), x = -libre / 2 + (libre * i) / r.t.voies;
          return parkUn ? x - (cote * ST.largeur) / 2 : x;
        });
    }
    for (const sg of parkDeux ? [1, -1] : parkUn ? [cote] : []) {
      for (let s = sA + 1; s < sB - 1; s += ST.pas) {
        peindre(marquages, r, s - 0.5, s + 0.5, bord(sg), 0.1);
        trait(marquages, r, s, bord(sg), (W) => sg * (W / 2 - ST.largeur + 0.5), 0.1);
      }
    }
    for (let s = sA + 10 + hash(r.c[0]![1], r.L) * 30; s < sB - 5; s += 40 + hash(s, r.L) * 20) regards.push(en(r, s).p);
  }

  // Avaloirs (bouches d'égout) le long des bordures, tous les 30 à 45 m.
  const avaloirs: { p: P2; dir: P2 }[] = [];
  for (const b of bordures) {
    let acc = 8 + hash(b.pts[0]![0], b.pts[0]![1]) * 20;
    for (let i = 0; i < b.pts.length - 1; i++) {
      const A = b.pts[i]!, B = b.pts[i + 1]!, l = Math.hypot(B[0] - A[0], B[1] - A[1]);
      while (acc < l && l > 1.5) {
        const f = acc / l;
        avaloirs.push({ p: [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f], dir: [(B[0] - A[0]) / l, (B[1] - A[1]) / l] });
        acc += 30 + hash(A[0] + acc, A[1]) * 15;
      }
      acc -= l;
    }
  }

  const P = (poly: P2[][]): Poly => poly.map((r) => r.map(G));
  const Q = (q: P2[]): Quad => [G(q[0]!), G(q[1]!), G(q[2]!), G(q[3]!)];
  const dedans = ([x, y]: P2) => x >= 0 && y >= 0 && x <= x1 - x0 && y <= y1 - y0;
  return {
    chaussee: chaussee.map(P),
    trottoirs: trottoirs.map(P),
    allees: allees.map(P),
    bordures: bordures.map((b) => ({ pts: b.pts.map(G), ferme: b.ferme })),
    marquages: marquages.filter((q) => q.every(dedans)).map(Q),
    passages: passages.filter((q) => q.every(dedans)).map(Q),
    avaloirs: avaloirs.map((a) => ({ p: G(a.p), dir: { x: a.dir[0], y: a.dir[1] } })),
    regards: regards.filter(dedans).map(G),
    largeurs,
    provenance: {
      axes: { source: 'mesure', origine: 'IGN BD TOPO troncon_de_route' },
      chaussee: { source: 'deduit', origine: 'Lumen : largeur IGN ajustée entre façades, angles arrondis (r = 4 m)' },
      trottoirs: { source: 'deduit', origine: 'Lumen : espace entre chaussée et façades BD TOPO' },
      bordures: { source: 'deduit', origine: 'Lumen : bord de chaussée, hauteur 14 cm standard' },
      marquages: { source: 'genere', origine: 'Lumen : marquages types (IISR 7e partie), non relevés' },
      passages: { source: 'genere', origine: 'Lumen : passage piéton type à chaque carrefour, non relevé' },
      mobilier: { source: 'genere', origine: 'Lumen : avaloirs et regards placés au hasard' },
    },
  };
}
