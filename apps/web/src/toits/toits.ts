/**
 * Toits v2 — reconstruction « couvreur » d'après le LiDAR HD.
 *
 * Principe (méthode des modèles LOD2 de villes, adaptée à Paris) :
 *  1. Chaque mur de l'emprise BD TOPO est classé : ÉGOUT (sur rue ou cour, une gouttière) ou MITOYEN (bâti contigu :
 *     autre emprise BD TOPO ou LiDAR haut juste derrière). Les murs presque alignés sont fusionnés en une seule ligne
 *     d'égout ; les petits décrochés ne créent pas de pans (pas de formes « jamais vues »).
 *  2. Le PROFIL du toit est mesuré une fois par bâtiment sur le LiDAR (hauteur au-dessus de la gouttière en fonction
 *     de la distance au mur, médiane sur tous les murs d'égout), puis ajusté à un modèle de couvreur :
 *       terrasse · pans (une pente, 15–60°) · mansarde (brisis 72° + terrasson 0–30°) · plafond = faîte mesuré.
 *     Mêmes pentes sur tout le bâtiment ⇒ arêtiers, noues et faîtages cohérents, comme un vrai toit.
 *  3. Chaque ligne d'égout porte ses PLANS (brisis, terrasson ou pan) ; le toit est l'enveloppe basse de ces plans,
 *     chacun n'agissant que dans son « champ » (devant son mur, cône à 45° aux extrémités, sans traverser le vide).
 *  4. Géométrie EXACTE : triangulation de l'emprise, puis chaque triangle est découpé le long des intersections
 *     de plans (arêtiers, noues, ligne de brisis) → facettes planes, arêtes nettes, pas de stries.
 *  5. Étanche par construction : murs posés sur le contour exact (façade sur rue, mur plein ailleurs, pignon sur
 *     mitoyen), débord d'égout, et un fond de toit sombre sous chaque bâtiment (aucun trou visible).
 */
import * as THREE from 'three';
import type { Batiment, XY } from '@lumen/core';
import type { FacadeSpec, Typologie } from '@lumen/facades';
import type { TacheFacade } from '../facades/mesher';
import { bruit, fabriquer, lisse } from '../facades/textures';

export type FormeToit = 'terrasse' | 'mansarde' | 'pentes';
export type Couverture = 'zinc' | 'ardoise' | 'tuile' | 'terrasse';

export interface ParamsToitsProc {
  batiments: Batiment[];
  /** Toutes les emprises (y compris hors zone) pour reconnaître les mitoyens. */
  voisins?: Batiment[];
  taches: TacheFacade[];
  spec?: (t: TacheFacade) => FacadeSpec;
  mns: (p: XY) => number;
  sol: (p: XY) => number;
  typologie: (id: string) => Typologie | undefined;
  versS: (p: XY) => { x: number; z: number };
  y: (alt: number) => number;
  centre: XY;
  mobile: boolean;
  aniso: number;
  /** Matériaux des murs pleins (ceux des façades : même pierre, même patine). */
  murs?: Record<'pierre' | 'brique' | 'enduit' | 'beton', THREE.Material>;
}

export interface ToitBat {
  id: string;
  zG: number;
  zGmin: number;
  zTop: number;
  forme: FormeToit;
  couverture: Couverture;
  hBrisis: number;
  pente: number;
  /** écart quadratique moyen modèle ↔ LiDAR (m) */
  rms: number;
}

interface Mur { A: XY; B: XY; L: number; ux: number; uy: number; nx: number; ny: number; egout: boolean; tache: TacheFacade | null; ring: number }
interface Ligne { A: XY; B: XY; L: number; ux: number; uy: number; nx: number; ny: number; zG: number; murs: Mur[] }
/** plan z = a·x + b·y + c (L93), avec sa ligne d'égout et son type */
interface Plan { a: number; b: number; c: number; ligne: number; type: 'brisis' | 'terrasson' | 'pan' | 'plafond' }
interface Modele { forme: FormeToit; hB: number; tanT: number; tanP: number; hTop: number; err: number }

const DEG = Math.PI / 180;
const TAN_BRISIS = Math.tan(72 * DEG);

function dansAnneau(r: XY[], p: XY) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i]!, b = r[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
const dansBat = (b: Batiment, p: XY) => dansAnneau(b.contour, p) && !(b.trous ?? []).some((t) => dansAnneau(t, p));
const med = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]! : NaN);
const quantile = (v: number[], q: number) => (v.length ? [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * q))]! : NaN);

// ---------------------------------------------------------------------------
// Textures de couverture
// ---------------------------------------------------------------------------
function texZinc(aniso: number) {
  const R = bruit(21), tache = new Float32Array(32 * 8).map(() => R());
  return fabriquer(256, 2.4, (x, y) => {
    const u = (x / 256) * 2.4, v = (y / 256) * 2.4;
    const j = Math.min(u % 0.6, 0.6 - (u % 0.6));
    const joint = 1 - lisse(0.006, 0.022, j);
    const t = tache[Math.floor(u / 0.6) * 8 + (Math.floor(v / 0.6) % 8)]! * 0.05;
    const g = (R() - 0.5) * 0.03;
    return [0.42 + t + g + joint * 0.1, 0.3 + joint * 0.7, 0.46 + t + g + joint * 0.09, 0.5 + t + g + joint * 0.09];
  }, aniso, 6);
}
function texArdoise(aniso: number) {
  const R = bruit(23), v_ = new Float32Array(256).map(() => R());
  return fabriquer(256, 1.2, (x, y) => {
    const u = (x / 256) * 1.2, v = (y / 256) * 1.2;
    const rang = Math.floor(v / 0.15), uu = (u + (rang % 2) * 0.1) % 1.2;
    const jy = (v % 0.15) / 0.15, jx = Math.min(uu % 0.2, 0.2 - (uu % 0.2));
    const bord = 1 - lisse(0.0, 0.08, jy), fente = 1 - lisse(0.002, 0.006, jx);
    const t = v_[(rang * 7 + Math.floor(uu / 0.2)) % 256]! * 0.06;
    const c = 0.3 + t - bord * 0.08 - fente * 0.08;
    return [c, 1 - jy * 0.5 - fente * 0.3, c * 1.04, c * 1.1];
  }, aniso, 4);
}
function texTuile(aniso: number) {
  const R = bruit(25), v_ = new Float32Array(256).map(() => R());
  return fabriquer(256, 1.2, (x, y) => {
    const u = (x / 256) * 1.2, v = (y / 256) * 1.2;
    const rang = Math.floor(v / 0.3);
    const jy = (v % 0.3) / 0.3, cu = ((u + (rang % 2) * 0.1) % 0.2) / 0.2;
    const onde = Math.sin(cu * Math.PI);
    const t = v_[(rang * 5 + Math.floor(u / 0.2)) % 256]! * 0.12;
    const om = 1 - lisse(0, 0.12, jy);
    return [0.66 + t + onde * 0.08 - om * 0.2, onde * 0.6 + (1 - om) * 0.4, 0.36 + t * 0.6 + onde * 0.04 - om * 0.12, 0.26 + t * 0.4 - om * 0.1];
  }, aniso, 4);
}
function texTerrasse(aniso: number) {
  const R = bruit(27);
  return fabriquer(128, 2, () => {
    const g = R();
    return [0.55 + g * 0.12, g, 0.55 + g * 0.11, 0.53 + g * 0.1];
  }, aniso, 1);
}

// ---------------------------------------------------------------------------
// 1. Murs (égout / mitoyen) et lignes d'égout fusionnées
// ---------------------------------------------------------------------------
function indexEmprises(bats: Batiment[]) {
  const T = 25, g = new Map<string, Batiment[]>();
  for (const b of bats) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of b.contour) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
    for (let i = Math.floor(x0 / T); i <= Math.floor(x1 / T); i++)
      for (let j = Math.floor(y0 / T); j <= Math.floor(y1 / T); j++) {
        const k = i + ',' + j;
        (g.get(k) ?? g.set(k, []).get(k)!).push(b);
      }
  }
  return (p: XY, sauf: string) => (g.get(Math.floor(p.x / T) + ',' + Math.floor(p.y / T)) ?? []).some((b) => b.id !== sauf && dansBat(b, p));
}

function classerMurs(b: Batiment, P: ParamsToitsProc, occupe: (p: XY, sauf: string) => boolean, taches: TacheFacade[]): Mur[] {
  const parIdx = new Map(taches.map((t) => [Number(t.id.split(':')[1]), t]));
  const out: Mur[] = [];
  [b.contour, ...(b.trous ?? [])].forEach((r, ring) =>
    r.forEach((A, i) => {
      const B = r[(i + 1) % r.length]!, L = Math.hypot(B.x - A.x, B.y - A.y);
      if (L < 0.05) return;
      const ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
      let nx = uy, ny = -ux;
      const m = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      if (dansBat(b, { x: m.x + nx * 0.25, y: m.y + ny * 0.25 })) (nx = -nx), (ny = -ny);
      const tache = ring === 0 ? parIdx.get(i) ?? null : null;
      let mit = 0, haut = 0, n = 0;
      for (const f of [0.2, 0.5, 0.8]) {
        const q = { x: A.x + (B.x - A.x) * f + nx * 0.8, y: A.y + (B.y - A.y) * f + ny * 0.8 };
        if (occupe(q, b.id)) mit++;
        const q2 = { x: A.x + (B.x - A.x) * f + nx * 1.5, y: A.y + (B.y - A.y) * f + ny * 1.5 };
        const z = P.mns(q2);
        if (Number.isFinite(z)) (n++, z - P.sol(q2) > 3.5 && haut++);
      }
      const egout = !!tache || !(mit >= 2 || (n > 0 && haut / n >= 0.67));
      out.push({ A, B, L, ux, uy, nx, ny, egout, tache, ring });
    }),
  );
  if (!out.some((m) => m.egout)) out.forEach((m) => (m.egout = true));
  return out;
}

/** Fusionne les murs d'égout consécutifs presque alignés (≤ 14°, décroché ≤ 0,6 m) en lignes d'égout. */
function fusionner(ms: Mur[]): Ligne[] {
  const res: Ligne[] = [];
  const parRing = new Map<number, Mur[]>();
  for (const m of ms) (parRing.get(m.ring) ?? parRing.set(m.ring, []).get(m.ring)!).push(m);
  for (const r of parRing.values()) {
    let start = r.findIndex((m, i) => {
      const p = r[(i - 1 + r.length) % r.length]!;
      return !p.egout || !m.egout || p.ux * m.ux + p.uy * m.uy < Math.cos(22 * DEG);
    });
    if (start < 0) start = 0;
    let cur: Mur[] = [];
    const finir = () => {
      if (!cur.length) return;
      const A = cur[0]!.A, B = cur[cur.length - 1]!.B, L = Math.hypot(B.x - A.x, B.y - A.y);
      if (L >= 1.0) {
        const ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
        let nx = 0, ny = 0;
        for (const m of cur) (nx += m.nx * m.L), (ny += m.ny * m.L);
        const s = Math.sign(nx * uy - ny * ux) || 1;
        res.push({ A, B, L, ux, uy, nx: uy * s, ny: -ux * s, zG: NaN, murs: cur });
      }
      cur = [];
    };
    for (let k = 0; k < r.length; k++) {
      const m = r[(start + k) % r.length]!;
      if (!m.egout) { finir(); continue; }
      if (cur.length) {
        const A = cur[0]!.A, L0 = Math.hypot(m.B.x - A.x, m.B.y - A.y);
        const ux = (m.B.x - A.x) / L0, uy = (m.B.y - A.y) / L0;
        const ok = m.ux * ux + m.uy * uy > Math.cos(22 * DEG) && cur.every((c) => Math.abs((c.B.x - A.x) * uy - (c.B.y - A.y) * ux) <= 1.0);
        if (!ok) finir();
      }
      cur.push(m);
    }
    finir();
  }
  return res;
}

// ---------------------------------------------------------------------------
// 2. Modèle de couvreur ajusté au profil LiDAR
// ---------------------------------------------------------------------------
function ajuster(profil: { d: number; h: number; w: number }[], hTop: number, typo: Typologie | undefined): Modele {
  const evalue = (f: (d: number) => number) => {
    let e = 0, sw = 0;
    for (const p of profil) {
      const r = Math.min(f(p.d), hTop) - p.h;
      e += p.w * Math.min(r * r, 9);
      sw += p.w;
    }
    return sw ? e / sw : Infinity;
  };
  const cands: Modele[] = [{ forme: 'terrasse', hB: 0, tanT: 0, tanP: 0, hTop: 0.25, err: evalue(() => 0.2) + 0.02 }];
  for (let s = 15; s <= 60; s += 2.5) {
    const t = Math.tan(s * DEG);
    cands.push({ forme: 'pentes', hB: 0, tanT: 0, tanP: t, hTop, err: evalue((d) => d * t) });
  }
  for (let hB = 1.5; hB <= Math.min(4.2, hTop); hB += 0.25)
    for (let s = 0; s <= 30; s += 2.5) {
      const t = Math.tan(s * DEG), r = hB / TAN_BRISIS;
      cands.push({ forme: 'mansarde', hB, tanT: t, tanP: 0, hTop, err: evalue((d) => (d <= r ? d * TAN_BRISIS : hB + (d - r) * t)) + 0.01 });
    }
  const prior = (m: Modele) =>
    (typo === 'haussmannien' || typo === 'post-haussmannien') && m.forme === 'mansarde' ? -0.05
      : (typo === 'moderne' || typo === 'tour' || typo === 'bureaux' || typo === 'contemporain') && m.forme === 'terrasse' ? -0.06 : 0;
  return cands.reduce((a, b) => (b.err + prior(b) < a.err + prior(a) ? b : a));
}

function parDefaut(typo: Typologie | undefined, hTop: number): Modele {
  if (typo === 'haussmannien' || typo === 'post-haussmannien' || typo === 'equipement')
    return { forme: 'mansarde', hB: Math.min(2.8, Math.max(1.6, hTop || 2.8)), tanT: Math.tan(18 * DEG), tanP: 0, hTop: Math.max(hTop, 3.5), err: NaN };
  if (typo === 'faubourien' || typo === 'brique') return { forme: 'pentes', hB: 0, tanT: 0, tanP: Math.tan(35 * DEG), hTop: Math.max(hTop, 3), err: NaN };
  return { forme: 'terrasse', hB: 0, tanT: 0, tanP: 0, hTop: 0.25, err: NaN };
}

function plansDe(li: Ligne[], M: Modele, zTop: number): Plan[] {
  const out: Plan[] = [];
  li.forEach((l, k) => {
    // d(p) = (p − A)·n_int, n_int = −n (n sortante)
    const ix = -l.nx, iy = -l.ny, c0 = -(l.A.x * ix + l.A.y * iy);
    const plan = (pente: number, z0: number, type: Plan['type']) => out.push({ a: pente * ix, b: pente * iy, c: z0 + pente * c0, ligne: k, type });
    if (M.forme === 'mansarde') {
      const run = M.hB / TAN_BRISIS;
      plan(TAN_BRISIS, l.zG, 'brisis');
      plan(M.tanT, l.zG + M.hB - run * M.tanT, 'terrasson');
    } else if (M.forme === 'pentes') plan(M.tanP, l.zG, 'pan');
  });
  out.push({ a: 0, b: 0, c: zTop, ligne: -1, type: 'plafond' });
  return out;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------
export function construireToits(P: ParamsToitsProc) {
  const groupe = new THREE.Group();
  groupe.name = 'toits';
  const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
  const mats: Record<string, THREE.Material> = {
    zinc: std({ roughness: 0.58, metalness: 0.12, vertexColors: true }),
    ardoise: std({ roughness: 0.55, metalness: 0.1, vertexColors: true }),
    tuile: std({ roughness: 0.8, metalness: 0, vertexColors: true }),
    terrasse: std({ roughness: 0.95, metalness: 0, vertexColors: true }),
    acrotere: std({ color: 0xbdb7ab, roughness: 0.9 }),
    lucarne: std({ color: 0xe4dccb, roughness: 0.85 }),
    vitre: std({ color: 0x3e4852, roughness: 0.08, metalness: 0.55 }),
    fond: std({ color: 0x3b3f44, roughness: 0.9 }),
    mur: std({ color: 0xffffff, roughness: 0.92, vertexColors: true }),
  };
  for (const [k, t] of [['zinc', texZinc(P.aniso)], ['ardoise', texArdoise(P.aniso)], ['tuile', texTuile(P.aniso)], ['terrasse', texTerrasse(P.aniso)]] as const) {
    const m = mats[k] as THREE.MeshStandardMaterial;
    (m.map = t.map), (m.normalMap = t.normal);
  }
  for (const [k, m] of Object.entries(mats)) (m.name = 'toit_' + k), ((m as THREE.MeshStandardMaterial).customProgramCacheKey = () => 'toit_' + k);
  if (P.murs) Object.assign(mats, { murPierre: P.murs.pierre, murBrique: P.murs.brique, murEnduit: P.murs.enduit, murBeton: P.murs.beton });

  const occupe = indexEmprises(P.voisins ?? P.batiments);
  const parBat = new Map<string, TacheFacade[]>();
  for (const t of P.taches) {
    const k = t.id.split(':')[0]!;
    (parBat.get(k) ?? parBat.set(k, []).get(k)!).push(t);
  }
  type Buf = { p: number[]; n: number[]; uv: number[]; c: number[] };
  const bufs = new Map<string, Buf>();
  const buf = (k: string) => bufs.get(k) ?? bufs.set(k, { p: [], n: [], uv: [], c: [] }).get(k)!;
  const toits = new Map<string, ToitBat>();
  const hauteurs = new Map<string, (p: XY) => number>();
  const stats = { batiments: 0, triangles: 0, mansardes: 0, pentes: 0, terrasses: 0, lucarnes: 0, rmsMedian: 0, ms: 0, echecs: 0 };
  const rmsTous: number[] = [];
  const t0 = performance.now();

  const S = (p: XY, z: number): number[] => { const q = P.versS(p); return [q.x, P.y(z), q.z]; };
  const tri = (k: string, a: number[], b: number[], c: number[], uva: number[], uvb: number[], uvc: number[], col: number[], versHaut = true) => {
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    let n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (!(l > 1e-9)) return;
    if (versHaut && n[1]! < 0) {
      [b, c] = [c, b];
      [uvb, uvc] = [uvc, uvb];
      n = n.map((x) => -x);
    }
    const B = buf(k);
    B.p.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) B.n.push(n[0]! / l, n[1]! / l, n[2]! / l);
    B.uv.push(...uva, ...uvb, ...uvc);
    for (let i = 0; i < 3; i++) B.c.push(...col);
  };
  const quad = (k: string, q: number[][], vers: number[], uv: number[][], col = [1, 1, 1]) => {
    const [a, b, c, d] = q as [number[], number[], number[], number[]];
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    if (n[0]! * vers[0]! + n[1]! * vers[1]! + n[2]! * vers[2]! >= 0) (tri(k, a, b, c, uv[0]!, uv[1]!, uv[2]!, col, false), tri(k, a, c, d, uv[0]!, uv[2]!, uv[3]!, col, false));
    else (tri(k, a, c, b, uv[0]!, uv[2]!, uv[1]!, col, false), tri(k, a, d, c, uv[0]!, uv[3]!, uv[2]!, col, false));
  };
  const versScene = (nx: number, ny: number) => { const q0 = P.versS({ x: 0, y: 0 }), q1 = P.versS({ x: nx, y: ny }); return [q1.x - q0.x, 0, q1.z - q0.z]; };

  const construireUn = (b: Batiment) => {
    const ts = parBat.get(b.id) ?? [];
    const typo = P.typologie(b.id);
    const ms = classerMurs(b, P, occupe, ts);
    const li = fusionner(ms);
    if (!li.length) return;
    const solB = Math.min(...b.contour.map((p) => P.sol(p)));
    const zBd = b.altitudeSol.valeur + b.hauteur.valeur;

    // --- égouts : façade mesurée, sinon LiDAR juste derrière le mur ; alignés sur la médiane à 0,7 m près ---
    for (const l of li) {
      const zt = l.murs.filter((m) => m.tache).map((m) => m.tache!.y + m.tache!.hGout - P.y(0));
      if (zt.length) { l.zG = med(zt); continue; }
      const v: number[] = [];
      for (let s = Math.min(0.6, l.L / 2); s < l.L; s += 1.2) {
        const z = P.mns({ x: l.A.x + l.ux * s - l.nx * 0.7, y: l.A.y + l.uy * s - l.ny * 0.7 });
        if (Number.isFinite(z)) v.push(z);
      }
      l.zG = v.length ? quantile(v, 0.3) : NaN;
    }
    const ok = li.filter((l) => Number.isFinite(l.zG) && l.zG > solB + 2.5);
    let zG = ok.length ? med(ok.map((l) => l.zG)) : zBd;
    if (!Number.isFinite(zG) || zG < solB + 2.5) zG = zBd;
    if (!Number.isFinite(zG)) return;
    for (const l of li) {
      if (!(Number.isFinite(l.zG) && l.zG > solB + 2.5) || Math.abs(l.zG - zG) < 0.7) l.zG = zG;
      for (const m of l.murs) if (m.tache) m.tache.hGout = Math.max(3, P.y(l.zG) - m.tache.y);
    }
    const zGmin = Math.min(...li.map((l) => l.zG));

    // --- profil LiDAR et faîte ---
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of b.contour) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
    const parD = new Map<number, number[]>();
    for (const l of li)
      for (let s = Math.min(1, l.L / 3); s <= l.L - Math.min(1, l.L / 3) + 1e-6; s += 1.5)
        for (let d = 0.5; d <= 14; d += 0.5) {
          const q = { x: l.A.x + l.ux * s - l.nx * d, y: l.A.y + l.uy * s - l.ny * d };
          if (!dansBat(b, q)) break;
          const z = P.mns(q);
          if (Number.isFinite(z)) (parD.get(d) ?? parD.set(d, []).get(d)!).push(z - l.zG);
        }
    const profil = [...parD.entries()].filter(([, v]) => v.length >= 2).map(([d, v]) => ({ d, h: med(v), w: (d < 4 ? 2 : 1) * Math.sqrt(v.length) }));
    const pasT = Math.max(0.8, Math.sqrt(((x1 - x0) * (y1 - y0)) / 400));
    const zs: number[] = [];
    for (let x = x0 + pasT / 2; x < x1; x += pasT)
      for (let y = y0 + pasT / 2; y < y1; y += pasT)
        if (dansBat(b, { x, y })) {
          const z = P.mns({ x, y });
          if (Number.isFinite(z)) zs.push(z);
        }
    const hTop = zs.length >= 6 ? Math.min(12, Math.max(0.3, quantile(zs, 0.85) - zG)) : NaN;
    let M = profil.length >= 4 && Number.isFinite(hTop) ? ajuster(profil, hTop, typo) : parDefaut(typo, Number.isFinite(hTop) ? hTop : 0);
    if (M.forme !== 'terrasse' && M.hTop < 1) M = { ...M, forme: 'terrasse' };
    const terrasse = M.forme === 'terrasse';
    const zTop = zG + (terrasse ? 0.25 : M.hTop);
    // seules les vraies lignes d'égout (≥ 2,5 m) portent un pan : un petit décroché ne crée pas de pan parasite
    const liP = li.filter((l) => l.L >= 2.5).length ? li.filter((l) => l.L >= 2.5) : li;
    const plans = plansDe(liP, M, zTop);

    // --- enveloppe basse des plans, chacun dans son champ ---
    const actif = (pl: Plan, p: XY) => {
      if (pl.ligne < 0) return true;
      const l = liP[pl.ligne]!;
      const d = -((p.x - l.A.x) * l.nx + (p.y - l.A.y) * l.ny);
      if (d < -0.05) return false;
      const t = (p.x - l.A.x) * l.ux + (p.y - l.A.y) * l.uy;
      return t >= -d - 0.3 && t <= l.L + d + 0.3;
    };
    const zPlan = (pl: Plan, p: XY) => pl.a * p.x + pl.b * p.y + pl.c;
    const label = (p: XY) => {
      let z = Infinity, k = plans.length - 1;
      for (let i = 0; i < plans.length; i++) {
        const pl = plans[i]!;
        if (!actif(pl, p)) continue;
        const v = zPlan(pl, p);
        if (v < z - 1e-9) (z = v), (k = i);
      }
      return k;
    };
    const H = (p: XY) => (terrasse ? zG + 0.2 : Math.max(zGmin, zPlan(plans[label(p)]!, p)));
    hauteurs.set(b.id, H);

    // contrôle de fidélité au LiDAR
    let e2 = 0, ne = 0;
    for (let x = x0 + pasT / 2; x < x1; x += pasT * 2)
      for (let y = y0 + pasT / 2; y < y1; y += pasT * 2)
        if (dansBat(b, { x, y })) {
          const z = P.mns({ x, y });
          if (Number.isFinite(z)) { const r = H({ x, y }) - z; e2 += Math.min(r * r, 25); ne++; }
        }
    const rms = ne ? Math.sqrt(e2 / ne) : NaN;
    if (Number.isFinite(rms)) rmsTous.push(rms);

    const tc = b.toiture ?? '';
    let couverture: Couverture = terrasse ? 'terrasse' : tc.includes('3') ? 'zinc' : tc.includes('2') ? 'ardoise' : tc.includes('1') ? 'tuile'
      : typo === 'brique' || (typo === 'faubourien' && M.forme === 'pentes') ? 'tuile' : typo === 'equipement' ? 'ardoise' : 'zinc';
    if (M.forme === 'mansarde' && couverture === 'tuile') couverture = 'zinc';
    toits.set(b.id, { id: b.id, zG, zGmin, zTop, forme: M.forme, couverture, hBrisis: M.hB, pente: (Math.atan(M.forme === 'pentes' ? M.tanP : M.tanT) / DEG), rms });
    stats.batiments++;
    stats[M.forme === 'mansarde' ? 'mansardes' : M.forme === 'pentes' ? 'pentes' : 'terrasses']++;

    // --- maillage : quadtree restreint calé sur les pans ---
    // Grandes cellules là où le toit est un seul pan (plan exact), cellules de 0,5 m seulement le long des plis
    // (arêtiers, noues, brisis). Chaque cellule est remplie en éventail depuis son centre avec TOUS les sommets
    // présents sur ses côtés (y compris ceux des voisines plus fines) ⇒ maillage conforme : ni fissure ni épine.
    // Les cellules du bord sont découpées exactement par l'emprise (Sutherland–Hodgman), cours déduites.
    const loin = Math.hypot((x0 + x1) / 2 - P.centre.x, (y0 + y1) / 2 - P.centre.y) > 160;
    const trous = (b.trous ?? []).filter((t) => t.length >= 3);
    const V = (r: XY[]) => r.map((p) => new THREE.Vector2(p.x, p.y));
    const k = couverture;
    const uvDe = (pl: Plan, p: XY) => {
      if (pl.ligne < 0) return [p.x, p.y];
      const l = liP[pl.ligne]!;
      const pente = Math.hypot(pl.a, pl.b);
      return [(p.x - l.A.x) * l.ux + (p.y - l.A.y) * l.uy, (-((p.x - l.A.x) * l.nx + (p.y - l.A.y) * l.ny)) * Math.sqrt(1 + pente * pente)];
    };
    const emettreTri = (A: XY, B: XY, C: XY) => {
      const g2 = { x: (A.x + B.x + C.x) / 3, y: (A.y + B.y + C.y) / 3 };
      const pl = plans[terrasse ? plans.length - 1 : label(g2)]!;
      const col = pl.type === 'brisis' ? [0.86, 0.88, 0.92] : [1, 1, 1];
      tri(k, S(A, H(A)), S(B, H(B)), S(C, H(C)), uvDe(pl, A), uvDe(pl, B), uvDe(pl, C), col);
    };
    const fin = (loin ? 1.0 : 0.5) * (P.mobile ? 1.25 : 1);
    let racine = fin;
    while (racine < (terrasse ? 64 : 4)) racine *= 2;
    // feuilles du quadtree
    type Cel = { x: number; y: number; s: number };
    const feuilles: Cel[] = [];
    const uniforme = (c: Cel) => {
      if (terrasse) return true;
      const l0 = label({ x: c.x, y: c.y });
      for (let i = 0; i <= 4; i++)
        for (let j = 0; j <= 4; j++) if (label({ x: c.x + (c.s * i) / 4, y: c.y + (c.s * j) / 4 }) !== l0) return false;
      return true;
    };
    const touche = (c: Cel) => {
      // la cellule recoupe-t-elle l'emprise ? (sommet dedans, ou un sommet de l'emprise dans la cellule)
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]] as const) if (dansBat(b, { x: c.x + c.s * dx, y: c.y + c.s * dy })) return true;
      for (const r of [b.contour, ...trous]) for (const p of r) if (p.x >= c.x && p.x <= c.x + c.s && p.y >= c.y && p.y <= c.y + c.s) return true;
      for (const r of [b.contour, ...trous])
        for (let i = 0; i < r.length; i++) {
          const A = r[i]!, B = r[(i + 1) % r.length]!;
          if (Math.max(A.x, B.x) < c.x || Math.min(A.x, B.x) > c.x + c.s || Math.max(A.y, B.y) < c.y || Math.min(A.y, B.y) > c.y + c.s) continue;
          return true;
        }
      return false;
    };
    const diviser = (c: Cel) => {
      if (!touche(c)) return;
      if (c.s <= fin * 1.001 || uniforme(c)) { feuilles.push(c); return; }
      const h2 = c.s / 2;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) diviser({ x: c.x + dx * h2, y: c.y + dy * h2, s: h2 });
    };
    const gx = Math.floor(x0 / racine) * racine, gy = Math.floor(y0 / racine) * racine;
    for (let x = gx; x < x1; x += racine) for (let y = gy; y < y1; y += racine) diviser({ x, y, s: racine });
    // sommets de toutes les feuilles, indexés sur la grille la plus fine
    const cle = (x: number, y: number) => Math.round(x / fin) + ',' + Math.round(y / fin);
    const coins = new Set<string>();
    for (const c of feuilles) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) coins.add(cle(c.x + c.s * dx, c.y + c.s * dy));
    const clip = (poly: XY[], c: Cel) => {
      // polygone (quelconque) découpé par la cellule (convexe)
      const bords: [(p: XY) => number, number][] = [];
      let out = poly;
      for (const f of [(p: XY) => c.x - p.x, (p: XY) => p.x - (c.x + c.s), (p: XY) => c.y - p.y, (p: XY) => p.y - (c.y + c.s)]) {
        const inp = out;
        out = [];
        for (let i = 0; i < inp.length; i++) {
          const A = inp[i]!, B = inp[(i + 1) % inp.length]!, fa = f(A), fb = f(B);
          if (fa <= 0) out.push(A);
          if ((fa <= 0) !== (fb <= 0)) { const t = fa / (fa - fb); out.push({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t }); }
        }
        if (!out.length) break;
      }
      void bords;
      return out;
    };
    for (const c of feuilles) {
      // contour de la cellule avec les sommets des voisines plus fines
      const bordC: XY[] = [];
      const n = Math.round(c.s / fin);
      const cotes: [number, number, number, number][] = [[c.x, c.y, 1, 0], [c.x + c.s, c.y, 0, 1], [c.x + c.s, c.y + c.s, -1, 0], [c.x, c.y + c.s, 0, -1]];
      for (const [sx, sy, dx, dy] of cotes)
        for (let i = 0; i < n; i++) {
          const x = sx + dx * fin * i, y = sy + dy * fin * i;
          if (i === 0 || coins.has(cle(x, y))) bordC.push({ x, y });
        }
      const toutDedans = [[0, 0], [1, 0], [0, 1], [1, 1]].every(([dx, dy]) => dansBat(b, { x: c.x + c.s * dx!, y: c.y + c.s * dy! }))
        && ![b.contour, ...trous].some((r) => r.some((p) => p.x > c.x - 1e-6 && p.x < c.x + c.s + 1e-6 && p.y > c.y - 1e-6 && p.y < c.y + c.s + 1e-6))
        && ![b.contour, ...trous].some((r) => r.some((A, i) => { const B = r[(i + 1) % r.length]!; return Math.max(A.x, B.x) > c.x && Math.min(A.x, B.x) < c.x + c.s && Math.max(A.y, B.y) > c.y && Math.min(A.y, B.y) < c.y + c.s; }));
      if (toutDedans) {
        const C = { x: c.x + c.s / 2, y: c.y + c.s / 2 };
        if (bordC.length === 4 && uniforme(c)) { emettreTri(bordC[0]!, bordC[1]!, bordC[2]!); emettreTri(bordC[0]!, bordC[2]!, bordC[3]!); continue; }
        if (bordC.length === 4) {
          // cellule fine traversée par UN pli : points exacts du pli sur les côtés, coupe nette en deux pans plans
          const ring: XY[] = [], ins: number[] = [];
          for (let i = 0; i < 4; i++) {
            const A = bordC[i]!, B = bordC[(i + 1) % 4]!, la = label(A), lb = label(B);
            ring.push(A);
            if (la !== lb) {
              const pa = plans[la]!, pb = plans[lb]!;
              const fa = zPlan(pa, A) - zPlan(pb, A), fb = zPlan(pa, B) - zPlan(pb, B);
              const t = Math.abs(fa - fb) > 1e-9 ? Math.min(1, Math.max(0, fa / (fa - fb))) : 0.5;
              ins.push(ring.length);
              ring.push({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t });
            }
          }
          if (ins.length === 2) {
            const [i0, i1] = ins as [number, number];
            for (const piece of [ring.slice(i0, i1 + 1), [...ring.slice(i1), ...ring.slice(0, i0 + 1)]])
              for (let i = 1; i + 1 < piece.length; i++) emettreTri(piece[0]!, piece[i]!, piece[i + 1]!);
            continue;
          }
        }
        for (let i = 0; i < bordC.length; i++) emettreTri(C, bordC[i]!, bordC[(i + 1) % bordC.length]!);
        continue;
      }
      // cellule de bord : emprise ∩ cellule (contour extérieur), moins les cours
      const ext = clip(b.contour, c);
      if (ext.length < 3) continue;
      // garder les sommets de bord de cellule (voisines fines) qui sont dans l'emprise : on les insère sur les côtés
      const pieces = [ext];
      const tr = trous.map((t) => clip(t, c)).filter((t) => t.length >= 3);
      for (const pc of pieces) {
        let fcs: number[][] = [];
        try { fcs = THREE.ShapeUtils.triangulateShape(V(pc), tr.map(V)); } catch { fcs = []; }
        const all = [...pc, ...tr.flat()];
        for (const f of fcs) emettreTri(all[f[0]!]!, all[f[1]!]!, all[f[2]!]!);
      }
    }

    // --- fond de toit sombre : aucun jour visible, même sur une fissure numérique ---
    {
      let fond: number[][] = [];
      try { fond = THREE.ShapeUtils.triangulateShape(V(b.contour), trous.map(V)); } catch { /* emprise dégénérée */ }
      const ptsF = [...b.contour, ...trous.flat()];
      for (const f of fond) {
        const [a, c, e] = f.map((i) => S(ptsF[i]!, zGmin - 0.08)) as [number[], number[], number[]];
        tri('fond', a, c, e, [0, 0], [0, 0], [0, 0], [1, 1, 1]);
      }
    }

    // --- murs propres sur le contour exact (sauf là où une façade générée existe) ---
    const kMur = !P.murs ? 'mur'
      : typo === 'brique' ? 'murBrique' : typo === 'moderne' || typo === 'tour' || typo === 'bureaux' ? 'murBeton'
      : typo === 'faubourien' || typo === 'contemporain' || typo === 'annexe' ? 'murEnduit' : 'murPierre';
    let hh = 0;
    for (const ch of b.id) hh = (hh * 31 + ch.charCodeAt(0)) >>> 0;
    const tint = 0.94 + ((hh % 100) / 100) * 0.08;
    const colMur = kMur === 'murBrique' ? [1, 0.97, 0.95] : [Math.pow(0.86 * tint, 2.2), Math.pow(0.81 * tint, 2.2), Math.pow(0.72 * tint, 2.2)];
    for (const m of ms) {
      if (m.tache) continue;
      const vers = versScene(m.nx, m.ny);
      const n = Math.max(1, Math.ceil(m.L / 1.5));
      for (let i = 0; i < n; i++) {
        const s0 = (m.L * i) / n, s1 = (m.L * (i + 1)) / n;
        const p0 = { x: m.A.x + m.ux * s0, y: m.A.y + m.uy * s0 }, p1 = { x: m.A.x + m.ux * s1, y: m.A.y + m.uy * s1 };
        const h0 = H(p0), h1 = H(p1), b0 = P.sol(p0) - 1, b1 = P.sol(p1) - 1;
        quad(kMur, [S(p0, b0), S(p1, b1), S(p1, h1), S(p0, h0)], vers, [[s0, b0 - solB], [s1, b1 - solB], [s1, h1 - solB], [s0, h0 - solB]], colMur);
      }
    }

    // --- débord d'égout / acrotère ---
    for (const l of li) {
      const vers = versScene(l.nx, l.ny);
      const o = (p: XY, kk: number) => ({ x: p.x + l.nx * kk, y: p.y + l.ny * kk });
      const zA = H(l.A), zB = H(l.B);
      if (terrasse) {
        const zc = Math.max(zA, zB) + 0.55;
        quad('acrotere', [S(o(l.A, 0.02), zGmin - 0.2), S(o(l.B, 0.02), zGmin - 0.2), S(o(l.B, 0.02), zc), S(o(l.A, 0.02), zc)], vers, [[0, 0], [1, 0], [1, 1], [0, 1]]);
        quad('acrotere', [S(o(l.A, 0.02), zc), S(o(l.B, 0.02), zc), S(o(l.B, -0.28), zc), S(o(l.A, -0.28), zc)], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
        quad('acrotere', [S(o(l.A, -0.28), zc), S(o(l.B, -0.28), zc), S(o(l.B, -0.28), zG + 0.15), S(o(l.A, -0.28), zG + 0.15)], vers.map((v) => -v), [[0, 0], [1, 0], [1, 1], [0, 1]]);
      } else quad(k, [S(o(l.A, 0.3), zA - 0.1), S(o(l.B, 0.3), zB - 0.1), S(l.B, zB), S(l.A, zA)], [0, 1, 0], [[0, -0.3], [l.L, -0.3], [l.L, 0], [0, 0]]);
    }

    // --- lucarnes alignées sur les travées des façades (mansardes) ---
    if (M.forme === 'mansarde' && M.hB >= 2 && !loin && P.spec) {
      for (const tch of ts) {
        const sp = P.spec(tch);
        const dernier = sp.niveaux.length - 1;
        const axes = sp.ouvertures.filter((o) => o.niveau === dernier).map((o) => ({ u: o.u + o.l / 2, l: o.l }));
        const [ax, az] = tch.a, [bx, bz] = tch.b;
        const W = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / W, dzz = (bz - az) / W, nx = -dzz, nz = dx;
        const yG = tch.y + tch.hGout;
        for (const { u, l } of axes) {
          if (u < 0.9 || u > W - 0.9) continue;
          const w = Math.min(1.5, l + 0.35), hF = Math.min(1.75, M.hB - 0.2), prof = 1.9;
          const P0 = (uu: number, d: number, v: number) => [ax + dx * uu + nx * d, yG + v, az + dzz * uu + nz * d];
          const dF = -0.3, u0 = u - w / 2, u1 = u + w / 2, fw = 0.16;
          const face = [nx, 0, nz], un = [[0, 0], [1, 0], [1, 1], [0, 1]];
          quad('lucarne', [P0(u0, dF, 0.1), P0(u0, dF - prof, 0.1), P0(u0, dF - prof, hF), P0(u0, dF, hF)], [-dx, 0, -dzz], un);
          quad('lucarne', [P0(u1, dF, 0.1), P0(u1, dF - prof, 0.1), P0(u1, dF - prof, hF), P0(u1, dF, hF)], [dx, 0, dzz], un);
          quad('lucarne', [P0(u0, dF, 0.1), P0(u0 + fw, dF, 0.1), P0(u0 + fw, dF, hF), P0(u0, dF, hF)], face, un);
          quad('lucarne', [P0(u1 - fw, dF, 0.1), P0(u1, dF, 0.1), P0(u1, dF, hF), P0(u1 - fw, dF, hF)], face, un);
          quad('lucarne', [P0(u0, dF, 0.1), P0(u1, dF, 0.1), P0(u1, dF, 0.35), P0(u0, dF, 0.35)], face, un);
          quad('lucarne', [P0(u0, dF, hF - 0.2), P0(u1, dF, hF - 0.2), P0(u1, dF, hF), P0(u0, dF, hF)], face, un);
          quad('vitre', [P0(u0 + fw, dF - 0.08, 0.35), P0(u1 - fw, dF - 0.08, 0.35), P0(u1 - fw, dF - 0.08, hF - 0.2), P0(u0 + fw, dF - 0.08, hF - 0.2)], face, un);
          const hc = hF + Math.min(0.55, w * 0.35);
          quad('zinc', [P0(u0 - 0.08, dF + 0.12, hF), P0(u, dF + 0.12, hc), P0(u, dF - prof, hc), P0(u0 - 0.08, dF - prof, hF)], [0, 1, 0], [[0, 0], [0, 0.8], [2, 0.8], [2, 0]]);
          quad('zinc', [P0(u1 + 0.08, dF + 0.12, hF), P0(u, dF + 0.12, hc), P0(u, dF - prof, hc), P0(u1 + 0.08, dF - prof, hF)], [0, 1, 0], [[0, 0], [0, 0.8], [2, 0.8], [2, 0]]);
          quad('lucarne', [P0(u0, dF, hF), P0(u1, dF, hF), P0(u, dF, hc), P0(u, dF, hc)], face, [[0, 0], [1, 0], [0.5, 1], [0.5, 1]]);
          stats.lucarnes++;
        }
      }
    }
  };

  for (const b of P.batiments) {
    try {
      construireUn(b);
    } catch (e) {
      stats.echecs++;
      console.warn('toit', b.id, e);
    }
  }

  for (const [k, B] of bufs) {
    if (!B.p.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(B.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(B.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(B.c, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mats[k]);
    m.castShadow = k !== 'vitre' && k !== 'fond';
    m.receiveShadow = true;
    m.name = 'toit_' + k;
    groupe.add(m);
    stats.triangles += B.p.length / 9;
  }
  stats.rmsMedian = Math.round(med(rmsTous) * 100) / 100;
  stats.ms = Math.round(performance.now() - t0);

  const surToit = (p: XY): number | null => {
    for (const b of P.batiments) if (toits.has(b.id) && dansBat(b, p)) return hauteurs.get(b.id)?.(p) ?? null;
    return null;
  };
  return { groupe, toits, stats, surToit };
}
