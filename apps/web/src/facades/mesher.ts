/**
 * Moteur de façades — partie 3D : FacadeSpec (packages/facades) → géométrie Three.js.
 *
 *  - Mur PLEIN percé de vraies ouvertures (bandes horizontales moins les trous), tableaux de 15–35 cm :
 *    l'ombre portée dans les embrasures est réelle (rendu ET calcul solaire).
 *  - Une seule surface par façade : aucun plan coplanaire (pas de z-fighting), toutes les faces sont
 *    orientées vers l'extérieur (FrontSide), aucune transparence par mélange : vitres OPAQUES réfléchissantes,
 *    ferronnerie en découpe alphaTest (pas de tri, ombres correctes).
 *  - Géométrie fusionnée par matière et par paquets de façades : peu d'appels de dessin, fabrication
 *    étalée sur plusieurs images (budget en ms).
 */
import * as THREE from 'three';
import { classer, composer, type Classement, type EntreeFacade, type FacadeSpec, type Ouverture } from '@lumen/facades';
import { equiperFenetres } from '../nuit';
import { texBeton, texBrique, texEnduit, texFer, texPierre, texRefends, type TexMur } from './textures';

export interface TacheFacade {
  id: string;
  /** Début et fin de la façade en repère local (x, z), orientés pour que la normale (-dz, dx) sorte vers la rue. */
  a: [number, number];
  b: [number, number];
  /** Altitude locale du pied de façade (point le plus haut du trottoir). */
  y: number;
  /** Rattrapage de pente sous le pied (m) jusqu'au point bas du trottoir. */
  socle?: number;
  /** Hauteur de gouttière/corniche mesurée au LiDAR, depuis le pied (m). */
  hGout: number;
  /** 0 : tous les détails ; 1 : menuiseries à plat ; 2 : (loin) mur percé + vitres + balcons, sans menuiseries ni ferronnerie. */
  lod: 0 | 1 | 2;
  /** Données du bâtiment (BD TOPO + LiDAR) pour la classification. */
  bat?: Omit<EntreeFacade, 'id' | 'largeur' | 'hGout' | 'socle'>;
}

type Cle = 'pierre' | 'refends' | 'brique' | 'enduit' | 'beton' | 'decor' | 'menuiserie' | 'vitre' | 'rideau' | 'rideau2' | 'fer' | 'metal' | 'bois' | 'enseigne';

class Seau {
  p: number[] = [];
  n: number[] = [];
  uv: number[] = [];
  c: number[] = [];
  pid: number[] = [];
  idx: number[] = [];
}

/** Repère d'une façade : origine au pied de a, axes u (le long), v (haut), d (vers la rue). */
class Repere {
  constructor(readonly ax: number, readonly az: number, readonly y: number, readonly dx: number, readonly dz: number) {}
  pos(u: number, v: number, d: number): [number, number, number] {
    return [this.ax + this.dx * u - this.dz * d, this.y + v, this.az + this.dz * u + this.dx * d];
  }
  dir(nu: number, nv: number, nd: number): [number, number, number] {
    return [this.dx * nu - this.dz * nd, nv, this.dz * nu + this.dx * nd];
  }
}

const EPS = 1e-4;

export class MoteurFacades {
  readonly groupe = new THREE.Group();
  private mats: Record<Cle, THREE.MeshStandardMaterial>;
  private file: TacheFacade[] = [];
  /** Une typologie par BÂTIMENT (jamais de façades de styles différents sur un même immeuble). */
  private parBat = new Map<string, Classement>();
  private lot = new Map<Cle, Seau>();
  private nLot = 0;
  private total = 0;
  fait = 0;
  /** Stats de la dernière fabrication (panneau ⚙). */
  stats = { facades: 0, triangles: 0, drawCalls: 0, ms: 0, typologies: {} as Record<string, number> };
  specs: FacadeSpec[] = [];
  private plat = false;

  constructor(aniso = 8) {
    const mur = (t: TexMur, rough = 0.88) => {
      const m = new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normal, roughness: rough, metalness: 0, vertexColors: true });
      m.normalScale.set(0.9, 0.9);
      patiner(m);
      return m;
    };
    const pierre = texPierre(aniso), refends = texRefends(aniso);
    this.mats = {
      pierre: mur(pierre),
      refends: mur(refends),
      brique: mur(texBrique(aniso), 0.92),
      enduit: mur(texEnduit(aniso), 0.95),
      beton: mur(texBeton(aniso), 0.9),
      decor: mur(pierre, 0.85),
      menuiserie: new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0, vertexColors: true }),
      vitre: new THREE.MeshStandardMaterial({ color: 0x46525e, roughness: 0.07, metalness: 0.55, envMapIntensity: 1.4 }),
      rideau: new THREE.MeshStandardMaterial({ color: 0xa9a293, roughness: 0.55, metalness: 0.15 }),
      rideau2: new THREE.MeshStandardMaterial({ color: 0x77705f, roughness: 0.45, metalness: 0.25 }),
      fer: new THREE.MeshStandardMaterial({ map: texFer(aniso), color: 0x2a2c2e, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.6 }),
      metal: new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.5, vertexColors: true }),
      bois: new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0, vertexColors: true }),
      enseigne: new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.1, vertexColors: true }),
    };
    for (const [k, m] of Object.entries(this.mats)) {
      m.name = 'facade_' + k;
      // clés de programme distinctes (les patchs nuit/lampadaires modifient les shaders)
      m.customProgramCacheKey = () => 'facade_' + k;
    }
    equiperFenetres({ vc: this.mats.vitre, rideau: this.mats.rideau, rideauTire: this.mats.rideau2 });
    this.groupe.name = 'facades';
  }

  /** Typologie retenue pour un bâtiment (toits assortis aux façades). */
  typologie(idBat: string) {
    return this.parBat.get(idBat)?.typologie;
  }

  /** FacadeSpec d'une tâche (sans géométrie) — pour aligner les lucarnes sur les travées. */
  spec(t: TacheFacade): FacadeSpec {
    const W = Math.hypot(t.b[0] - t.a[0], t.b[1] - t.a[1]);
    return composer({ id: t.id, largeur: W, hGout: t.hGout, socle: t.socle ?? 0, ...(t.bat ?? {}) }, this.parBat.get(t.id.split(':')[0]!));
  }

  /** Classe les bâtiments sans lancer la fabrication (pour les toits, avant les façades). */
  preparer(taches: TacheFacade[]) {
    this.lancer(taches);
  }

  get progression() {
    return this.total ? this.fait / this.total : 1;
  }

  /** Remplace toutes les façades (nouvelle adresse / rechargement). */
  lancer(taches: TacheFacade[]) {
    for (const o of this.groupe.children) (o as THREE.Mesh).geometry.dispose();
    this.groupe.clear();
    this.file = [...taches];
    this.parBat.clear();
    const groupes = new Map<string, TacheFacade[]>();
    for (const t of taches) {
      const k = t.id.split(':')[0]!;
      groupes.set(k, [...(groupes.get(k) ?? []), t]);
    }
    for (const [k, ts] of groupes) {
      const ref = ts.reduce((a, b) => (b.hGout > a.hGout ? b : a));
      const largeur = ts.reduce((a, t) => a + Math.hypot(t.b[0] - t.a[0], t.b[1] - t.a[1]), 0);
      this.parBat.set(k, classer({ id: k, largeur, hGout: ref.hGout, ...(ref.bat ?? {}), hHaut: ref.bat?.hHaut }));
    }
    this.total = taches.length;
    this.fait = 0;
    this.lot.clear();
    this.nLot = 0;
    this.specs = [];
    this.stats = { facades: 0, triangles: 0, drawCalls: 0, ms: 0, typologies: {} };
  }

  /** Fabrique des façades pendant `budget` ms (appelé à chaque image). */
  etape(budget: number) {
    if (!this.file.length) return;
    const t0 = performance.now();
    while (this.file.length && performance.now() - t0 < budget) {
      const t = this.file.shift()!;
      try {
        this.fabriquer(t);
      } catch (e) {
        console.warn('façade', t.id, e);
      }
      this.fait++;
      if (++this.nLot >= 30 || !this.file.length) this.vider();
    }
    this.stats.ms += performance.now() - t0;
  }

  private seau(k: Cle) {
    let s = this.lot.get(k);
    if (!s) this.lot.set(k, (s = new Seau()));
    return s;
  }

  private vider() {
    for (const [k, s] of this.lot) {
      if (!s.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(s.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(s.n, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(s.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(s.c, 3));
      g.setAttribute('aPiece', new THREE.Float32BufferAttribute(s.pid, 1));
      g.setIndex(s.idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.mats[k]);
      // ombres : seulement les volumes porteurs (murs, balcons/corniches) — les menuiseries et ferronneries
      // (< 1 texel de la carte d'ombre) coûteraient le double de triangles pour rien
      m.castShadow = k === 'pierre' || k === 'refends' || k === 'brique' || k === 'enduit' || k === 'beton' || k === 'decor';
      m.receiveShadow = true;
      m.name = 'facades_' + k;
      this.groupe.add(m);
      this.stats.triangles += s.idx.length / 3;
      this.stats.drawCalls++;
    }
    this.lot.clear();
    this.nLot = 0;
  }

  // -------------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------------
  /** Quadrilatère plan (coins en repère façade, sens quelconque) orienté selon la normale n. */
  private quad(k: Cle, R: Repere, P: [number, number, number][], n: [number, number, number], uv: [number, number][], col: [number, number, number], pid = -1) {
    const s = this.seau(k);
    // ordre CCW vu depuis n (repère u, v, d direct)
    const [a, b, c] = P as [[number, number, number], [number, number, number], [number, number, number]];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const sens = cr[0]! * n[0] + cr[1]! * n[1] + cr[2]! * n[2] >= 0;
    const base = s.p.length / 3;
    const N = R.dir(n[0], n[1], n[2]);
    for (let i = 0; i < 4; i++) {
      const q = P[i]!;
      s.p.push(...R.pos(q[0], q[1], q[2]));
      s.n.push(...N);
      s.uv.push(...uv[i]!);
      s.c.push(lin(col[0]), lin(col[1]), lin(col[2]));
      s.pid.push(pid);
    }
    if (sens) s.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else s.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  /** Rectangle de face (normale +d) au plan d. UV en mètres (u, v) + décalage uo. */
  private face(k: Cle, R: Repere, u0: number, u1: number, v0: number, v1: number, d: number, col: [number, number, number], uo = 0, pid = -1, uvUnit = false) {
    if (u1 - u0 < EPS || v1 - v0 < EPS) return;
    const uv: [number, number][] = uvUnit
      ? [[0, 0], [1, 0], [1, 1], [0, 1]]
      : [[u0 + uo, v0], [u1 + uo, v0], [u1 + uo, v1], [u0 + uo, v1]];
    this.quad(k, R, [[u0, v0, d], [u1, v0, d], [u1, v1, d], [u0, v1, d]], [0, 0, 1], uv, col, pid);
  }

  /** Pavé saillant (faces avant, dessus, dessous, côtés ; pas d'arrière, collé au mur). */
  private pave(k: Cle, R: Repere, u0: number, u1: number, v0: number, v1: number, d0: number, d1: number, col: [number, number, number], uo = 0) {
    if (u1 - u0 < EPS || v1 - v0 < EPS || d1 - d0 < EPS) return;
    this.face(k, R, u0, u1, v0, v1, d1, col, uo);
    if (this.plat) return; // LOD 1–2 : face avant seule (le relief de quelques cm est invisible de loin)
    const q = (P: [number, number, number][], n: [number, number, number], uv: [number, number][]) => this.quad(k, R, P, n, uv, col);
    q([[u0, v1, d0], [u1, v1, d0], [u1, v1, d1], [u0, v1, d1]], [0, 1, 0], [[u0 + uo, d0], [u1 + uo, d0], [u1 + uo, d1], [u0 + uo, d1]]);
    q([[u0, v0, d0], [u1, v0, d0], [u1, v0, d1], [u0, v0, d1]], [0, -1, 0], [[u0 + uo, d0], [u1 + uo, d0], [u1 + uo, d1], [u0 + uo, d1]]);
    q([[u0, v0, d0], [u0, v1, d0], [u0, v1, d1], [u0, v0, d1]], [-1, 0, 0], [[d0, v0], [d0, v1], [d1, v1], [d1, v0]]);
    q([[u1, v0, d0], [u1, v1, d0], [u1, v1, d1], [u1, v0, d1]], [1, 0, 0], [[d0, v0], [d0, v1], [d1, v1], [d1, v0]]);
  }

  // -------------------------------------------------------------------------
  // Façade
  // -------------------------------------------------------------------------
  private fabriquer(t: TacheFacade) {
    const [ax, az] = t.a, [bx, bz] = t.b;
    const W = Math.hypot(bx - ax, bz - az);
    if (!(W > 1) || !(t.hGout > 2.5)) return;
    const R = new Repere(ax, az, t.y, (bx - ax) / W, (bz - az) / W);
    const e: EntreeFacade = { id: t.id, largeur: W, hGout: t.hGout, socle: t.socle ?? 0, ...(t.bat ?? {}) };
    const s = composer(e, this.parBat.get(t.id.split(':')[0]!));
    this.specs.push(s);
    this.stats.facades++;
    this.stats.typologies[s.classement.typologie] = (this.stats.typologies[s.classement.typologie] ?? 0) + 1;
    const lod0 = t.lod === 0, lod2 = t.lod === 2;
    // décalage UV le long de la rue (continuité des joints entre façades voisines)
    const uo = (ax * 0.37 + az * 0.61) % 2;
    const mur: Cle = s.materiau === 'pierre' ? 'pierre' : s.materiau === 'brique' ? 'brique' : s.materiau === 'beton' ? 'beton' : s.materiau === 'verre' ? 'beton' : 'enduit';
    const teinte: [number, number, number] = s.materiau === 'brique' ? [1, 0.97, 0.95] : s.teinte;
    const decor: [number, number, number] = s.materiau === 'pierre' ? [Math.min(1, s.teinte[0] * 1.03), Math.min(1, s.teinte[1] * 1.03), Math.min(1, s.teinte[2] * 1.03)] : s.materiau === 'brique' ? [0.9, 0.88, 0.84] : s.teinte;
    const rdcHaut = s.niveaux.length > 1 ? s.niveaux[1]!.v : s.hauteur;
    const bas = -(s.socle + 0.4); // le mur descend sous le trottoir : jamais de jour sous la façade

    // 1. Mur percé : bandes horizontales entre toutes les arêtes d'ouvertures
    const ouv = s.ouvertures;
    const coupes = new Set<number>([bas, 0, rdcHaut, s.hauteur]);
    for (const o of ouv) coupes.add(o.v), coupes.add(o.v + o.h);
    const vs = [...coupes].filter((v) => v >= bas && v <= s.hauteur).sort((a, b) => a - b);
    for (let i = 0; i + 1 < vs.length; i++) {
      const v0 = vs[i]!, v1 = vs[i + 1]!;
      if (v1 - v0 < EPS) continue;
      const trous = ouv.filter((o) => o.v <= v0 + EPS && o.v + o.h >= v1 - EPS).map((o) => [o.u, o.u + o.l] as const).sort((a, b) => a[0] - b[0]);
      const k: Cle = s.refends && v1 <= rdcHaut + EPS ? 'refends' : mur;
      let u = 0;
      for (const [h0, h1] of trous) {
        this.face(k, R, u, h0, v0, v1, 0, teinte, uo);
        u = Math.max(u, h1);
      }
      this.face(k, R, u, W, v0, v1, 0, teinte, uo);
    }

    // 1 bis. Dos de la façade : mur plein, tourné vers l'intérieur, derrière les tableaux les plus profonds.
    // Vue depuis une cour, un drone ou l'intérieur d'un îlot : jamais de façade « transparente » ni de décors flottants.
    const dos = -(Math.max(0.1, ...ouv.map((o) => o.prof)) + 0.03);
    this.quad(mur, R, [[0, bas, dos], [W, bas, dos], [W, s.hauteur, dos], [0, s.hauteur, dos]], [0, 0, -1], [[uo, bas], [W + uo, bas], [W + uo, s.hauteur], [uo, s.hauteur]], teinte);
    // chants verticaux aux extrémités (épaisseur du mur)
    this.quad(mur, R, [[0, bas, dos], [0, s.hauteur, dos], [0, s.hauteur, 0], [0, bas, 0]], [-1, 0, 0], [[dos, bas], [dos, s.hauteur], [0, s.hauteur], [0, bas]], teinte);
    this.quad(mur, R, [[W, bas, dos], [W, s.hauteur, dos], [W, s.hauteur, 0], [W, bas, 0]], [1, 0, 0], [[dos, bas], [dos, s.hauteur], [0, s.hauteur], [0, bas]], teinte);
    // 2. Ouvertures : tableaux, menuiseries, vitres
    for (const o of ouv) {
      this.plat = !lod0;
      this.ouverture(R, s, o, mur, teinte, decor, lod0, uo, lod2);
      this.plat = false;
    }

    // 3. Balcons filants : dalle, consoles, garde-corps
    for (const b of s.balcons) {
      this.pave('decor', R, b.u0, b.u1, b.v - 0.2, b.v, 0, b.saillie, decor, uo);
      this.pave('decor', R, b.u0 + 0.03, b.u1 - 0.03, b.v - 0.27, b.v - 0.2, 0, b.saillie - 0.06, decor, uo);
      if (lod0) for (const c of b.consoles) {
        this.pave('decor', R, c - 0.11, c + 0.11, b.v - 0.75, b.v - 0.27, 0, b.saillie * 0.45, decor, uo);
        this.pave('decor', R, c - 0.11, c + 0.11, b.v - 0.45, b.v - 0.27, b.saillie * 0.45, b.saillie * 0.75, decor, uo);
      }
      const dF = b.saillie - 0.05;
      if (!lod2) this.ferronnerie(R, b.u0 + 0.02, b.u1 - 0.02, b.v, b.v + 1.0, dF, dF);
      if (!lod2) {
        this.ferronnerie(R, b.u0 + 0.02, b.u0 + 0.02, b.v, b.v + 1.0, 0.02, dF);
        this.ferronnerie(R, b.u1 - 0.02, b.u1 - 0.02, b.v, b.v + 1.0, 0.02, dF);
      }
      this.pave('metal', R, b.u0, b.u1, b.v + 0.98, b.v + 1.03, dF - 0.03, dF + 0.03, [0.16, 0.17, 0.18]);
    }

    // 4. Bandeaux, corniche, enseignes
    for (const bd of s.bandeaux) this.pave('decor', R, 0, W, bd.v, bd.v + bd.h, 0, bd.saillie, decor, uo);
    if (s.corniche) {
      const c = s.corniche;
      this.pave('decor', R, 0, W, c.v, c.v + c.h * 0.3, 0, c.saillie * 0.3, decor, uo);
      this.pave('decor', R, 0, W, c.v + c.h * 0.3, c.v + c.h * 0.62, 0, c.saillie * 0.55, decor, uo);
      this.pave('decor', R, 0, W, c.v + c.h * 0.62, c.v + c.h, 0, c.saillie, decor, uo);
      if (lod0 && (s.classement.typologie === 'haussmannien' || s.classement.typologie === 'post-haussmannien'))
        for (let u = 0.35; u < W - 0.2; u += 0.55) this.pave('decor', R, u - 0.07, u + 0.07, c.v + c.h * 0.4, c.v + c.h * 0.62, c.saillie * 0.55, c.saillie * 0.85, decor, uo);
    }
    for (const en of s.enseignes) if (en.h > 0.15) this.pave('enseigne', R, en.u - 0.05, en.u + en.l + 0.05, en.v, en.v + en.h, 0, 0.12, s.teinteAccent);
  }

  private ouverture(R: Repere, s: FacadeSpec, o: Ouverture, mur: Cle, teinte: [number, number, number], decor: [number, number, number], lod0: boolean, uo: number, lod2 = false) {
    const { u, v, l, h, prof } = o;
    const k: Cle = s.refends && o.niveau === 0 ? 'refends' : mur;
    // tableaux (embrasures) : intérieur du trou, faces tournées vers l'axe de l'ouverture
    this.quad(k, R, [[u, v, -prof], [u, v + h, -prof], [u, v + h, 0], [u, v, 0]], [1, 0, 0], [[0, v], [0, v + h], [prof, v + h], [prof, v]], teinte);
    this.quad(k, R, [[u + l, v, -prof], [u + l, v + h, -prof], [u + l, v + h, 0], [u + l, v, 0]], [-1, 0, 0], [[0, v], [0, v + h], [prof, v + h], [prof, v]], teinte);
    this.quad(k, R, [[u, v + h, -prof], [u + l, v + h, -prof], [u + l, v + h, 0], [u, v + h, 0]], [0, -1, 0], [[u + uo, 0], [u + l + uo, 0], [u + l + uo, prof], [u + uo, prof]], teinte);
    this.quad(k, R, [[u, v, -prof], [u + l, v, -prof], [u + l, v, 0], [u, v, 0]], [0, 1, 0], [[u + uo, 0], [u + l + uo, 0], [u + l + uo, prof], [u + uo, prof]], teinte);

    const pid = (((s.niveaux.length * 131 + o.niveau * 17 + o.travee) * 2654435761) >>> 0) / 4294967296 + (hacheId(s.id) % 1000) / 1000;
    const pidF = pid % 1;
    const menu = s.teinteMenuiserie, acc = s.teinteAccent;
    const dV = -prof + 0.04; // plan des vitres
    const f = 0.065; // largeur du dormant

    if (lod2) {
      const k2: Cle = o.type === 'porte-cochere' || o.type === 'porte' ? 'bois' : o.type === 'mur-rideau' || o.type === 'vitrine' ? 'vitre' : pidF < 0.3 ? 'rideau' : pidF < 0.4 ? 'rideau2' : 'vitre';
      this.face(k2, R, u, u + l, v, v + h, dV, k2 === 'bois' ? acc : [1, 1, 1], 0, pidF);
      if (o.gardeCorps) this.pave('metal', R, u, u + l, v + 0.98, v + 1.03, -0.06, 0.0, [0.16, 0.17, 0.18]);
      return;
    } else if (o.type === 'porte-cochere' || o.type === 'porte') {
      const hV = o.type === 'porte-cochere' ? Math.min(0.9, h * 0.22) : h * 0.35;
      // imposte vitrée en haut, vantaux de bois dessous
      this.face('vitre', R, u, u + l, v + h - hV, v + h, dV, [1, 1, 1], 0, pidF);
      this.pave('bois', R, u, u + l, v + h - hV - 0.12, v + h - hV, dV - 0.02, dV + 0.05, acc);
      this.face('bois', R, u, u + l, v, v + h - hV - 0.12, dV + 0.01, acc);
      if (lod0) {
        const nV = o.type === 'porte-cochere' ? 2 : 1;
        for (let i = 0; i < nV; i++) {
          const a = u + (l / nV) * i + 0.12, b = u + (l / nV) * (i + 1) - 0.12;
          for (const [p0, p1] of [[v + 0.15, v + (h - hV) * 0.32], [v + (h - hV) * 0.38, v + h - hV - 0.25]] as const)
            this.pave('bois', R, a, b, p0, p1, dV + 0.01, dV + 0.045, [acc[0] * 1.15, acc[1] * 1.15, acc[2] * 1.15]);
        }
        if (nV === 2) this.pave('bois', R, u + l / 2 - 0.02, u + l / 2 + 0.02, v, v + h - hV - 0.12, dV + 0.01, dV + 0.06, [acc[0] * 0.7, acc[1] * 0.7, acc[2] * 0.7]);
      }
    } else if (o.type === 'vitrine') {
      // devanture : cadre peint (couleur d'accent), vitrage, soubassement
      const c = acc;
      this.pave('bois', R, u, u + l, v, v + 0.45, dV - 0.02, dV + 0.04, c);
      this.pave('bois', R, u, u + 0.12, v + 0.45, v + h, dV - 0.02, dV + 0.04, c);
      this.pave('bois', R, u + l - 0.12, u + l, v + 0.45, v + h, dV - 0.02, dV + 0.04, c);
      this.pave('bois', R, u, u + l, v + h - 0.12, v + h, dV - 0.02, dV + 0.04, c);
      const n = Math.max(1, Math.round((l - 0.24) / 1.4));
      const pas = (l - 0.24) / n;
      for (let i = 1; i < n; i++) this.pave('bois', R, u + 0.12 + pas * i - 0.04, u + 0.12 + pas * i + 0.04, v + 0.45, v + h - 0.12, dV - 0.01, dV + 0.03, c);
      this.face('vitre', R, u + 0.12, u + l - 0.12, v + 0.45, v + h - 0.12, dV, [1, 1, 1], 0, pidF);
    } else {
      // fenêtre, porte-fenêtre, baie, mur-rideau : dormant + vantaux + imposte + petits bois
      const mc = menu;
      this.pave('menuiserie', R, u, u + l, v, v + f, dV - 0.03, dV + 0.03, mc);
      this.pave('menuiserie', R, u, u + l, v + h - f, v + h, dV - 0.03, dV + 0.03, mc);
      this.pave('menuiserie', R, u, u + f, v + f, v + h - f, dV - 0.03, dV + 0.03, mc);
      this.pave('menuiserie', R, u + l - f, u + l, v + f, v + h - f, dV - 0.03, dV + 0.03, mc);
      const hI = o.imposte ? v + h * 0.78 : v + h - f;
      if (o.imposte) this.pave('menuiserie', R, u + f, u + l - f, hI - 0.035, hI + 0.035, dV - 0.02, dV + 0.03, mc);
      if (o.vantaux >= 2) this.pave('menuiserie', R, u + l / 2 - 0.04, u + l / 2 + 0.04, v + f, hI - 0.035, dV - 0.02, dV + 0.035, mc);
      if (lod0 && (s.classement.typologie === 'haussmannien' || s.classement.typologie === 'post-haussmannien' || s.classement.typologie === 'faubourien')) {
        // petits bois : 3 ou 4 carreaux par vantail
        const nC = o.type === 'porte-fenetre' ? 4 : 3;
        for (let i = 1; i < nC; i++) {
          const y = v + f + ((hI - 0.035 - v - f) / nC) * i;
          this.pave('menuiserie', R, u + f, u + l - f, y - 0.014, y + 0.014, dV - 0.01, dV + 0.02, mc);
        }
      }
      // vitrage : vitre ou voilage (les Parisiens tirent souvent leurs voilages)
      const k2: Cle = o.type === 'mur-rideau' ? 'vitre' : pidF < 0.3 ? 'rideau' : pidF < 0.4 ? 'rideau2' : 'vitre';
      this.face(k2, R, u + f, u + l - f, v + f, v + h - f, dV, [1, 1, 1], 0, pidF);
      if (o.type === 'fenetre' && o.niveau > 0) {
        // appui saillant
        this.pave('decor', R, u - 0.12, u + l + 0.12, v - 0.08, v, 0, 0.08, decor, uo);
      }
    }

    // garde-corps de porte-fenêtre (balconnet) dans le plan de la façade
    if (o.gardeCorps) {
      this.ferronnerie(R, u + 0.01, u + l - 0.01, v, v + 1.0, -0.03, -0.03);
      this.pave('metal', R, u, u + l, v + 0.98, v + 1.03, -0.06, 0.0, [0.16, 0.17, 0.18]);
    }
    // encadrements
    if (o.encadrement >= 1 && o.type !== 'vitrine') {
      const w = o.encadrement === 2 ? 0.2 : 0.14, sl = o.encadrement === 2 ? 0.06 : 0.035;
      this.pave('decor', R, u - w, u, v, v + h, 0, sl, decor, uo);
      this.pave('decor', R, u + l, u + l + w, v, v + h, 0, sl, decor, uo);
      this.pave('decor', R, u - w, u + l + w, v + h, v + h + w, 0, sl, decor, uo);
      if (o.encadrement === 2) {
        // corniche de fenêtre sur consoles
        this.pave('decor', R, u - w - 0.12, u + l + w + 0.12, v + h + w + 0.14, v + h + w + 0.3, 0, 0.2, decor, uo);
        if (lod0) for (const c of [u - w + 0.02, u + l + w - 0.12]) this.pave('decor', R, c, c + 0.1, v + h + w - 0.05, v + h + w + 0.14, 0, 0.15, decor, uo);
      }
    }
    // volets ouverts contre le mur
    if (o.volets && lod0) {
      const c = s.teinteAccent;
      this.pave('bois', R, u - w2(l) - 0.02, u - 0.02, v, v + h, 0.01, 0.05, c);
      this.pave('bois', R, u + l + 0.02, u + l + w2(l) + 0.02, v, v + h, 0.01, 0.05, c);
    }
  }

  /** Panneau de ferronnerie (découpe alphaTest) de (u0, d0) à (u1, d1), de v0 à v1. */
  private ferronnerie(R: Repere, u0: number, u1: number, v0: number, v1: number, d0: number, d1: number) {
    const L = Math.hypot(u1 - u0, d1 - d0);
    if (L < 0.05) return;
    const n: [number, number, number] = [(d1 - d0) / L * -1, 0, (u1 - u0) / L];
    // normale vers la rue (le matériau est double face)
    const nn: [number, number, number] = n[2] >= 0 ? n : [-n[0], 0, -n[2]];
    this.quad('fer', R, [[u0, v0, d0], [u1, v0, d1], [u1, v1, d1], [u0, v1, d0]], nn, [[0, 0], [L, 0], [L, (v1 - v0)], [0, v1 - v0]], [1, 1, 1]);
  }

  /** Vitres et voilages pour l'éclairage de nuit (nuit.ts). */
  get materiaux() {
    return this.mats;
  }
}

const w2 = (l: number) => l / 2;

/** Patine des murs (shader) : salissure en pied de façade, nuances à grande échelle, coulures verticales. */
function patiner(m: THREE.MeshStandardMaterial) {
  m.defines = { ...(m.defines ?? {}), USE_UV: '' };
  m.onBeforeCompile = (s) => {
    s.vertexShader = 'varying vec3 vWpF;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvWpF = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWpF;
float hF(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float nF(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hF(i), hF(i + vec2(1, 0)), f.x), mix(hF(i + vec2(0, 1)), hF(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  {
    float pied = smoothstep(0.0, 1.6, vUv.y);
    diffuseColor.rgb *= mix(0.74, 1.0, pied);
    float n = nF(vWpF.xz * 0.23 + vec2(vWpF.y * 0.17, 0.0)) * 0.6 + nF(vWpF.xz * 0.9 + vWpF.y * 0.5) * 0.4;
    diffuseColor.rgb *= 0.9 + 0.16 * n;
    float c = nF(vec2((vWpF.x + vWpF.z) * 2.3, vWpF.y * 0.12));
    diffuseColor.rgb *= 1.0 - 0.1 * smoothstep(0.62, 0.95, c);
  }`);
  };
}
/** Teintes sRGB → linéaire (les couleurs de sommets sont lues en linéaire). */
const lin = (c: number) => Math.pow(Math.min(1, Math.max(0, c)), 2.2);
function hacheId(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
