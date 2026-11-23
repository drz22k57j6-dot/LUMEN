// Arbres d'alignement reconstruits depuis le LiDAR HD (classe végétation) :
// position = sommet local du houppier, hauteur = MNS − MNT mesurés, largeur = étendue du houppier.
// Seule la forme (tronc, houppier) est générée ; le feuillage suit la saison (platanes, tilleuls : caducs).
import * as THREE from 'three';
import type { XY } from '@lumen/core';

export interface ArbreLidar {
  p: XY;
  /** Hauteur totale (m), mesurée. */
  h: number;
  /** Rayon du houppier (m), mesuré. */
  r: number;
}

export interface GrilleVeg {
  n: number;
  bbox: [number, number, number, number];
  hauteurs: Float32Array;
  classes: Uint8Array;
}

/** Sommets de houppiers (végétation ≥ 4 m au-dessus du sol) dans la zone voulue. */
export function arbresLidar(g: GrilleVeg, sol: (p: XY) => number, garder: (p: XY) => boolean): ArbreLidar[] {
  const { n, bbox, hauteurs, classes } = g;
  const pas = (bbox[2] - bbox[0]) / n;
  const pt = (i: number): XY => ({ x: bbox[0] + ((i % n) + 0.5) * pas, y: bbox[3] - (Math.floor(i / n) + 0.5) * pas });
  const hs = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) hs[i] = classes[i] === 2 ? hauteurs[i]! - sol(pt(i)) : 0;
  const R = Math.max(1, Math.round(3 / pas)); // un sommet par 3 m au plus
  const out: ArbreLidar[] = [];
  for (let j = R; j < n - R; j++)
    for (let i = R; i < n - R; i++) {
      const k = j * n + i, h = hs[k]!;
      if (h < 4 || h > 40) continue;
      let max = true;
      for (let dj = -R; dj <= R && max; dj++) for (let di = -R; di <= R; di++) if (hs[k + dj * n + di]! > h) { max = false; break; }
      if (!max) continue;
      const p = pt(k);
      if (!garder(p)) continue;
      // rayon : distance moyenne où la canopée descend sous 55 % de la hauteur, sur 8 directions
      let somme = 0;
      for (let a = 0; a < 8; a++) {
        const dx = Math.cos((a * Math.PI) / 4), dy = Math.sin((a * Math.PI) / 4);
        let d = pas;
        for (; d < 9; d += pas) {
          const ii = Math.round(i + (dx * d) / pas), jj = Math.round(j - (dy * d) / pas);
          if (ii < 0 || jj < 0 || ii >= n || jj >= n || hs[jj * n + ii]! < 0.55 * h) break;
        }
        somme += d;
      }
      out.push({ p, h, r: Math.max(1.5, Math.min(8, somme / 8)) });
    }
  return out;
}

/** Couleur et densité du feuillage selon le mois (arbres caducs parisiens). */
function saison(mois: number): { couleur: THREE.Color; densite: number } {
  if (mois >= 4 && mois <= 8) return { couleur: new THREE.Color(0.11, 0.2, 0.06), densite: 1 };
  if (mois === 3) return { couleur: new THREE.Color(0.2, 0.3, 0.08), densite: 0.6 };
  if (mois === 9) return { couleur: new THREE.Color(0.25, 0.22, 0.07), densite: 0.9 };
  if (mois === 10) return { couleur: new THREE.Color(0.35, 0.18, 0.05), densite: 0.45 };
  return { couleur: new THREE.Color(0.12, 0.1, 0.08), densite: 0.18 }; // hiver : ramure nue
}

/** Maillage instancié des arbres (2 appels de dessin). */
export function creerArbres(arbres: ArbreLidar[], vers3: (p: XY, dz: number) => THREE.Vector3, mois: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'arbres';
  if (!arbres.length) return g;
  const tronc = new THREE.CylinderGeometry(0.14, 0.22, 1, 7, 1);
  tronc.translate(0, 0.5, 0);
  const houppier = new THREE.IcosahedronGeometry(1, 2);
  const pos = houppier.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    const b = 1 + 0.16 * Math.sin(v.x * 7.1 + v.y * 3.3) * Math.cos(v.z * 5.7 - v.y * 2.1);
    pos.setXYZ(i, v.x * b, v.y * b, v.z * b);
  }
  houppier.computeVertexNormals();
  const { couleur, densite } = saison(mois);
  const matT = new THREE.MeshStandardMaterial({ color: 0x5b5246, roughness: 0.95 });
  // feuillage ajouré par tramage (alphaHash) : pas d'effet « bulle de verre », ombres partielles correctes
  const matH = new THREE.MeshStandardMaterial({ color: couleur, roughness: 0.9, alphaHash: densite < 1, opacity: 0.25 + 0.75 * densite });
  const T = new THREE.InstancedMesh(tronc, matT, arbres.length), H = new THREE.InstancedMesh(houppier, matH, arbres.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  arbres.forEach((a, i) => {
    const base = vers3(a.p, 0);
    const fut = Math.max(2.2, a.h * 0.38), haut = (a.h - fut) / 2;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (a.p.x * 12.9898 + a.p.y * 78.233) % 6.283);
    T.setMatrixAt(i, m.compose(base, q, s.set(1 + a.h / 40, fut + haut * 0.6, 1 + a.h / 40)));
    H.setMatrixAt(i, m.compose(base.clone().setY(base.y + fut + haut), q, s.set(a.r, Math.max(haut, a.r * 0.7), a.r)));
  });
  for (const o of [T, H]) (o.castShadow = o.receiveShadow = true), g.add(o);
  return g;
}

/** Met à jour le feuillage quand la date change. */
export function majSaison(g: THREE.Group, mois: number) {
  const H = g.children[1] as THREE.InstancedMesh | undefined;
  if (!H) return;
  const { couleur, densite } = saison(mois);
  const m = H.material as THREE.MeshStandardMaterial;
  m.color.copy(couleur);
  m.opacity = 0.25 + 0.75 * densite;
  m.alphaHash = densite < 1;
  m.needsUpdate = true;
}
