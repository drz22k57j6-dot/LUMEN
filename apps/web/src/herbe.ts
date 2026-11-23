// Herbe 3D (brins instanciés sur GPU), pensée pour l'iPhone.
// - Deux anneaux autour de la caméra : brins fins à 3 segments près, touffes larges plus loin ;
//   au-delà, la pelouse du sol urbain (sol3d.ts) prend le relais.
// - Où pousse l'herbe : masque mesuré (orthophoto IGN verte, hors bâtiments et voirie), 0,5 m.
// - Sur quoi : terrain nu IGN (MNT), lu dans le vertex shader.
// - Vent, couleur par touffe et par saison, occlusion au pied, transmission de la lumière à contre-jour.
// - Qualité automatique : si l'image ralentit, la densité baisse.
import * as THREE from 'three';

export interface ParamsHerbe {
  bbox: [number, number, number, number];
  /** Densité d'herbe 0..255, ligne 0 = nord, pas = res mètres. */
  masque: Uint8Array;
  nMasque: number;
  /** MNT (m NGF), ligne 0 = nord, nT × nT. */
  mnt: Float32Array;
  nT: number;
  /** Adresse (origine du repère de la scène) en Lambert-93 et altitude de référence. */
  origine: { x: number; y: number };
  alt0: number;
  mobile: boolean;
  /** Baisse automatique de densité si l'image ralentit (défaut : oui). */
  qualiteAuto?: boolean;
}

export interface Herbe {
  groupe: THREE.Group;
  maj(camera: THREE.Camera, t: number): void;
  soleil(dir: THREE.Vector3, couleur: THREE.Color, mois: number): void;
  liberer(): void;
}

/** Touffe de k brins effilés (seg segments) ; position = (largeur −0,5..0,5, hauteur 0..1, angle du brin). */
function touffe(k: number, seg: number): THREE.InstancedBufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  for (let b = 0; b < k; b++) {
    const a = (b / k) * Math.PI * 2 + b * 0.7, o = pos.length / 3;
    for (let i = 0; i < seg; i++) {
      const t = i / seg, l = 1 - t * t * 0.85;
      pos.push(-0.5 * l, t, a, 0.5 * l, t, a);
    }
    pos.push(0, 1, a);
    for (let i = 0; i < seg; i++) {
      const p = o + 2 * i;
      if (i === seg - 1) idx.push(p, p + 1, p + 2);
      else idx.push(p, p + 1, p + 3, p, p + 3, p + 2);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const VS_COMMUN = /* glsl */ `
uniform vec3 uCam; uniform float uTemps, uPas, uR0, uR1, uLarg, uHaut, uDensite;
uniform vec4 uBbox; uniform vec2 uOrig; uniform float uAlt0;
uniform sampler2D uMasque, uMnt; uniform float uNT;
attribute vec2 aCell;
varying float vT; varying vec3 vTeinte; varying vec3 vWp;
float hh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hh(i), hh(i + vec2(1, 0)), f.x), mix(hh(i + vec2(0, 1)), hh(i + vec2(1, 1)), f.x), f.y); }
float mnt(vec2 L){ // bilinéaire manuel (texture flottante non filtrable)
  vec2 g = vec2((L.x - uBbox.x) / (uBbox.z - uBbox.x), (uBbox.w - L.y) / (uBbox.w - uBbox.y)) * uNT - 0.5;
  ivec2 i = ivec2(floor(g)); vec2 f = fract(g); int m = int(uNT) - 1;
  float a = texelFetch(uMnt, clamp(i, ivec2(0), ivec2(m)), 0).r, b = texelFetch(uMnt, clamp(i + ivec2(1, 0), ivec2(0), ivec2(m)), 0).r;
  float c = texelFetch(uMnt, clamp(i + ivec2(0, 1), ivec2(0), ivec2(m)), 0).r, d = texelFetch(uMnt, clamp(i + ivec2(1, 1), ivec2(0), ivec2(m)), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

const VS_BRIN = /* glsl */ `
  // cellule fixe dans le monde (pas de glissement quand la caméra bouge)
  vec2 base = floor(uCam.xz / uPas) * uPas;
  vec2 cel = base + aCell * uPas;
  vec2 j = vec2(hh(cel), hh(cel + 17.3));
  vec2 p = cel + (j - 0.5) * uPas * 1.6;
  vec2 L = vec2(p.x + uOrig.x, -p.y + uOrig.y);
  vec2 uvM = vec2((L.x - uBbox.x) / (uBbox.z - uBbox.x), (uBbox.w - L.y) / (uBbox.w - uBbox.y));
  float dens = texture2D(uMasque, uvM).r * uDensite;
  float d = length(p - uCam.xz);
  // fondu en densité entre anneaux (pas de bande visible), léger rétrécissement au bord extérieur
  float sortie = 1.0 - smoothstep(uR1 * 0.75, uR1, d);
  float entree = uR0 > 0.0 ? smoothstep(uR0 * 0.75, uR0, d) : 1.0;
  float tire = hh(cel + 5.1);
  float garde = step(tire, dens * sortie * entree) * mix(0.5, 1.0, sortie);
  // touffes : hauteur et sécheresse varient par plaques de quelques mètres
  float plaque = vn(L * 0.35), fin = vn(L * 2.7);
  float bl = position.z;
  float H = uHaut * (0.55 + 0.6 * hh(cel + 9.7 + bl)) * (0.7 + 0.6 * plaque) * garde;
  float ang = hh(cel + 2.3) * 6.2832 + bl;
  p += vec2(cos(bl * 2.0), sin(bl * 2.0)) * uPas * 0.3; // brins écartés dans la touffe
  j = vec2(hh(cel + bl), hh(cel + bl + 7.7));
  vec2 dirL = vec2(cos(ang), sin(ang));
  float t = position.y;
  // vent : rafales qui traversent la pelouse + frémissement
  float raf = vn(L * 0.08 + vec2(uTemps * 0.35, uTemps * 0.12));
  vec2 vent = vec2(0.8, 0.35) * (0.25 + 0.9 * raf) + 0.15 * vec2(sin(uTemps * 2.7 + L.x * 1.3), cos(uTemps * 2.3 + L.y * 1.1));
  vec2 pli = (vent * 0.35 + (j - 0.5) * 0.7 + vec2(cos(ang), sin(ang)) * 0.25) * t * t;
  float sol = mnt(L) - uAlt0 + 0.035;
  vec3 pos = vec3(p.x + dirL.x * position.x * uLarg + pli.x * H, sol + t * H * (1.0 - 0.25 * dot(pli, pli)), p.y + dirL.y * position.x * uLarg + pli.y * H);
  // normale « adoucie » : moitié face du brin, moitié vers le ciel (rendu de pelouse dense)
  vec3 nb = normalize(vec3(-dirL.y, 0.0, dirL.x));
  vec3 nrm = normalize(mix(nb, vec3(0.0, 1.0, 0.0), 0.55));
  vT = t;
  vTeinte = vec3(plaque, fin, hh(cel + 4.4));
  vWp = pos;
`;

function materiau(geoNb: number, u: Record<string, THREE.IUniform>): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
  m.name = `herbe_${geoNb}`;
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u);
    s.vertexShader = VS_COMMUN + s.vertexShader
      .replace('#include <beginnormal_vertex>', VS_BRIN + '\nvec3 objectNormal = nrm;')
      .replace('#include <begin_vertex>', 'vec3 transformed = pos;');
    s.fragmentShader = s.fragmentShader
      // les deux faces du brin sont éclairées comme la face avant (sinon les dos sont noirs)
      .replace('#include <normal_fragment_begin>', 'float faceDirection = 1.0; vec3 normal = normalize(vNormal); vec3 nonPerturbedNormal = normal;')
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uSolDir, uSolCol, uVert, uSec; varying float vT; varying vec3 vTeinte; varying vec3 vWp;`,
      )
      .replace(
        '#include <map_fragment>',
        `vec3 col = mix(uVert * 0.45, uVert, smoothstep(0.0, 0.7, vT));
         col = mix(col, uSec, smoothstep(0.45, 0.85, vTeinte.x) * 0.55 * smoothstep(0.3, 1.0, vT));
         col *= 0.82 + 0.36 * vTeinte.z;
         col *= mix(0.5, 1.0, smoothstep(0.0, 0.45, vT)); // occlusion au pied de la touffe
         diffuseColor.rgb *= col;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         // transmission : le soleil traverse les brins vus à contre-jour
         vec3 V = normalize(vWp - cameraPosition);
         float tr = pow(max(dot(V, uSolDir), 0.0), 3.0) * smoothstep(0.2, 1.0, vT);
         totalEmissiveRadiance += col * uSolCol * tr * 0.6;`,
      );
  };
  m.customProgramCacheKey = () => m.name;
  return m;
}

/** Couleurs de pelouse parisienne par mois (vert tendre au printemps, jauni fin d'été, terne l'hiver). */
function teintes(mois: number): [THREE.Color, THREE.Color] {
  const vert = [0.07, 0.07, 0.085, 0.1, 0.11, 0.1, 0.09, 0.085, 0.09, 0.09, 0.08, 0.07][mois]!;
  const sec = mois >= 6 && mois <= 8 ? 0.8 : 0.4;
  // albédo d'une pelouse : ≈ 0,06–0,10 en R, 0,15–0,22 en V (linéaire)
  return [new THREE.Color(vert * 1.0, vert * 2.0, vert * 0.45), new THREE.Color(0.22 * sec + 0.08, 0.19 * sec + 0.08, 0.09)];
}

export function creerHerbe(P: ParamsHerbe): Herbe {
  const tm = new THREE.DataTexture(P.masque as Uint8Array<ArrayBuffer>, P.nMasque, P.nMasque, THREE.RedFormat, THREE.UnsignedByteType);
  tm.magFilter = tm.minFilter = THREE.LinearFilter;
  tm.flipY = false;
  tm.needsUpdate = true;
  const th = new THREE.DataTexture(P.mnt as Float32Array<ArrayBuffer>, P.nT, P.nT, THREE.RedFormat, THREE.FloatType);
  th.magFilter = th.minFilter = THREE.NearestFilter;
  th.needsUpdate = true;

  const [v0, s0] = teintes(new Date().getMonth());
  const commun = {
    uCam: { value: new THREE.Vector3() },
    uTemps: { value: 0 },
    uBbox: { value: new THREE.Vector4(...P.bbox) },
    uOrig: { value: new THREE.Vector2(P.origine.x, P.origine.y) },
    uAlt0: { value: P.alt0 },
    uMasque: { value: tm },
    uMnt: { value: th },
    uNT: { value: P.nT },
    uDensite: { value: 1 },
    uSolDir: { value: new THREE.Vector3(0, 1, 0) },
    uSolCol: { value: new THREE.Color(1, 1, 1) },
    uVert: { value: v0 },
    uSec: { value: s0 },
  };
  // budgets : iPhone ≈ 145 000 triangles d'herbe, ordinateur ≈ 450 000
  // touffes de 3 brins. iPhone ≈ 215 000 triangles (14 000 + 29 000 touffes), ordinateur ≈ 1,1 million
  const anneaux = P.mobile
    ? [
        { r0: 0, r1: 8, pas: 0.12, seg: 2, larg: 0.032, haut: 0.17 },
        { r0: 8, r1: 22, pas: 0.22, seg: 1, larg: 0.06, haut: 0.15 },
      ]
    : [
        { r0: 0, r1: 12, pas: 0.09, seg: 3, larg: 0.026, haut: 0.18 },
        { r0: 12, r1: 36, pas: 0.2, seg: 1, larg: 0.055, haut: 0.16 },
      ];
  const groupe = new THREE.Group();
  groupe.name = 'herbe';
  const mats: THREE.MeshStandardMaterial[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const totaux: number[] = [];
  let facteur = 1;
  anneaux.forEach((a, k) => {
    const g = touffe(3, a.seg);
    const n = Math.ceil(a.r1 / a.pas);
    const cel: number[] = [];
    for (let j = -n; j <= n; j++)
      for (let i = -n; i <= n; i++) {
        const d = Math.hypot(i, j) * a.pas;
        if (d <= a.r1 + a.pas && d >= a.r0 * 0.7 - a.pas) cel.push(i, j);
      }
    // ordre mélangé (déterministe) : réduire instanceCount éclaircit uniformément la pelouse
    const nb = cel.length / 2;
    for (let i = nb - 1; i > 0; i--) {
      const k = Math.floor(((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * (i + 1));
      [cel[2 * i], cel[2 * k]] = [cel[2 * k]!, cel[2 * i]!];
      [cel[2 * i + 1], cel[2 * k + 1]] = [cel[2 * k + 1]!, cel[2 * i + 1]!];
    }
    g.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(cel), 2));
    g.instanceCount = nb;
    totaux.push(nb);
    const u = { ...commun, uPas: { value: a.pas }, uR0: { value: a.r0 }, uR1: { value: a.r1 }, uLarg: { value: a.larg }, uHaut: { value: a.haut } };
    const m = materiau(k, u);
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    groupe.add(mesh);
    mats.push(m);
    geos.push(g);
  });

  // qualité automatique : sous ~25 i/s pendant 2 s, on retire un tiers des brins (jusqu'à 3 fois)
  let acc = 0, nb = 0, dernier = 0, baisses = 0;
  return {
    groupe,
    maj(camera, t) {
      commun.uCam.value.copy(camera.position);
      commun.uTemps.value = t / 1000;
      if (dernier && P.qualiteAuto !== false) {
        acc += t - dernier;
        nb++;
        if (acc > 2000) {
          if (acc / nb > 40 && baisses < 3) {
            // moins de touffes dessinées (vrai gain GPU), brins un peu plus larges pour garder la couverture
            facteur *= 0.66;
            baisses++;
            geos.forEach((g, i) => (g.instanceCount = Math.floor(totaux[i]! * facteur)));
            commun.uDensite.value = 1;
          }
          acc = nb = 0;
        }
      }
      dernier = t;
    },
    soleil(dir, couleur, mois) {
      commun.uSolDir.value.copy(dir).normalize();
      commun.uSolCol.value.copy(couleur);
      const [v, s] = teintes(mois);
      commun.uVert.value.copy(v);
      commun.uSec.value.copy(s);
    },
    liberer() {
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      tm.dispose();
      th.dispose();
    },
  };
}

/**
 * Masque de densité d'herbe (0,5 m) : verdure de l'orthophoto IGN, hors bâtiments et voirie.
 * Même critère que la pelouse du sol urbain, pour que brins et sol coïncident.
 */
export function masqueHerbe(
  ortho: ImageBitmap,
  bbox: [number, number, number, number],
  garder: (p: { x: number; y: number }) => boolean,
  res = 0.5,
): { masque: Uint8Array; n: number } {
  const n = Math.round((bbox[2] - bbox[0]) / res);
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(n, n) : Object.assign(document.createElement('canvas'), { width: n, height: n });
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.filter = 'blur(1.5px)'; // ≈ moyenne sur 1,5 m, comme le sol
  ctx.drawImage(ortho, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data;
  const masque = new Uint8Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 4, r = d[k]! / 255, g = d[k + 1]! / 255, b = d[k + 2]! / 255, s = r + g + b + 1e-3;
      const e = (2 * g - r - b) / s;
      const veg = Math.min(1, Math.max(0, (e - 0.015) / 0.045));
      if (veg <= 0) continue;
      if (!garder({ x: bbox[0] + (i + 0.5) * res, y: bbox[3] - (j + 0.5) * res })) continue;
      masque[j * n + i] = Math.round(veg * veg * (3 - 2 * veg) * 255);
    }
  // ouverture morphologique (rayon 1 m) : retire les taches isolées (reflets verdâtres sur les pavés)
  const R = 2, tmp = new Uint8Array(n * n), out = new Uint8Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let m = 255;
      for (let d = -R; d <= R && m; d++) m = Math.min(m, masque[j * n + Math.min(n - 1, Math.max(0, i + d))]!);
      tmp[j * n + i] = m;
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let m = 255;
      for (let d = -R; d <= R && m; d++) m = Math.min(m, tmp[Math.min(n - 1, Math.max(0, j + d)) * n + i]!);
      out[j * n + i] = m > 90 ? masque[j * n + i]! : 0;
    }
  return { masque: out, n };
}
