/**
 * Textures procédurales des façades (générées au démarrage, aucune image téléchargée, aucune licence).
 * Chaque texture couvre une tuile carrée de `metres` m ; les UV des façades sont en mètres.
 * Couleur claire (multipliée par la teinte du bâtiment) + carte de normales dérivée du relief des joints.
 */
import * as THREE from 'three';

export interface TexMur { map: THREE.Texture; normal: THREE.Texture; metres: number }

export function bruit(seed: number) {
  let x = seed >>> 0 || 1;
  return () => ((x = Math.imul(x ^ (x >>> 15), 2246822519) ^ Math.imul(x ^ (x >>> 13), 3266489917)), ((x >>> 0) % 100000) / 100000);
}

/** Construit couleur + normales à partir d'une fonction (px, py) → [gris 0–1, relief 0–1]. */
export function fabriquer(N: number, metres: number, f: (x: number, y: number) => [number, number] | [number, number, number, number], aniso: number, force = 2): TexMur {
  const col: Uint8Array<ArrayBuffer> = new Uint8Array(N * N * 4), haut = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const r = f(x, y), i = y * N + x;
      haut[i] = r[1];
      if (r.length === 4) (col[i * 4] = r[0] * 255), (col[i * 4 + 1] = r[2]! * 255), (col[i * 4 + 2] = r[3]! * 255);
      else col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = r[0] * 255;
      col[i * 4 + 3] = 255;
    }
  const nor: Uint8Array<ArrayBuffer> = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const h = (xx: number, yy: number) => haut[((yy + N) % N) * N + ((xx + N) % N)]!;
      const dx = (h(x + 1, y) - h(x - 1, y)) * force, dy = (h(x, y + 1) - h(x, y - 1)) * force;
      const l = Math.hypot(dx, dy, 1), i = (y * N + x) * 4;
      // ligne 0 des données = bas de la texture (flipY false) ; v croît vers le haut
      nor[i] = (-dx / l * 0.5 + 0.5) * 255;
      nor[i + 1] = (-dy / l * 0.5 + 0.5) * 255;
      nor[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      nor[i + 3] = 255;
    }
  const mk = (d: Uint8Array<ArrayBuffer>, srgb: boolean) => {
    const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = aniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.repeat.set(1 / metres, 1 / metres);
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(col, true), normal: mk(nor, false), metres };
}

export const lisse = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Pierre de taille : assises de 50 cm, blocs de ~1 m en quinconce, joints fins. Tuile 2 m. */
export function texPierre(aniso: number): TexMur {
  const N = 512, px = N / 2; // px par mètre
  const R = bruit(7), blocs = new Float32Array(64).map(() => R());
  return fabriquer(N, 2, (x, y) => {
    const v = y / px, u = x / px;
    const rang = Math.floor(v / 0.5), dec = rang % 2 ? 0.5 : 0;
    const ub = (u + dec) % 2, bloc = Math.floor(ub / 1.0);
    const jy = Math.min(v % 0.5, 0.5 - (v % 0.5)), jx = Math.min(ub % 1.0, 1.0 - (ub % 1.0));
    const joint = 1 - lisse(0.004, 0.012, Math.min(jy, jx));
    const t = blocs[(rang * 3 + bloc) % 64]!;
    const grain = (R() - 0.5) * 0.05;
    return [0.82 + t * 0.08 + grain - joint * 0.2, 1 - joint * 0.6 + grain * 0.2];
  }, aniso, 3);
}

/** Refends (rez-de-chaussée haussmannien) : bossages horizontaux profonds tous les 50 cm. */
export function texRefends(aniso: number): TexMur {
  const N = 512, px = N / 2;
  const R = bruit(11);
  return fabriquer(N, 2, (x, y) => {
    const v = (y / px) % 0.5;
    const d = Math.min(v, 0.5 - v);
    const sillon = 1 - lisse(0.012, 0.035, d);
    const grain = (R() - 0.5) * 0.04;
    void x;
    return [0.84 + grain - sillon * 0.35, 1 - sillon + grain * 0.2];
  }, aniso, 6);
}

/** Brique : 22 × 6,5 cm, joints clairs ; couleurs réelles (la teinte du bâtiment ne fait que nuancer). Tuile 0,9 m. */
export function texBrique(aniso: number): TexMur {
  const N = 512, m = 0.9, px = N / m;
  const R = bruit(5), var_ = new Float32Array(512).map(() => R());
  return fabriquer(N, m, (x, y) => {
    const v = y / px, u = x / px;
    const rang = Math.floor(v / 0.075), dec = rang % 2 ? 0.1125 : 0;
    const ub = (u + dec) % m, b = Math.floor(ub / 0.225);
    const jy = Math.min(v % 0.075, 0.075 - (v % 0.075)), jx = Math.min(ub % 0.225, 0.225 - (ub % 0.225));
    const joint = 1 - lisse(0.003, 0.007, Math.min(jy, jx));
    const t = var_[(rang * 7 + b) % 512]!;
    const g = (R() - 0.5) * 0.05;
    const br = [0.62 + t * 0.18 + g, 0.33 + t * 0.1 + g, 0.24 + t * 0.06 + g];
    const jo = [0.8, 0.77, 0.72];
    return [br[0]! * (1 - joint) + jo[0]! * joint, 1 - joint * 0.7, br[1]! * (1 - joint) + jo[1]! * joint, br[2]! * (1 - joint) + jo[2]! * joint];
  }, aniso, 4);
}

/** Enduit : grain fin et légères taches. Tuile 2 m. */
export function texEnduit(aniso: number): TexMur {
  const N = 256, px = N / 2;
  const R = bruit(3), tache = new Float32Array(16 * 16).map(() => R());
  return fabriquer(N, 2, (x, y) => {
    const t = tache[Math.floor(y / 16) * 16 + Math.floor(x / 16)]!;
    const g = (R() - 0.5) * 0.08;
    void px;
    return [0.94 + t * 0.05 + g * 0.5, 0.5 + g];
  }, aniso, 1.5);
}

/** Béton préfabriqué : panneaux de 3 × 2,65 m (joints), grain. Tuile 6 m. */
export function texBeton(aniso: number): TexMur {
  const N = 512, m = 6, px = N / m;
  const R = bruit(9);
  return fabriquer(N, m, (x, y) => {
    const u = x / px, v = y / px;
    const ju = Math.min(u % 3, 3 - (u % 3)), jv = Math.min(v % 3, 3 - (v % 3));
    const joint = 1 - lisse(0.008, 0.02, Math.min(ju, jv));
    const g = (R() - 0.5) * 0.07;
    return [0.92 + g - joint * 0.2, 1 - joint * 0.8 + g * 0.3];
  }, aniso, 3);
}

/** Ferronnerie parisienne (garde-corps) : lisses haute/basse, barreaux, frise d'anneaux. Tuile 1 m × 1 m, alpha. */
export function texFer(aniso: number): THREE.Texture {
  const W = 256, H = 256;
  const d = new Uint8Array(W * H * 4);
  const plein = (x: number, y: number) => {
    const u = x / W, v = y / H; // v = 0 en bas
    if (v < 0.05 || v > 0.93 || (v > 0.16 && v < 0.19) || (v > 0.8 && v < 0.83)) return true; // lisses
    const cu = (u * 8) % 1; // 8 motifs par mètre
    if (v > 0.19 && v < 0.8) {
      if (Math.abs(cu - 0.5) < 0.025) return true; // barreau
      // anneaux (cercles) entre les barreaux, haut et bas
      for (const cy of [0.31, 0.68]) {
        const r = Math.hypot((cu - 0.0) * 0.125, (v - cy) * 1), r2 = Math.hypot((cu - 1.0) * 0.125, (v - cy) * 1);
        if (Math.abs(r - 0.055) < 0.008 || Math.abs(r2 - 0.055) < 0.008) return true;
      }
      if (Math.abs(v - 0.495) < 0.012) return true; // traverse médiane
    }
    if (v >= 0.05 && v <= 0.16 && Math.abs(((u * 16) % 1) - 0.5) < 0.05) return true; // frise basse
    return false;
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, p = plein(x, y);
      d[i] = d[i + 1] = d[i + 2] = 40;
      d[i + 3] = p ? 255 : 0;
    }
  const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
