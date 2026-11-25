// Détails de toiture fidèles au LiDAR HD et fermeture des angles d'immeubles.
//  - Cheminées : pics du LiDAR brut (avant lissage) sur le bâti, 0,9–4 m au-dessus du toit autour :
//    position et hauteur mesurées ; souche enduite ou brique + mitrons en terre cuite (forme générée).
//  - Lucarnes : seulement où le LiDAR montre un brisis de mansarde derrière la gouttière ; une par travée
//    (largeur de façade / 3 m), posées sur la pente mesurée.
//  - Angles : murs courts (pans coupés, retours < 3,5 m) que les façades n'habillent pas, fermés en pierre
//    jusqu'à la gouttière des façades voisines.
import * as THREE from 'three';
import type { XY } from '@lumen/core';
import type { TacheFacade } from './facades/mesher';

export interface GrilleBrute {
  n: number;
  bbox: [number, number, number, number];
  brut: Float32Array;
  classes: Uint8Array;
}

export interface ParamsToits {
  g: GrilleBrute;
  taches: TacheFacade[];
  contours: { id: string; contour: XY[] }[];
  /** repère scène ↔ Lambert-93 */
  versL: (x: number, z: number) => XY;
  versS: (p: XY) => { x: number; z: number };
  /** altitude NGF → y scène */
  y: (alt: number) => number;
  sol: (p: XY) => number;
  mobile: boolean;
  /** Altitude du toit ajusté (toits procéduraux) : les cheminées y sont posées, sommet LiDAR conservé. */
  surToit?: (p: XY) => number | null;
}

const hachage = (x: number, y: number) => {
  let h = Math.imul(Math.floor(x * 7) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.floor(y * 7), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

function pierre(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xd9ccb4, roughness: 0.88 });
  m.onBeforeCompile = (s) => {
    s.vertexShader = 'varying vec3 vP;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vP;\nfloat hP(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }')
      .replace(
        '#include <map_fragment>',
        // assises de pierre de taille (≈ 45 cm), joints fins, teinte par bloc
        `float rang = floor(vP.y / 0.45); float l = (vP.x + vP.z) / 0.9 + 0.5 * rang;
         float j = max(1.0 - smoothstep(0.0, 0.02, abs(fract(vP.y / 0.45) - 0.5) - 0.47), 1.0 - smoothstep(0.0, 0.03, abs(fract(l) - 0.5) - 0.465));
         diffuseColor.rgb *= (0.9 + 0.16 * hP(vec2(floor(l), rang))) * (1.0 - 0.18 * j);`,
      );
  };
  return m;
}

export function creerDetailsToits(P: ParamsToits): { groupe: THREE.Group; stats: { cheminees: number; lucarnes: number; angles: number } } {
  const { g } = P;
  const res = (g.bbox[2] - g.bbox[0]) / g.n;
  const groupe = new THREE.Group();
  groupe.name = 'toitures';
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

  // ---------------- cheminées (pics LiDAR) ----------------
  const chem: { p: XY; base: number; h: number; ang: number; brique: boolean }[] = [];
  const R = Math.round(1.25 / res), anneau = Math.round(2.5 / res);
  for (let r = anneau; r < g.n - anneau; r++)
    for (let c = anneau; c < g.n - anneau; c++) {
      const i = r * g.n + c;
      if (g.classes[i] !== 1) continue;
      const h = g.brut[i]!;
      if (!Number.isFinite(h)) continue;
      let max = true;
      for (let dr = -R; dr <= R && max; dr++) for (let dc = -R; dc <= R; dc++) if (g.brut[i + dr * g.n + dc]! > h) { max = false; break; }
      if (!max) continue;
      const ring: number[] = [];
      for (let a = 0; a < 16; a++) {
        const rr = r + Math.round(Math.sin((a * Math.PI) / 8) * anneau), cc = c + Math.round(Math.cos((a * Math.PI) / 8) * anneau);
        const v = g.brut[rr * g.n + cc]!;
        if (Number.isFinite(v)) ring.push(v);
      }
      if (ring.length < 10) continue;
      ring.sort((a, b) => a - b);
      const base = ring[Math.floor(ring.length / 2)]!, d = h - base;
      if (d < 0.9 || d > 4) continue; // < 0,9 m : bruit ; > 4 m : antenne, édicule, arbre
      if (ring[0]! < base - 6) continue; // bord de toit : pas une cheminée
      const p = { x: g.bbox[0] + (c + 0.5) * res, y: g.bbox[3] - (r + 0.5) * res };
      if (chem.some((o) => Math.hypot(o.p.x - p.x, o.p.y - p.y) < 1.6)) continue;
      chem.push({ p, base, h: d + 0.3, ang: hachage(p.x, p.y) * Math.PI, brique: hachage(p.y, p.x) < 0.35 });
    }
  const nMax = P.mobile ? 250 : 600;
  chem.splice(nMax);
  if (chem.length) {
    const souche = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mitron = new THREE.CylinderGeometry(0.11, 0.13, 0.55, 8).translate(0, 0.275, 0);
    const enduit = new THREE.MeshStandardMaterial({ color: 0xa89a86, roughness: 0.95 });
    const brique = new THREE.MeshStandardMaterial({ color: 0x8c4a36, roughness: 0.9 });
    const terre = new THREE.MeshStandardMaterial({ color: 0xa65a38, roughness: 0.85 });
    const nE = chem.filter((c) => !c.brique).length;
    const mE = new THREE.InstancedMesh(souche, enduit, nE), mB = new THREE.InstancedMesh(souche, brique, chem.length - nE);
    const nPots = chem.length * 3;
    const mP = new THREE.InstancedMesh(mitron, terre, nPots);
    let iE = 0, iB = 0, iP = 0;
    for (const c of chem) {
      const s = P.versS(c.p);
      const sommet = c.base + c.h, b0 = P.surToit?.(c.p) ?? c.base;
      if (sommet - b0 < 0.7 || sommet - b0 > 5) continue;
      const y0 = P.y(b0) - 0.3;
      c.h = sommet - b0 + 0.1;
      q.setFromAxisAngle(up, c.ang);
      const L = 1.1 + hachage(c.p.x + 1, c.p.y) * 0.9;
      m4.compose(new THREE.Vector3(s.x, y0, s.z), q, sc.set(L, c.h + 0.2, 0.55));
      c.brique ? mB.setMatrixAt(iB++, m4) : mE.setMatrixAt(iE++, m4);
      const k = 2 + Math.floor(hachage(c.p.x, c.p.y + 3) * 2);
      for (let j = 0; j < k; j++) {
        const off = (j - (k - 1) / 2) * (L / k);
        const v = new THREE.Vector3(off, 0, 0).applyQuaternion(q);
        mP.setMatrixAt(iP++, m4.compose(new THREE.Vector3(s.x + v.x, y0 + c.h + 0.2, s.z + v.z), q, sc.set(1, 0.8 + 0.4 * hachage(j, c.p.x), 1)));
      }
    }
    mP.count = iP;
    mE.count = iE;
    mB.count = iB;
    for (const o of [mE, mB, mP]) (o.castShadow = o.receiveShadow = true), groupe.add(o);
  }

  // lucarnes : dessinées par le générateur de façades (mansarde + lucarnes calées sur la gouttière LiDAR)
  const lucs: unknown[] = [];

  // ---------------- angles (murs courts non habillés) ----------------
  const parBat = new Map<string, TacheFacade[]>();
  for (const t of P.taches) {
    const id = t.id.split(':')[0]!;
    (parBat.get(id) ?? parBat.set(id, []).get(id)!).push(t);
  }
  const pos: number[] = [];
  let angles = 0;
  // avec les toits procéduraux, les murs (angles compris) sont construits sur le contour exact : rien à fermer ici
  for (const b of P.surToit ? [] : P.contours) {
    const ts = parBat.get(b.id);
    if (!ts?.length) continue;
    const habilles = new Set(ts.map((t) => Number(t.id.split(':')[1])));
    const gout = Math.min(...ts.map((t) => t.y + t.hGout));
    const n = b.contour.length;
    for (let i = 0; i < n; i++) {
      if (habilles.has(i)) continue;
      const A = b.contour[i]!, B = b.contour[(i + 1) % n]!, L = Math.hypot(B.x - A.x, B.y - A.y);
      if (L < 0.4 || L >= 3.5) continue;
      if (!habilles.has((i - 1 + n) % n) && !habilles.has((i + 1) % n)) continue; // seulement entre deux façades
      const a = P.versS(A), c = P.versS(B);
      const ya = P.y(P.sol(A)) - 0.3, yc = P.y(P.sol(B)) - 0.3;
      pos.push(a.x, ya, a.z, c.x, yc, c.z, c.x, gout, c.z, a.x, ya, a.z, c.x, gout, c.z, a.x, gout, a.z);
      angles++;
    }
  }
  if (pos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, pierre());
    (m.material as THREE.Material).side = THREE.DoubleSide;
    m.castShadow = m.receiveShadow = true;
    groupe.add(m);
  }
  return { groupe, stats: { cheminees: chem.length, lucarnes: lucs.length, angles } };
}
