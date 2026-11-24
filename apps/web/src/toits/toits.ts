/**
 * Toits procéduraux AJUSTÉS au LiDAR HD, assortis aux façades.
 *
 * Pourquoi : maillé tel quel, le LiDAR 50 cm donne des toits « fondus » (marches du raster, rideaux, bruit).
 * Ici chaque bâtiment reçoit un toit propre dont les paramètres sont MESURÉS sur le LiDAR :
 *  - égout (gouttière) = celle des façades du bâtiment (une seule hauteur par bâtiment : le mur et le toit se raccordent) ;
 *  - faîte = 90e centile du LiDAR dans l'emprise (cheminées exclues) ;
 *  - forme : terrasse / mansarde (brisis + terrasson) / pentes, d'après le profil LiDAR mesuré derrière les façades ;
 *  - les pentes partent des murs donnant sur rue ou cour ; les murs mitoyens (bâti contigu au LiDAR) ne portent pas
 *    d'égout : le toit se prolonge, et un pignon ferme la différence de hauteur avec le voisin.
 * Hauteur d'un point = égout + profil(distance aux murs d'égout) plafonnée au faîte (toit « squelette » équivalent).
 * Géométrie : triangulation de l'emprise (cours comprises) subdivisée près des arêtes, facettes à normales plates.
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
  taches: TacheFacade[];
  spec?: (t: TacheFacade) => FacadeSpec;
  /** LiDAR MNS absolu (m NGF) : 50 cm près de l'adresse, 1 m au-delà ; NaN hors données. */
  mns: (p: XY) => number;
  sol: (p: XY) => number;
  typologie: (id: string) => Typologie | undefined;
  /** L93 → scène (x, z) ; altitude NGF → y scène */
  versS: (p: XY) => { x: number; z: number };
  y: (alt: number) => number;
  centre: XY;
  mobile: boolean;
  aniso: number;
}

export interface ToitBat {
  id: string;
  /** égout médian (m NGF) et le plus bas (haut des murs IGN) */
  zG: number;
  zGmin: number;
  zTop: number;
  forme: FormeToit;
  couverture: Couverture;
  hBrisis: number;
}

interface Arete { A: XY; B: XY; L: number; ux: number; uy: number; nx: number; ny: number; egout: boolean; /** égout de cette arête (m NGF) */ zG: number; tache: TacheFacade | null }

const TAN75 = Math.tan((75 * Math.PI) / 180);

function dansAnneau(r: XY[], p: XY) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i]!, b = r[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
const dansBat = (b: Batiment, p: XY) => dansAnneau(b.contour, p) && !(b.trous ?? []).some((t) => dansAnneau(t, p));

function distSeg(p: XY, a: Arete) {
  const t = Math.max(0, Math.min(a.L, (p.x - a.A.x) * a.ux + (p.y - a.A.y) * a.uy));
  return Math.hypot(p.x - (a.A.x + a.ux * t), p.y - (a.A.y + a.uy * t));
}

const med = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]! : NaN);

// ---------------------------------------------------------------------------
// Textures de couverture (procédurales)
// ---------------------------------------------------------------------------
function texZinc(aniso: number) {
  // joints debout tous les 60 cm (u), bandes de 2 m (v) ; zinc prépatiné gris-bleu
  const R = bruit(21), tache = new Float32Array(32 * 8).map(() => R());
  return fabriquer(256, 2.4, (x, y) => {
    const u = (x / 256) * 2.4, v = (y / 256) * 2.4;
    const j = Math.min(u % 0.6, 0.6 - (u % 0.6));
    const joint = 1 - lisse(0.006, 0.022, j);
    const t = tache[Math.floor(u / 0.6) * 8 + Math.floor(v / 0.6) % 8]! * 0.05;
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
// Analyse d'un bâtiment
// ---------------------------------------------------------------------------
function analyser(b: Batiment, P: ParamsToitsProc, tachesBat: TacheFacade[]): { toit: ToitBat; aretes: Arete[] } | null {
  const anneaux = [b.contour, ...(b.trous ?? [])];
  const aretes: Arete[] = [];
  const parIdx = new Map(tachesBat.map((t) => [Number(t.id.split(':')[1]), t]));
  for (const [ir, r] of anneaux.entries())
    for (let i = 0; i < r.length; i++) {
      const A = r[i]!, B = r[(i + 1) % r.length]!, L = Math.hypot(B.x - A.x, B.y - A.y);
      if (L < 0.05) continue;
      const ux = (B.x - A.x) / L, uy = (B.y - A.y) / L;
      let nx = uy, ny = -ux; // normale sortante (vers l'extérieur du bâti)
      const m = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      if (dansBat(b, { x: m.x + nx * 0.3, y: m.y + ny * 0.3 })) (nx = -nx), (ny = -ny);
      aretes.push({ A, B, L, ux, uy, nx, ny, egout: true, zG: NaN, tache: ir === 0 ? parIdx.get(i) ?? null : null });
    }
  // Sol et gouttière
  const solB = P.sol(b.contour[0]!);
  // Mitoyenneté : bâti haut (LiDAR) juste derrière le mur, des deux tiers des points
  for (const a of aretes) {
    let haut = 0, n = 0;
    for (const f of [0.2, 0.5, 0.8]) {
      const p = { x: a.A.x + (a.B.x - a.A.x) * f + a.nx * 1.4, y: a.A.y + (a.B.y - a.A.y) * f + a.ny * 1.4 };
      const z = P.mns(p);
      if (!Number.isFinite(z)) continue;
      n++;
      if (z - P.sol(p) > 3.5) haut++;
    }
    a.egout = !(n && haut / n >= 0.66);
  }
  if (!aretes.some((a) => a.egout)) aretes.forEach((a) => (a.egout = true));
  const egouts = aretes.filter((a) => a.egout);

  // Égout PAR ARÊTE : celui de la façade mesurée sur ce mur, sinon LiDAR juste derrière le mur
  const zBd = b.altitudeSol.valeur + b.hauteur.valeur;
  for (const a of egouts) {
    if (a.tache) { a.zG = a.tache.y + a.tache.hGout - P.y(0); continue; }
    const v: number[] = [];
    for (let s = Math.min(0.5, a.L / 2); s < a.L; s += 1.2) {
      const z = P.mns({ x: a.A.x + a.ux * s - a.nx * 0.7, y: a.A.y + a.uy * s - a.ny * 0.7 });
      if (Number.isFinite(z)) v.push(z);
    }
    if (v.length) a.zG = v.sort((x, y) => x - y)[Math.floor(v.length * 0.3)]!;
  }
  const connus = egouts.filter((a) => Number.isFinite(a.zG) && a.zG > solB + 2);
  let zG = connus.length ? med(connus.map((a) => a.zG)) : zBd;
  if (!Number.isFinite(zG) || zG < solB + 2) zG = zBd;
  if (!Number.isFinite(zG)) return null;
  for (const a of egouts) if (!(Number.isFinite(a.zG) && a.zG > solB + 2)) a.zG = zG;
  const zGmin = Math.min(...egouts.map((a) => a.zG));

  // Faîte : 90e centile du LiDAR dans l'emprise ; profil derrière les murs d'égout
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of b.contour) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
  const pas = Math.max(0.7, Math.sqrt(((x1 - x0) * (y1 - y0)) / 500));
  const zs: number[] = [];
  let dMax = 0;
  for (let x = x0 + pas / 2; x < x1; x += pas)
    for (let y = y0 + pas / 2; y < y1; y += pas) {
      const p = { x, y };
      if (!dansBat(b, p)) continue;
      let d = Infinity;
      for (const a of egouts) d = Math.min(d, distSeg(p, a));
      dMax = Math.max(dMax, d);
      const z = P.mns(p);
      if (Number.isFinite(z)) zs.push(z);
    }
  zs.sort((a, c) => a - c);
  const typo = P.typologie(b.id);
  const mansardeTypo = typo === 'haussmannien' || typo === 'post-haussmannien' || typo === 'equipement';
  let zTop = zs.length >= 5 ? zs[Math.floor(zs.length * 0.9)]! : zG + (mansardeTypo ? 4 : 0.3);
  zTop = Math.min(Math.max(zTop, zG), zG + 14);
  const dz = zTop - zG;
  // profil mesuré : hauteur médiane au-dessus de l'égout à 1,5 m derrière les murs d'égout
  const p15: number[] = [];
  for (const a of egouts) for (let s = 0.6; s < a.L - 0.6; s += 1.2) {
    const z = P.mns({ x: a.A.x + a.ux * s - a.nx * 1.5, y: a.A.y + a.uy * s - a.ny * 1.5 });
    if (Number.isFinite(z)) p15.push(z - zG);
  }
  const h15 = med(p15);
  let forme: FormeToit;
  let hBrisis = 0;
  if (dz < 0.9 || (typo && /moderne|tour|bureaux|contemporain/.test(typo) && dz < 2.5)) forme = 'terrasse';
  else if ((Number.isFinite(h15) && h15 >= 1.4 && dz >= 1.8) || (mansardeTypo && dz >= 1.8)) {
    forme = 'mansarde';
    hBrisis = Math.min(dz, Math.max(1.6, Math.min(3.6, Number.isFinite(h15) ? h15 + 0.6 : 2.8)));
  } else forme = 'pentes';
  // Couverture : BD TOPO (1 tuiles, 2 ardoises, 3 zinc) sinon typologie
  const t = b.toiture ?? '';
  let couverture: Couverture =
    forme === 'terrasse' ? 'terrasse' : t.includes('3') ? 'zinc' : t.includes('2') ? 'ardoise' : t.includes('1') ? 'tuile'
      : typo === 'brique' || (typo === 'faubourien' && forme === 'pentes') ? 'tuile' : typo === 'equipement' ? 'ardoise' : 'zinc';
  if (forme === 'mansarde' && couverture === 'tuile') couverture = 'zinc';
  void dMax;
  return { toit: { id: b.id, zG, zGmin, zTop, forme, couverture, hBrisis }, aretes };
}

/** Profil de hauteur au-dessus de l'égout en fonction de la distance aux murs d'égout. */
function profil(t: ToitBat, d: number, pente: number) {
  const dz = t.zTop - t.zG;
  if (t.forme === 'terrasse') return 0.2;
  if (t.forme === 'mansarde') {
    const run = t.hBrisis / TAN75;
    if (d <= run) return d * TAN75;
    return Math.min(dz, t.hBrisis + (d - run) * pente);
  }
  return Math.min(dz, d * pente);
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------
export function construireToits(P: ParamsToitsProc) {
  const groupe = new THREE.Group();
  groupe.name = 'toits';
  const mats: Record<Couverture | 'pignon' | 'acrotere' | 'lucarne' | 'vitre', THREE.MeshStandardMaterial> = {
    zinc: new THREE.MeshStandardMaterial({ roughness: 0.58, metalness: 0.12, vertexColors: true }),
    ardoise: new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1, vertexColors: true }),
    tuile: new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0, vertexColors: true }),
    terrasse: new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, vertexColors: true }),
    pignon: new THREE.MeshStandardMaterial({ color: 0xcfc6b6, roughness: 0.95 }),
    acrotere: new THREE.MeshStandardMaterial({ color: 0xbdb7ab, roughness: 0.9 }),
    lucarne: new THREE.MeshStandardMaterial({ color: 0xe4dccb, roughness: 0.85 }),
    vitre: new THREE.MeshStandardMaterial({ color: 0x3e4852, roughness: 0.08, metalness: 0.55 }),
  };
  const tz = texZinc(P.aniso), ta = texArdoise(P.aniso), tt = texTuile(P.aniso), tr = texTerrasse(P.aniso);
  for (const [m, t] of [[mats.zinc, tz], [mats.ardoise, ta], [mats.tuile, tt], [mats.terrasse, tr]] as const) (m.map = t.map), (m.normalMap = t.normal);
  for (const [k, m] of Object.entries(mats)) (m.name = 'toit_' + k), (m.customProgramCacheKey = () => 'toit_' + k);

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
  const stats = { batiments: 0, triangles: 0, mansardes: 0, pentes: 0, terrasses: 0, lucarnes: 0 };

  const tri = (k: string, a: number[], b: number[], c: number[], uva: number[], uvb: number[], uvc: number[], col: number[]) => {
    // normale plate, orientée vers le haut / l'extérieur selon l'ordre donné
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (!(l > 1e-9)) return;
    const B = buf(k);
    B.p.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) B.n.push(n[0]! / l, n[1]! / l, n[2]! / l);
    B.uv.push(...uva, ...uvb, ...uvc);
    for (let i = 0; i < 3; i++) B.c.push(...col);
  };
  /** quad vertical/oblique orienté selon `vers` (vecteur scène vers lequel la face regarde) */
  const quad = (k: string, q: number[][], vers: number[], uv: number[][], col = [1, 1, 1]) => {
    const [a, b, c, d] = q as [number[], number[], number[], number[]];
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    if (n[0]! * vers[0]! + n[1]! * vers[1]! + n[2]! * vers[2]! >= 0) (tri(k, a, b, c, uv[0]!, uv[1]!, uv[2]!, col), tri(k, a, c, d, uv[0]!, uv[2]!, uv[3]!, col));
    else (tri(k, a, c, b, uv[0]!, uv[2]!, uv[1]!, col), tri(k, a, d, c, uv[0]!, uv[3]!, uv[2]!, col));
  };

  for (const b of P.batiments) {
    const ts = parBat.get(b.id) ?? [];
    const an = analyser(b, P, ts);
    if (!an) continue;
    const { toit: T, aretes } = an;
    toits.set(b.id, T);
    stats.batiments++;
    stats[T.forme === 'mansarde' ? 'mansardes' : T.forme === 'pentes' ? 'pentes' : 'terrasses']++;
    const egouts = aretes.filter((a) => a.egout);
    const dist = (p: XY) => {
      let d = Infinity;
      for (const a of egouts) d = Math.min(d, distSeg(p, a));
      return d;
    };
    const proche = (p: XY) => {
      let d = Infinity, best = egouts[0]!;
      for (const a of egouts) {
        const x = distSeg(p, a);
        if (x < d) (d = x), (best = a);
      }
      return best;
    };
    // pente fixée pour atteindre le faîte mesuré au point le plus éloigné des égouts (toit « squelette »)
    let dMax = 0;
    const c0 = b.contour;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of c0) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
    const pas = Math.max(0.6, Math.sqrt(((x1 - x0) * (y1 - y0)) / 400));
    for (let x = x0 + pas / 2; x < x1; x += pas) for (let y = y0 + pas / 2; y < y1; y += pas) if (dansBat(b, { x, y })) dMax = Math.max(dMax, dist({ x, y }));
    const dz = T.zTop - T.zG;
    const run = T.forme === 'mansarde' ? T.hBrisis / TAN75 : 0;
    const pente =
      T.forme === 'mansarde' ? Math.min(Math.tan(0.5), Math.max(Math.tan(0.09), (dz - T.hBrisis) / Math.max(0.5, dMax - run)))
        : Math.min(Math.tan(1.05), Math.max(Math.tan(0.26), dz / Math.max(0.5, dMax)));
    // Égout lissé entre arêtes (pondération par proximité : continu, pas de marche) et plafond LiDAR local
    const egoutEn = (p: XY) => {
      let dmin = Infinity;
      const ds = egouts.map((a) => { const d = distSeg(p, a); dmin = Math.min(dmin, d); return d; });
      let sw = 0, sz = 0;
      ds.forEach((d, i) => { if (d > dmin + 6) return; const w = 1 / Math.pow(d - dmin + 0.3, 3); sw += w; sz += w * egouts[i]!.zG; });
      return { z: sz / sw, d: dmin };
    };
    const plafond = (p: XY) => {
      const v: number[] = [];
      for (const [ox, oy] of [[0, 0], [1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2], [2.4, 0], [-2.4, 0], [0, 2.4], [0, -2.4], [1.7, 1.7], [-1.7, 1.7], [1.7, -1.7], [-1.7, -1.7]] as const) {
        const z = P.mns({ x: p.x + ox, y: p.y + oy });
        if (Number.isFinite(z)) v.push(z);
      }
      return v.length >= 6 ? v.sort((x, y) => x - y)[Math.floor(v.length * 0.7)]! + 0.3 : Infinity;
    };
    const H = (p: XY) => {
      const { z, d } = egoutEn(p);
      if (T.forme === 'terrasse') return z + 0.2;
      return Math.max(z, Math.min(z + profil(T, d, pente), plafond(p), T.zTop));
    };
    hauteurs.set(b.id, H);

    // --- triangulation de l'emprise (cours comprises) + subdivision adaptative ---
    const loin = Math.hypot((x0 + x1) / 2 - P.centre.x, (y0 + y1) / 2 - P.centre.y) > 160;
    const fin = (T.forme === 'terrasse' ? 99 : T.forme === 'mansarde' ? 0.9 : 1.5) * (loin ? 2.2 : 1) * (P.mobile ? 1.3 : 1);
    const gros = T.forme === 'terrasse' ? 99 : (loin ? 5 : 3);
    const pts: XY[] = [...c0];
    const trous = (b.trous ?? []).filter((t) => t.length >= 3);
    for (const t of trous) pts.push(...t);
    let faces: number[][];
    try {
      faces = THREE.ShapeUtils.triangulateShape(c0.map((p) => new THREE.Vector2(p.x, p.y)), trous.map((t) => t.map((p) => new THREE.Vector2(p.x, p.y))));
    } catch {
      continue;
    }
    const cache = new Map<string, number>();
    const milieu = (i: number, j: number) => {
      const k = i < j ? `${i}_${j}` : `${j}_${i}`;
      let m = cache.get(k);
      if (m == null) {
        const a = pts[i]!, c = pts[j]!;
        pts.push({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 });
        cache.set(k, (m = pts.length - 1));
      }
      return m;
    };
    const coupe = (i: number, j: number) => {
      const a = pts[i]!, c = pts[j]!, L = Math.hypot(c.x - a.x, c.y - a.y);
      if (L <= fin) return false;
      const d = dist({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 });
      return L > (d < run + 1.2 ? fin : gros);
    };
    const fil = faces.map((f) => [f[0]!, f[1]!, f[2]!]);
    const finales: number[][] = [];
    let garde = 0;
    while (fil.length && garde++ < 60000) {
      const [a, c, e] = fil.pop()! as [number, number, number];
      const sAC = coupe(a, c), sCE = coupe(c, e), sEA = coupe(e, a);
      if (!sAC && !sCE && !sEA) {
        finales.push([a, c, e]);
        continue;
      }
      // découpe en 4 si au moins une arête est trop longue (milieux partagés : pas de fissure)
      const m1 = milieu(a, c), m2 = milieu(c, e), m3 = milieu(e, a);
      fil.push([a, m1, m3], [m1, c, m2], [m3, m2, e], [m1, m2, m3]);
    }
    // --- facettes ---
    const k = T.couverture;
    const zv = pts.map((p) => H(p));
    for (const [a, c, e] of finales as [number, number, number][]) {
      const A = pts[a]!, C = pts[c]!, E = pts[e]!;
      const g = { x: (A.x + C.x + E.x) / 3, y: (A.y + C.y + E.y) / 3 };
      const ar = proche(g);
      const uvp = (p: XY) => [(p.x - ar.A.x) * ar.ux + (p.y - ar.A.y) * ar.uy, distSeg(p, ar)];
      const s = (p: XY, z: number) => { const q = P.versS(p); return [q.x, P.y(z), q.z]; };
      // brisis un peu plus sombre que le terrasson (zinc vu presque de face)
      const dG = dist(g);
      const col = T.forme === 'mansarde' && dG < run ? [0.88, 0.9, 0.93] : [1, 1, 1];
      // orientation : normale vers le haut
      const pa = s(A, zv[a]!), pc = s(C, zv[c]!), pe = s(E, zv[e]!);
      const e1 = [pc[0]! - pa[0]!, pc[2]! - pa[2]!], e2 = [pe[0]! - pa[0]!, pe[2]! - pa[2]!];
      const ny = e1[1]! * e2[0]! - e1[0]! * e2[1]!; // composante y de (pc-pa)×(pe-pa)
      if (ny >= 0) tri(k, pa, pc, pe, uvp(A), uvp(C), uvp(E), col);
      else tri(k, pa, pe, pc, uvp(A), uvp(E), uvp(C), col);
    }
    // --- débord d'égout (couvre le raccord avec la corniche) + acrotère des terrasses ---
    for (const a of egouts) {
      const S = (p: XY, z: number) => { const q = P.versS(p); return [q.x, P.y(z), q.z]; };
      const o = (p: XY, k2: number) => ({ x: p.x + a.nx * k2, y: p.y + a.ny * k2 });
      const vers = [P.versS(o(a.A, 1)).x - P.versS(a.A).x, 0, P.versS(o(a.A, 1)).z - P.versS(a.A).z];
      const zA0 = H(a.A), zB0 = H(a.B);
      if (T.forme === 'terrasse') {
        const zA = Math.max(zA0, zB0) + 0.55;
        quad('acrotere', [S(o(a.A, 0.02), T.zGmin - 0.2), S(o(a.B, 0.02), T.zGmin - 0.2), S(o(a.B, 0.02), zA), S(o(a.A, 0.02), zA)], vers, [[0, 0], [1, 0], [1, 1], [0, 1]]);
        quad('acrotere', [S(o(a.A, 0.02), zA), S(o(a.B, 0.02), zA), S(o(a.B, -0.28), zA), S(o(a.A, -0.28), zA)], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
        quad('acrotere', [S(o(a.A, -0.28), zA), S(o(a.B, -0.28), zA), S(o(a.B, -0.28), Math.min(zA0, zB0)), S(o(a.A, -0.28), Math.min(zA0, zB0))], vers.map((v) => -v), [[0, 0], [1, 0], [1, 1], [0, 1]]);
      } else {
        const uvq = [[0, -0.35], [a.L, -0.35], [a.L, 0], [0, 0]];
        quad(k, [S(o(a.A, 0.35), zA0 - 0.1), S(o(a.B, 0.35), zB0 - 0.1), S(a.B, zA0 === zB0 ? zB0 : zB0), S(a.A, zA0)], [0, 1, 0], uvq);
        // mur sans façade générée : rive pleine du haut des murs IGN jusqu'à l'égout (aucun jour sous le toit)
        if (!a.tache && Math.max(zA0, zB0) - T.zGmin > 0.1)
          quad('pignon', [S(a.A, T.zGmin - 0.2), S(a.B, T.zGmin - 0.2), S(a.B, zB0), S(a.A, zA0)], vers, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      }
    }
    // --- pignons sur les murs mitoyens : du toit jusque sous l'égout (cache tout écart avec le voisin) ---
    for (const a of aretes) {
      if (a.egout) continue;
      const S = (p: XY, z: number) => { const q = P.versS(p); return [q.x, P.y(z), q.z]; };
      const n = Math.max(1, Math.ceil(a.L / 1.0));
      const vers = (() => { const q0 = P.versS(a.A), q1 = P.versS({ x: a.A.x + a.nx, y: a.A.y + a.ny }); return [q1.x - q0.x, 0, q1.z - q0.z]; })();
      for (let i = 0; i < n; i++) {
        const p0 = { x: a.A.x + a.ux * (a.L * i) / n, y: a.A.y + a.uy * (a.L * i) / n }, p1 = { x: a.A.x + a.ux * (a.L * (i + 1)) / n, y: a.A.y + a.uy * (a.L * (i + 1)) / n };
        const h0 = H(p0), h1 = H(p1);
        if (h0 - T.zGmin < 0.3 && h1 - T.zGmin < 0.3) continue;
        quad('pignon', [S(p0, T.zGmin - 1.5), S(p1, T.zGmin - 1.5), S(p1, h1), S(p0, h0)], vers, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      }
    }
    // --- lucarnes : une par travée des façades haussmanniennes, dans le brisis ---
    if (T.forme === 'mansarde' && T.hBrisis >= 2 && !loin && P.spec) {
      for (const tch of ts) {
        const sp = P.spec(tch);
        const dernier = sp.niveaux.length - 1;
        const axes = sp.ouvertures.filter((o) => o.niveau === dernier).map((o) => ({ u: o.u + o.l / 2, l: o.l }));
        const [ax, az] = tch.a, [bx, bz] = tch.b;
        const W = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / W, dzz = (bz - az) / W, nx = -dzz, nz = dx;
        const yG = tch.y + tch.hGout;
        for (const { u, l } of axes) {
          const w = Math.min(1.5, l + 0.35), hF = Math.min(1.75, T.hBrisis - 0.2), prof = 1.9;
          const P0 = (uu: number, d: number, v: number) => [ax + dx * uu + nx * d, yG + v, az + dzz * uu + nz * d];
          const dF = -0.35; // front en retrait derrière la corniche, dans le brisis
          const u0 = u - w / 2, u1 = u + w / 2;
          const face = [nx, 0, nz], gauche = [-dx, 0, -dzz], droite = [dx, 0, dzz];
          // jouées
          quad('lucarne', [P0(u0, dF, 0.1), P0(u0, dF - prof, 0.1), P0(u0, dF - prof, hF), P0(u0, dF, hF)], gauche, [[0, 0], [1, 0], [1, 1], [0, 1]]);
          quad('lucarne', [P0(u1, dF, 0.1), P0(u1, dF - prof, 0.1), P0(u1, dF - prof, hF), P0(u1, dF, hF)], droite, [[0, 0], [1, 0], [1, 1], [0, 1]]);
          // fronton (encadrement) et fenêtre
          const fw = 0.16;
          quad('lucarne', [P0(u0, dF, 0.1), P0(u0 + fw, dF, 0.1), P0(u0 + fw, dF, hF), P0(u0, dF, hF)], face, [[0, 0], [1, 0], [1, 1], [0, 1]]);
          quad('lucarne', [P0(u1 - fw, dF, 0.1), P0(u1, dF, 0.1), P0(u1, dF, hF), P0(u1 - fw, dF, hF)], face, [[0, 0], [1, 0], [1, 1], [0, 1]]);
          quad('lucarne', [P0(u0, dF, 0.1), P0(u1, dF, 0.1), P0(u1, dF, 0.35), P0(u0, dF, 0.35)], face, [[0, 0], [1, 0], [1, 1], [0, 1]]);
          quad('lucarne', [P0(u0, dF, hF - 0.2), P0(u1, dF, hF - 0.2), P0(u1, dF, hF), P0(u0, dF, hF)], face, [[0, 0], [1, 0], [1, 1], [0, 1]]);
          quad('vitre', [P0(u0 + fw, dF - 0.08, 0.35), P0(u1 - fw, dF - 0.08, 0.35), P0(u1 - fw, dF - 0.08, hF - 0.2), P0(u0 + fw, dF - 0.08, hF - 0.2)], face, [[0, 0], [1, 0], [1, 1], [0, 1]]);
          // petit toit à deux pans (zinc)
          const hc = hF + Math.min(0.55, w * 0.35);
          quad('zinc', [P0(u0 - 0.08, dF + 0.12, hF), P0(u, dF + 0.12, hc), P0(u, dF - prof, hc), P0(u0 - 0.08, dF - prof, hF)], [0, 1, 0], [[0, 0], [0, 0.8], [2, 0.8], [2, 0]]);
          quad('zinc', [P0(u1 + 0.08, dF + 0.12, hF), P0(u, dF + 0.12, hc), P0(u, dF - prof, hc), P0(u1 + 0.08, dF - prof, hF)], [0, 1, 0], [[0, 0], [0, 0.8], [2, 0.8], [2, 0]]);
          // tympan triangulaire
          quad('lucarne', [P0(u0, dF, hF), P0(u1, dF, hF), P0(u, dF, hc), P0(u, dF, hc)], face, [[0, 0], [1, 0], [0.5, 1], [0.5, 1]]);
          stats.lucarnes++;
        }
      }
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
    const m = new THREE.Mesh(g, mats[k as keyof typeof mats]);
    m.castShadow = k !== 'vitre';
    m.receiveShadow = true;
    m.name = 'toit_' + k;
    groupe.add(m);
    stats.triangles += B.p.length / 9;
  }

  /** Altitude du toit en un point (pour poser les cheminées), null hors bâtiment. */
  const surToit = (p: XY): number | null => {
    for (const b of P.batiments) {
      const T = toits.get(b.id);
      if (!T) continue;
      if (!dansBat(b, p)) continue;
      return hauteurs.get(b.id)?.(p) ?? null;
    }
    return null;
  };
  return { groupe, toits, stats, surToit };
}
