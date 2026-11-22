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

/** Le bâtiment IGN est-il remplacé par un monument ? (identifiant WFS « batiment.BATIMENT… ») */
export const remplace = (ms: Monument[], b: Batiment) => ms.some((m) => m.ids.some((id) => b.id.endsWith(id)));

/** Test « dans l'emprise d'un monument » : emprises IGN remplacées, sinon disque de rayon_m. */
export function emprisesMonuments(ms: Monument[], batiments: Batiment[]): (p: XY) => boolean {
  const zones = ms.map((m) => {
    const bats = batiments.filter((b) => m.ids.some((id) => b.id.endsWith(id)));
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
