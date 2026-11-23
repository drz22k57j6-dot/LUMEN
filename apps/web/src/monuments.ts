// Monuments de Paris (Open Landmarks, CC BY ; données © contributeurs OpenStreetMap, ODbL).
// Modèles géoréférencés à l'échelle réelle (X est, Y haut, Z sud), posés à leur position Lambert-93
// et à l'altitude du sol mesurée au LiDAR HD. Repris du projet limoges-3d (sauf tour Eiffel et Hôtel de Ville).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { Batiment, XY } from '@lumen/core';
import { contient } from '@lumen/urban';

export interface Monument {
  nom: string;
  fichier: string;
  /** Centre en Lambert-93 (m). */
  x: number;
  y: number;
  /** Altitude du sol (NGF, m), mesurée au LiDAR HD. */
  sol_alt: number;
  cap_deg: number;
  rayon_m: number;
  hauteur_m: number;
  /** Bâtiments BD TOPO remplacés par le modèle. */
  ids: string[];
  source: string;
  verifie: string;
}

const BASE = `${import.meta.env.BASE_URL}monuments/`;
let catalogue: Promise<Monument[]> | null = null;

export function catalogueMonuments(): Promise<Monument[]> {
  catalogue ??= fetch(`${BASE}index.json`)
    .then((r) => (r.ok ? r.json() : { monuments: [] }))
    .then((j: { monuments: Monument[] }) => j.monuments)
    .catch(() => []);
  return catalogue;
}

/** Monuments dont le centre tombe dans l'emprise [xmin, ymin, xmax, ymax]. */
export const monumentsDans = (cat: Monument[], b: [number, number, number, number]) =>
  cat.filter((m) => m.x > b[0] && m.x < b[2] && m.y > b[1] && m.y < b[3]);

/** Le bâtiment IGN (cleabs) est-il remplacé par un monument ? */
export const remplace = (ms: Monument[], b: Batiment) => ms.some((m) => m.ids.some((id) => b.id === id));

/** Test « dans l'emprise d'un monument » : emprises IGN remplacées, sinon disque de rayon_m. */
export function emprisesMonuments(ms: Monument[], batiments: Batiment[]): (p: XY) => boolean {
  const zones = ms.map((m) => {
    const bats = batiments.filter((b) => m.ids.some((id) => b.id === id));
    const r = m.rayon_m + 3;
    return { m, bats, r };
  });
  return (p) =>
    zones.some(({ m, bats, r }) => {
      if (Math.abs(p.x - m.x) > r + 60 || Math.abs(p.y - m.y) > r + 60) return false;
      return bats.length ? bats.some((b) => contient(b.contour, p)) : Math.hypot(p.x - m.x, p.y - m.y) < r;
    });
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

/** Charge et place les monuments ; ceux qui échouent sont ignorés. */
export async function chargerMonuments(ms: Monument[], vers3: (p: XY, z: number) => THREE.Vector3, mobile: boolean): Promise<THREE.Group> {
  const g = new THREE.Group();
  g.name = 'monuments';
  await Promise.all(
    ms.map(async (m) => {
      try {
        const gltf = await loader.loadAsync(BASE + m.fichier);
        const o = gltf.scene;
        o.position.copy(vers3({ x: m.x, y: m.y }, m.sol_alt));
        o.rotation.y = -THREE.MathUtils.degToRad(m.cap_deg);
        o.name = m.nom;
        o.userData.monument = m;
        o.traverse((n) => {
          if (n instanceof THREE.Mesh) {
            n.castShadow = n.receiveShadow = true;
            const mat = n.material as THREE.MeshStandardMaterial;
            if (mat.map) mat.map.anisotropy = mobile ? 4 : 8;
          }
        });
        g.add(o);
      } catch {
        /* modèle indisponible : le volume IGN reste masqué, rien d'inventé à la place */
      }
    }),
  );
  return g;
}

export function libererMonuments(g: THREE.Group) {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      for (const m of ([] as THREE.Material[]).concat(o.material)) {
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
        m.dispose();
      }
    }
  });
}

/**
 * Empreinte au sol réelle des modèles chargés (triangles projetés, grille de 1 m, marge de 1 m),
 * dans le repère de la scène. Sert à aplanir le relief LiDAR, qui contient déjà l'édifice.
 */
export function empreinteModeles(g: THREE.Group, pas = 1): (x: number, z: number) => boolean {
  const cases = new Set<number>();
  const cle = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  g.updateMatrixWorld(true);
  g.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = o.geometry.attributes.position as THREE.BufferAttribute, idx = o.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t + 2 < n; t += 3) {
      a.fromBufferAttribute(pos, idx ? idx.getX(t) : t).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, idx ? idx.getX(t + 1) : t + 1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, idx ? idx.getX(t + 2) : t + 2).applyMatrix4(o.matrixWorld);
      const i0 = Math.floor(Math.min(a.x, b.x, c.x) / pas), i1 = Math.floor(Math.max(a.x, b.x, c.x) / pas);
      const j0 = Math.floor(Math.min(a.z, b.z, c.z) / pas), j1 = Math.floor(Math.max(a.z, b.z, c.z) / pas);
      const ar = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
      if (Math.abs(ar) < 1e-9 || (i0 === i1 && j0 === j1)) {
        cases.add(cle(i0, j0));
        continue;
      }
      for (let i = i0; i <= i1; i++)
        for (let j = j0; j <= j1; j++) {
          const px = (i + 0.5) * pas, pz = (j + 0.5) * pas;
          const w0 = ((b.x - px) * (c.z - pz) - (b.z - pz) * (c.x - px)) / ar;
          const w1 = ((c.x - px) * (a.z - pz) - (c.z - pz) * (a.x - px)) / ar;
          if (w0 >= -0.3 && w1 >= -0.3 && 1 - w0 - w1 >= -0.3) cases.add(cle(i, j));
        }
    }
  });
  return (x, z) => {
    const i = Math.floor(x / pas), j = Math.floor(z / pas);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if (cases.has(cle(i + di, j + dj))) return true;
    return false;
  };
}
