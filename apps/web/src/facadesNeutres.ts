/**
 * Façades NEUTRES (provisoire) : l'ancien moteur de façades a été supprimé (voir docs/prompts/moteur-facades.md).
 * Chaque façade sur rue détectée au LiDAR est fermée par un simple plan pierre, sans fenêtres inventées,
 * de la base (point haut du trottoir) à la gouttière mesurée, avec soubassement si la rue est en pente.
 * Le futur moteur remplace `creerFacadesNeutres` en consommant les mêmes `TacheFacade`.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

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
  lod: 0 | 1;
}

const MAT = new THREE.MeshStandardMaterial({ color: 0xd9cfbd, roughness: 0.9, side: THREE.FrontSide });

export function creerFacadesNeutres(taches: TacheFacade[]): THREE.Mesh | null {
  const geos: THREE.BufferGeometry[] = [];
  for (const t of taches) {
    const [ax, az] = t.a, [bx, bz] = t.b;
    const W = Math.hypot(bx - ax, bz - az);
    if (W < 0.5) continue;
    const bas = t.y - (t.socle ?? 0) - 0.3, haut = t.y + t.hGout;
    const g = new THREE.PlaneGeometry(W, haut - bas);
    // plan XY centré → pivoté pour que sa normale (+Z) devienne la normale sortante (-dz, dx)
    g.translate(W / 2, (haut - bas) / 2, 0);
    g.rotateY(-Math.atan2(bz - az, bx - ax));
    g.translate(ax, bas, az);
    geos.push(g);
  }
  if (!geos.length) return null;
  const m = new THREE.Mesh(mergeGeometries(geos), MAT);
  geos.forEach((g) => g.dispose());
  m.castShadow = m.receiveShadow = true;
  m.name = 'facades_neutres';
  return m;
}
