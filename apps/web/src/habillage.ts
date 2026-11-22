/**
 * Habillage des vrais bâtiments IGN par le moteur de façades parisiennes (repris de limoges-3d, v3) :
 * pour chaque façade sur rue (arête du contour BD TOPO dont l'extérieur n'est pas un autre bâtiment),
 * on génère un immeuble procédural en vrai relief, à la longueur et à la hauteur de gouttière réelles.
 * Construction étalée sur plusieurs images (pas de saccade), puis fusion par matériau (peu d'appels de dessin).
 * Le volume IGN des bâtiments habillés est rentré de 0,6 m pour laisser passer le relief des façades.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Batiment, XY } from '@lumen/core';
import { contient } from '@lumen/urban';
import { buildBuilding, createKit, type Kit, type OptionsImmeuble } from './moteurs/facades/facades.js';
import { materiauxPartages } from './moteurs/facades/commerces.js';

const TEINTES: Record<'pierre' | 'riche' | 'enduit', [number, number, number][]> = {
  pierre: [[0xf6ead2, 5, 0.04], [0xfbf3e4, 3, 0.03], [0xe9e2d6, 2, 0.04], [0xf0dcb8, 1.5, 0.04], [0xdcd8d0, 1, 0.03]],
  riche: [[0xfaf2e3, 4, 0.02], [0xf6eddb, 3, 0.02], [0xfdf8ef, 2, 0.015]],
  enduit: [[0xeee6d6, 3, 0.05], [0xe2c08e, 1.2, 0.06], [0xe6c2b6, 1, 0.05], [0xe8da9e, 1, 0.05], [0xbdb9b0, 1.5, 0.05], [0xf4f1ea, 1.5, 0.03]],
};
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const rngOf = (s: string) => { let x = (hash(s) % 2147483646) + 1; return () => (x = (x * 16807) % 2147483647) / 2147483647; };

let KIT: Kit | null = null;
const kit = () => (KIT ??= createKit(THREE, `${import.meta.env.BASE_URL}tex/facades/`));

const aireSignee = (c: XY[]) => c.reduce((s, p, i) => { const q = c[(i + 1) % c.length]!; return s + p.x * q.y - q.x * p.y; }, 0) / 2;
const ccw = (c: XY[]) => (aireSignee(c) < 0 ? [...c].reverse() : c);

/** Contour rentré de d mètres (décalage le long des bissectrices, borné aux angles aigus). */
export function rentrer(contour: XY[], d: number): XY[] {
  const c = ccw(contour), n = c.length;
  return c.map((p, i) => {
    const a = c[(i - 1 + n) % n]!, b = c[(i + 1) % n]!;
    const e1 = norm({ x: p.x - a.x, y: p.y - a.y }), e2 = norm({ x: b.x - p.x, y: b.y - p.y });
    // normales intérieures (contour antihoraire : intérieur à gauche)
    const n1 = { x: -e1.y, y: e1.x }, n2 = { x: -e2.y, y: e2.x };
    const bi = norm({ x: n1.x + n2.x, y: n1.y + n2.y });
    const cos = Math.max(0.35, bi.x * n1.x + bi.y * n1.y);
    return { x: p.x + (bi.x * d) / cos, y: p.y + (bi.y * d) / cos };
  });
}
function norm(v: XY): XY { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; }

interface Tache { bat: Batiment; a: XY; b: XY; k: number; lod: 0 | 1 }

export interface OptionsHabillage {
  batiments: Batiment[];
  centre: XY;
  /** Rayon habillé (m) et rayon du détail complet (m). */
  rayon: number;
  rayonDetail: number;
  /** Altitude absolue du terrain en un point (m). */
  sol: (p: XY) => number;
  /** Point Lambert-93 + altitude absolue → repère local de la scène. */
  vers3: (p: XY, z: number) => THREE.Vector3;
  ombres: boolean;
}

export interface Habillage {
  groupe: THREE.Group;
  /** Identifiants des bâtiments qui reçoivent au moins une façade. */
  habilles: Set<string>;
  /** Avance la construction (budget en ms). Renvoie true quand tout est construit. */
  tache: (budget: number) => boolean;
  progression: () => number;
  liberer: () => void;
}

export function creerHabillage(o: OptionsHabillage): Habillage {
  const groupe = new THREE.Group();
  groupe.name = 'facades_aaa';
  const enCours = new THREE.Group();
  groupe.add(enCours);

  // Grille spatiale des emprises (test « l'extérieur de cette arête est-il un autre bâtiment ? »)
  const CELL = 25, grille = new Map<string, Batiment[]>();
  for (const b of o.batiments) {
    const xs = b.contour.map((p) => p.x), ys = b.contour.map((p) => p.y);
    for (let i = Math.floor(Math.min(...xs) / CELL); i <= Math.floor(Math.max(...xs) / CELL); i++)
      for (let j = Math.floor(Math.min(...ys) / CELL); j <= Math.floor(Math.max(...ys) / CELL); j++) {
        const k = `${i}_${j}`; const l = grille.get(k); if (l) l.push(b); else grille.set(k, [b]);
      }
  }
  const occupe = (p: XY, sauf: Batiment) =>
    (grille.get(`${Math.floor(p.x / CELL)}_${Math.floor(p.y / CELL)}`) ?? []).some((b) => b !== sauf && contient(b.contour, p));

  // Liste des façades sur rue
  const taches: Tache[] = [];
  const habilles = new Set<string>();
  for (const bat of o.batiments) {
    if (bat.hauteur.valeur < 5) continue;
    const c = ccw(bat.contour);
    const cx = c.reduce((s, p) => s + p.x, 0) / c.length, cy = c.reduce((s, p) => s + p.y, 0) / c.length;
    const dist = Math.hypot(cx - o.centre.x, cy - o.centre.y);
    if (dist > o.rayon) continue;
    c.forEach((a, k) => {
      const b = c[(k + 1) % c.length]!;
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 4) return;
      const nrm = { x: (b.y - a.y) / L, y: -(b.x - a.x) / L }; // extérieur (contour antihoraire)
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dehors = [1.5, 4].every((t) => !occupe({ x: m.x + nrm.x * t, y: m.y + nrm.y * t }, bat));
      const bouts = [0.2, 0.8].every((f) => !occupe({ x: a.x + (b.x - a.x) * f + nrm.x * 1.5, y: a.y + (b.y - a.y) * f + nrm.y * 1.5 }, bat));
      if (!dehors || !bouts) return;
      taches.push({ bat, a, b, k, lod: dist < o.rayonDetail ? 0 : 1 });
      habilles.add(bat.id);
    });
  }
  taches.sort((p, q) => Math.hypot(p.a.x - o.centre.x, p.a.y - o.centre.y) - Math.hypot(q.a.x - o.centre.x, q.a.y - o.centre.y));
  const total = taches.length;

  const profil = new Map<string, { st: NonNullable<OptionsImmeuble['style']>; tone: number; wear: number }>();
  function profilDe(bat: Batiment, hGout: number) {
    let p = profil.get(bat.id);
    if (p) return p;
    const R = rngOf(bat.id);
    const r = R();
    const st: NonNullable<OptionsImmeuble['style']> =
      hGout > 27 ? 'moderne' : hGout < 11 ? 'modeste' : hGout > 18 && r < 0.25 ? 'riche' : r < 0.8 ? 'classique' : 'modeste';
    const L = st === 'riche' ? TEINTES.riche : st === 'modeste' ? TEINTES.enduit : TEINTES.pierre;
    let x = R() * L.reduce((t, e) => t + e[1], 0), e = L[0]!;
    for (const t of L) if ((x -= t[1]) <= 0) { e = t; break; }
    const col = new THREE.Color(e[0]);
    col.offsetHSL(Math.round((R() - 0.5) * 2) * e[2] * 0.25, 0, Math.round((R() - 0.5) * 2) * e[2] * 0.5);
    p = { st, tone: col.getHex(), wear: Math.round((0.12 + R() * 0.3) * 4) / 4 };
    profil.set(bat.id, p);
    return p;
  }

  function fabriquer(t: Tache) {
    const { bat, a, b, k } = t;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const z = o.sol(m);
    const toit = bat.altitudeToit?.valeur ?? bat.altitudeSol.valeur + bat.hauteur.valeur * 0.85;
    const hGout = THREE.MathUtils.clamp(toit - z, 3, 60);
    const p = profilDe(bat, hGout);
    const W = Math.hypot(b.x - a.x, b.y - a.y);
    const imm = buildBuilding(THREE, kit(), {
      width: W, depth: 6, seed: hash(bat.id) + k * 7919, style: p.st, hGout, wear: p.wear, tone: p.tone,
      pShop: bat.usage && /commerc/i.test(bat.usage) ? 0.8 : 0.3, verdure: 0.5, tagP: 0.3, pClosed: 0.15, toneJit: 0, lod: t.lod,
    });
    const A = o.vers3(a, z), B = o.vers3(b, z);
    const d = new THREE.Vector3().subVectors(B, A).setY(0).normalize();
    const M = new THREE.Matrix4().makeBasis(d, new THREE.Vector3(0, 1, 0), new THREE.Vector3(-d.z, 0, d.x)).setPosition(A);
    imm.applyMatrix4(M);
    imm.traverse((x) => { if ((x as THREE.Mesh).isMesh) { x.castShadow = o.ombres; x.receiveShadow = true; } });
    enCours.add(imm);
  }

  // Fusion finale par matériau
  let fusion: { meshes: THREE.Mesh[]; i: number; par: Map<string, { m: THREE.Material; L: THREE.BufferGeometry[] }>; paquets: { m: THREE.Material; L: THREE.BufferGeometry[] }[] | null } | null = null;
  const final = new THREE.Group();
  let fini = total === 0;

  function tache(budget: number): boolean {
    if (fini) return true;
    const t0 = performance.now();
    while (performance.now() - t0 < budget) {
      const t = taches.shift();
      if (t) { try { fabriquer(t); } catch (e) { console.warn('façade', t.bat.id, e); } continue; }
      if (!fusion) {
        enCours.updateMatrixWorld(true);
        const meshes: THREE.Mesh[] = [];
        enCours.traverse((x) => { if ((x as THREE.Mesh).isMesh) meshes.push(x as THREE.Mesh); });
        fusion = { meshes, i: 0, par: new Map(), paquets: null };
      }
      if (!fusion.paquets) {
        while (fusion.i < fusion.meshes.length && performance.now() - t0 < budget) {
          const x = fusion.meshes[fusion.i++]!;
          const mat = Array.isArray(x.material) ? x.material[0]! : x.material;
          const g = x.geometry.index ? x.geometry.toNonIndexed() : x.geometry.clone();
          g.applyMatrix4(x.matrixWorld);
          const cle = mat.uuid + '|' + Object.keys(g.attributes).sort().join(',');
          let p = fusion.par.get(cle);
          if (!p) fusion.par.set(cle, (p = { m: mat, L: [] }));
          p.L.push(g);
        }
        if (fusion.i < fusion.meshes.length) continue;
        fusion.paquets = [];
        for (const p of fusion.par.values()) {
          let cur: THREE.BufferGeometry[] = [], n = 0;
          for (const g of p.L) { cur.push(g); n += g.attributes.position!.count; if (n > 60000) { fusion.paquets.push({ m: p.m, L: cur }); cur = []; n = 0; } }
          if (cur.length) fusion.paquets.push({ m: p.m, L: cur });
        }
        continue;
      }
      const p = fusion.paquets.pop();
      if (p) {
        const g = p.L.length > 1 ? mergeGeometries(p.L, false) : p.L[0]!;
        if (g) {
          if (p.L.length > 1) p.L.forEach((x) => x.dispose());
          const me = new THREE.Mesh(g, p.m);
          const std = p.m as THREE.MeshStandardMaterial;
          me.castShadow = o.ombres && !p.m.transparent && !(std.emissiveIntensity > 0.5);
          me.receiveShadow = true;
          me.matrixAutoUpdate = false;
          final.add(me);
        }
        continue;
      }
      // terminé : on remplace les immeubles individuels par la version fusionnée
      groupe.remove(enCours);
      enCours.traverse((x) => { if ((x as THREE.Mesh).isMesh) (x as THREE.Mesh).geometry.dispose(); });
      groupe.add(final);
      fusion = null;
      fini = true;
      return true;
    }
    return false;
  }

  function liberer() {
    const partages = new Set<THREE.Material>([...kit().partages(), ...materiauxPartages()]);
    groupe.traverse((x) => {
      const me = x as THREE.Mesh;
      if (!me.isMesh) return;
      me.geometry.dispose();
      const mats = Array.isArray(me.material) ? me.material : [me.material];
      for (const m of mats) if (!partages.has(m)) { (m as THREE.MeshStandardMaterial).map?.dispose(); m.dispose(); }
    });
    groupe.clear();
    taches.length = 0;
    fini = true;
  }

  return { groupe, habilles, tache, progression: () => (total ? 1 - taches.length / total : 1), liberer };
}
