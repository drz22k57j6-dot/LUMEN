// Rendu 3D de la voirie (packages/urban/voirie.ts) : chaussée, trottoirs, bordures de granit,
// caniveaux pavés, marquages, avaloirs et regards. Matières entièrement calculées (aucune photo).
import * as THREE from 'three';
import type { XY } from '@lumen/core';
import type { Poly, Quad, Voirie } from '@lumen/urban';
import { COTES } from '@lumen/urban';

/** Position 3D (repère local) d'un point Lambert-93 à dz mètres au-dessus du terrain. */
export type Vers3 = (p: XY, dz: number) => THREE.Vector3;

const H = { chaussee: 0.06, marquage: 0.075, caniveau: 0.068, trottoir: 0.06 + COTES.bordure.hauteur };

// ---------------------------------------------------------------------------
// Bruit périodique partagé (R grain fin, G moyen, B taches, A gravillons)
// ---------------------------------------------------------------------------
function texBruit(): THREE.DataTexture {
  const N = 256, d = new Uint8Array(N * N * 4);
  const rnd = (x: number, y: number, s: number) => {
    let h = (x * 73856093) ^ (y * 19349663) ^ (s * 83492791);
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const lisse = (t: number) => t * t * (3 - 2 * t);
  const bruit = (u: number, v: number, P: number, s: number) => {
    const x = u * P, y = v * P, x0 = Math.floor(x), y0 = Math.floor(y), fx = lisse(x - x0), fy = lisse(y - y0);
    const g = (a: number, b: number) => rnd(((a % P) + P) % P, ((b % P) + P) % P, s);
    return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
  };
  const oct = (u: number, v: number, P: number, s: number, n: number) => {
    let t = 0, a = 1, w = 0;
    for (let o = 0; o < n; o++) (t += a * bruit(u, v, P << o, s + o)), (w += a), (a *= 0.5);
    return t / w;
  };
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N, i = 4 * (y * N + x);
      d[i] = oct(u, v, 32, 1, 3) * 255;
      d[i + 1] = oct(u, v, 4, 9, 4) * 255;
      d[i + 2] = oct(u, v, 2, 17, 3) * 255;
      d[i + 3] = (rnd(x, y, 5) > 0.9 ? 0.7 + 0.3 * rnd(x, y, 6) : 0.25 * rnd(x, y, 7)) * 255;
    }
  const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------
// Matières (MeshStandardMaterial + shader procédural en coordonnées monde)
// ---------------------------------------------------------------------------
const GLSL_COMMUN = `
uniform sampler2D uBruit;
varying vec3 vWp; varying vec2 vSt;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;

const CORPS: Record<string, string> = {
  // Enrobé parisien (BBSG 0/10) : gris moyen-foncé, gravillons clairs saillants, liant noir dans les creux,
  // reprises rectangulaires, fissures, taches d'huile, bandes de roulement polies, salissure en pied de bordure.
  chaussee: `
    vec2 w = vWp.xz; float dist = length(cameraPosition - vWp);
    vec4 g1 = texture2D(uBruit, w * 2.3), g2 = texture2D(uBruit, w * 0.37 + 0.2), b = texture2D(uBruit, w * 0.045 + 0.3), c = texture2D(uBruit, w * 0.011 + 0.7);
    float grav = smoothstep(0.55, 0.95, g1.a);
    col = mix(vec3(0.045, 0.046, 0.05), vec3(0.16, 0.155, 0.15), 0.35 + 0.4 * g1.r) ;
    col = mix(col, vec3(0.22, 0.21, 0.2), grav * 0.6);
    col *= 0.85 + 0.3 * b.g;
    vec2 cel = floor(w / vec2(2.6, 6.5)); float rep = step(0.93, h21(cel)) * step(0.4, c.b);
    col *= mix(1.0, 0.62 + 0.55 * h21(cel + 3.1), rep);
    float fis = 1.0 - smoothstep(0.0, 0.008, abs(b.r - 0.5)); col *= 1.0 - 0.55 * fis * smoothstep(0.55, 0.72, c.g);
    float huile = smoothstep(0.72, 0.88, b.b); col *= 1.0 - 0.35 * huile;
    hBump = (g1.a * 0.006 + g1.r * 0.002 + g2.g * 0.003 - fis * 0.004) * (1.0 - smoothstep(20.0, 60.0, dist));
    rough = clamp(0.92 - 0.35 * huile - 0.12 * grav, 0.4, 1.0);`,
  // Asphalte coulé des trottoirs parisiens : gris anthracite chaud, grain fin, chewing-gums, coulures.
  trottoir: `
    vec2 w = vWp.xz; float dist = length(cameraPosition - vWp);
    vec4 a = texture2D(uBruit, w * 3.1), b = texture2D(uBruit, w * 0.07 + 0.5), c = texture2D(uBruit, w * 0.4 + 0.2);
    col = vec3(0.075, 0.07, 0.066) * (0.85 + 0.3 * a.r) * (0.85 + 0.3 * b.g);
    float gomme = smoothstep(0.93, 0.965, c.a); col = mix(col, vec3(0.03, 0.03, 0.032), gomme * 0.8);
    col = mix(col, col * vec3(1.25, 1.2, 1.12), smoothstep(0.6, 0.85, b.b) * 0.5);
    hBump = (a.r * 0.0015 + a.a * 0.001 + gomme * 0.001) * (1.0 - smoothstep(15.0, 50.0, dist));
    rough = 0.78 + 0.12 * a.r - 0.1 * gomme;`,
  // Bordure granit gris (type T2, 14 cm vus) : grains noirs et blancs, blocs de 0,95 m, joints, salissure basse.
  bordure: `
    vec2 w = vWp.xz;
    float id = floor(vSt.x / 0.95); float j = fract(vSt.x / 0.95);
    float joint = smoothstep(0.988, 1.0, j) + 1.0 - smoothstep(0.0, 0.01, j);
    vec4 g = texture2D(uBruit, w * 9.0 + vWp.y * 4.0), b = texture2D(uBruit, w * 0.2);
    col = vec3(0.36, 0.355, 0.34) * (0.88 + 0.22 * h21(vec2(id, 1.0)));
    col *= 0.78 + 0.4 * g.r; col = mix(col, vec3(0.06), smoothstep(0.8, 0.95, g.a) * 0.85);
    col = mix(col, vec3(0.6), smoothstep(0.9, 1.0, g.g) * 0.4);
    col *= 1.0 - 0.6 * joint; col *= 0.8 + 0.25 * b.g;
    col *= mix(0.6, 1.0, smoothstep(0.0, 1.0, vSt.y)); // salissure au pied (face vue)
    hBump = g.r * 0.0015 - joint * 0.004;
    rough = 0.6 + 0.25 * g.r;`,
  // Caniveau : 2 rangs de pavés de granit 14 × 20 cm, joints creux, humidité et dépôts côté bordure.
  caniveau: `
    float r = floor(vSt.y / 0.175); vec2 q = vec2(vSt.x / 0.2 + 0.5 * r, vSt.y / 0.175);
    vec2 f = fract(q), i = floor(q);
    float bord = min(min(f.x, 1.0 - f.x) * 0.2, min(f.y, 1.0 - f.y) * 0.175);
    float joint = 1.0 - smoothstep(0.004, 0.012, bord);
    vec4 g = texture2D(uBruit, vWp.xz * 6.0);
    col = vec3(0.21, 0.205, 0.2) * (0.7 + 0.5 * h21(i)) * (0.8 + 0.35 * g.r);
    col = mix(col, vec3(0.03, 0.03, 0.032), joint * 0.9);
    float humide = 1.0 - smoothstep(0.0, 0.12, vSt.y);
    col *= mix(1.0, 0.55, humide);
    hBump = smoothstep(0.0, 0.02, bord) * 0.01 + g.r * 0.002;
    rough = mix(0.82, 0.25, humide) - 0.15 * joint;`,
  // Peinture routière (résine blanche) : légèrement en relief, salie, usée par plaques et dans les traces.
  marquage: `
    vec4 a = texture2D(uBruit, vWp.xz * 1.7), b = texture2D(uBruit, vWp.xz * 0.15 + 0.4), c = texture2D(uBruit, vWp.xz * 6.0);
    float usure = a.g * 0.55 + a.r * 0.35 + (b.b - 0.5) * 0.5 + c.a * 0.25;
    if (usure > 0.74) discard;
    col = vec3(0.62, 0.62, 0.58) * (0.78 + 0.25 * b.g) * (0.88 + 0.12 * a.r) * mix(1.0, 0.55, smoothstep(0.6, 0.74, usure));
    hBump = 0.002 + c.r * 0.001;
    rough = 0.6 + 0.25 * a.r;`,
  // Fonte (avaloirs, regards) : grille ou motif quadrillé, rouille dans les creux.
  fonte: `
    vec4 a = texture2D(uBruit, vWp.xz * 3.0);
    float g = step(0.5, fract(vSt.x * 6.0)) * step(0.15, vSt.y) * step(vSt.y, 0.85);
    vec2 dam = step(0.5, fract(vSt * 14.0)); float motif = abs(dam.x - dam.y);
    col = vec3(0.05, 0.047, 0.044) * (0.8 + 0.4 * a.r) * mix(1.0, 0.2, g) * mix(1.0, 0.75, motif);
    col = mix(col, vec3(0.12, 0.06, 0.03), smoothstep(0.7, 0.9, a.b) * 0.5);
    hBump = motif * 0.003 - g * 0.01;
    rough = 0.45 + 0.35 * a.r;`,
  // Allées stabilisées (sable de parc, gravillons).
  allee: `
    vec4 a = texture2D(uBruit, vWp.xz * 2.2), b = texture2D(uBruit, vWp.xz * 0.08 + 0.1);
    col = vec3(0.42, 0.37, 0.28) * (0.82 + 0.3 * a.r) * (0.88 + 0.22 * b.g);
    col = mix(col, col * 0.6, smoothstep(0.8, 0.95, a.a));
    hBump = a.a * 0.004 + a.r * 0.002;
    rough = 0.95;`,
};

function materiau(nom: string, bruit: THREE.Texture, decalage: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: nom === 'fonte' ? 0.45 : 0 });
  m.name = `voirie_${nom}`;
  if (decalage) Object.assign(m, { polygonOffset: true, polygonOffsetFactor: -decalage, polygonOffsetUnits: -decalage * 2 });
  m.onBeforeCompile = (s) => {
    s.uniforms.uBruit = { value: bruit };
    s.vertexShader =
      'attribute vec2 aSt;\nvarying vec3 vWp; varying vec2 vSt;\n' +
      s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz; vSt = aSt;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_COMMUN)
      .replace('#include <map_fragment>', `vec3 col; float rough; float hBump = 0.0;\n{${CORPS[nom]}}\ndiffuseColor.rgb *= col;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rough;')
      // relief de surface (gravillons, joints, grain) : perturbation de normale par dérivées d'écran
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        { vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition), vN = normal;
          vec3 R1 = cross(sy, vN), R2 = cross(vN, sx); float det = dot(sx, R1);
          vec2 dH = vec2(dFdx(hBump), dFdy(hBump)) * 2.5;
          normal = normalize(abs(det) * vN - sign(det) * (dH.x * R1 + dH.y * R2)); }`,
      );
  };
  m.customProgramCacheKey = () => m.name;
  return m;
}

// ---------------------------------------------------------------------------
// Géométrie
// ---------------------------------------------------------------------------
class Tampon {
  pos: number[] = [];
  st: number[] = [];
  idx: number[] = [];
  sommet(v: THREE.Vector3, s = 0, t = 0): number {
    this.pos.push(v.x, v.y, v.z);
    this.st.push(s, t);
    return this.pos.length / 3 - 1;
  }
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }
  geometrie(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aSt', new THREE.Float32BufferAttribute(this.st, 2));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeVertexNormals();
    // les surfaces horizontales regardent toujours vers le haut
    const n = g.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < n.count; i++) if (n.getY(i) < -0.5) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
    g.computeBoundingSphere();
    return g;
  }
}

/** Triangule un polygone à trous puis subdivise (arêtes ≤ pas) pour épouser le relief. */
function surface(T: Tampon, poly: Poly, dz: number, vers3: Vers3, pas: number) {
  const v2 = (r: XY[]) => r.map((p) => new THREE.Vector2(p.x, p.y));
  const contour = v2(poly[0]!), trous = poly.slice(1).map(v2);
  if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
  for (const t of trous) if (!THREE.ShapeUtils.isClockWise(t)) t.reverse();
  const tous = [contour, ...trous].flat();
  const cache = new Map<string, number>();
  const id = (p: THREE.Vector2) => {
    const k = `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
    let i = cache.get(k);
    if (i === undefined) cache.set(k, (i = T.sommet(vers3({ x: p.x, y: p.y }, dz))));
    return i;
  };
  const tri = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, prof: number) => {
    const ab = a.distanceTo(b), bc = b.distanceTo(c), ca = c.distanceTo(a), m = Math.max(ab, bc, ca);
    if (m <= pas || prof > 12) return void T.idx.push(id(a), id(b), id(c));
    if (m === ab) {
      const k = a.clone().lerp(b, 0.5);
      tri(a, k, c, prof + 1), tri(k, b, c, prof + 1);
    } else if (m === bc) {
      const k = b.clone().lerp(c, 0.5);
      tri(a, b, k, prof + 1), tri(a, k, c, prof + 1);
    } else {
      const k = c.clone().lerp(a, 0.5);
      tri(a, b, k, prof + 1), tri(k, b, c, prof + 1);
    }
  };
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, trous)) tri(tous[a!]!, tous[b!]!, tous[c!]!, 0);
}

/** Décalage latéral d'une polyligne (positif = à droite). */
function decaler(pts: XY[], d: number): XY[] {
  return pts.map((p, k) => {
    const a = pts[Math.max(0, k - 1)]!, b = pts[Math.min(pts.length - 1, k + 1)]!;
    const tx = b.x - a.x, ty = b.y - a.y, l = Math.hypot(tx, ty) || 1;
    return { x: p.x + (ty / l) * d, y: p.y - (tx / l) * d };
  });
}

/** Bordure de granit (face vue, chanfrein, dessus) et caniveau pavé côté chaussée. */
function bordure(B: Tampon, C: Tampon, pts: XY[], ferme: boolean, vers3: Vers3) {
  const P = ferme ? [...pts, pts[0]!] : pts;
  const { hauteur: h, largeur: w } = COTES.bordure;
  const p1 = decaler(P, 0.025), p2 = decaler(P, w), cv = decaler(P, -COTES.caniveau);
  let s = 0;
  let prev: number[] | null = null;
  for (let k = 0; k < P.length; k++) {
    if (k) s += Math.hypot(P[k]!.x - P[k - 1]!.x, P[k]!.y - P[k - 1]!.y);
    const ids = [
      B.sommet(vers3(P[k]!, H.chaussee), s, 0),
      B.sommet(vers3(P[k]!, H.chaussee + h - 0.025), s, 1),
      B.sommet(vers3(p1[k]!, H.chaussee + h + 0.006), s, 2),
      B.sommet(vers3(p2[k]!, H.chaussee + h + 0.006), s, 3),
      C.sommet(vers3(cv[k]!, H.caniveau), s, COTES.caniveau),
      C.sommet(vers3(P[k]!, H.caniveau), s, 0),
    ];
    if (prev) {
      B.quad(prev[0]!, ids[0]!, ids[1]!, prev[1]!);
      B.quad(prev[1]!, ids[1]!, ids[2]!, prev[2]!);
      B.quad(prev[2]!, ids[2]!, ids[3]!, prev[3]!);
      C.quad(prev[4]!, ids[4]!, ids[5]!, prev[5]!);
    }
    prev = ids;
  }
}

function quads(T: Tampon, qs: Quad[], dz: number, vers3: Vers3) {
  for (const q of qs) {
    const i = q.map((p, k) => T.sommet(vers3(p, dz), k & 1, k >> 1));
    T.quad(i[0]!, i[1]!, i[2]!, i[3]!);
  }
}

/** Petite plaque rectangulaire ou disque de fonte posé sur la chaussée. */
function plaque(T: Tampon, c: XY, dir: XY, lx: number, ly: number, dz: number, vers3: Vers3, rond = false) {
  if (rond) {
    const centre = T.sommet(vers3(c, dz), 0.5, 0.5), n = 14, ids: number[] = [];
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2;
      ids.push(T.sommet(vers3({ x: c.x + Math.cos(a) * lx, y: c.y + Math.sin(a) * lx }, dz), 0.5 + Math.cos(a) / 2, 0.5 + Math.sin(a) / 2));
    }
    for (let j = 0; j < n; j++) T.idx.push(centre, ids[j]!, ids[(j + 1) % n]!);
    return;
  }
  const nx = dir.y, ny = -dir.x; // vers la chaussée : à gauche de la bordure
  const p = (u: number, v: number): XY => ({ x: c.x + dir.x * u - nx * v, y: c.y + dir.y * u - ny * v });
  const i = [
    T.sommet(vers3(p(-lx / 2, 0.02), dz), 0, 0),
    T.sommet(vers3(p(lx / 2, 0.02), dz), 1, 0),
    T.sommet(vers3(p(lx / 2, 0.02 + ly), dz), 1, 1),
    T.sommet(vers3(p(-lx / 2, 0.02 + ly), dz), 0, 1),
  ];
  T.quad(i[0]!, i[1]!, i[2]!, i[3]!);
}

/** Construit tous les maillages de la voirie (une matière = un appel de dessin). */
export function creerVoirie3D(v: Voirie, vers3: Vers3, mobile: boolean): THREE.Group {
  const bruit = texBruit();
  if (mobile) bruit.anisotropy = 4;
  const T: Record<string, Tampon> = {};
  const t = (n: string) => (T[n] ??= new Tampon());
  const pas = mobile ? 4 : 3;
  for (const p of v.chaussee) surface(t('chaussee'), p, H.chaussee, vers3, pas);
  for (const p of v.trottoirs) surface(t('trottoir'), p, H.trottoir, vers3, pas);
  for (const p of v.allees) surface(t('allee'), p, H.chaussee - 0.02, vers3, pas);
  // flancs des trottoirs là où il n'y a pas de bordure (bord de place, de parc)
  for (const p of v.trottoirs)
    for (const r0 of p) {
      const T2 = t('trottoir'), r = decaler([...r0, r0[0]!], -0.03).slice(0, -1); // en retrait derrière la bordure
      for (let i = 0; i < r.length; i++) {
        const a = r[i]!, b = r[(i + 1) % r.length]!;
        const ids = [T2.sommet(vers3(a, 0)), T2.sommet(vers3(b, 0)), T2.sommet(vers3(b, H.trottoir)), T2.sommet(vers3(a, H.trottoir))];
        T2.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!);
      }
    }
  for (const b of v.bordures) bordure(t('bordure'), t('caniveau'), b.pts, b.ferme, vers3);
  quads(t('marquage'), [...v.marquages, ...v.passages], H.marquage, vers3);
  for (const a of v.avaloirs) plaque(t('fonte'), a.p, a.dir, 0.9, 0.3, H.caniveau + 0.004, vers3);
  for (const r of v.regards) plaque(t('fonte'), r, { x: 1, y: 0 }, 0.31, 0, H.marquage, vers3, true);

  const g = new THREE.Group();
  g.name = 'voirie';
  const ordre: [string, number][] = [['allee', 1], ['chaussee', 1], ['trottoir', 1], ['caniveau', 2], ['bordure', 0], ['marquage', 3], ['fonte', 4]];
  for (const [nom, dec] of ordre) {
    const geo = T[nom]?.geometrie();
    if (!geo) continue;
    const m = new THREE.Mesh(geo, materiau(nom, bruit, dec));
    m.name = `voirie_${nom}`;
    m.receiveShadow = true;
    m.castShadow = nom === 'bordure';
    g.add(m);
  }
  return g;
}

/** Libère les ressources GPU d'un groupe de voirie. */
export function libererVoirie(g: THREE.Group) {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.MeshStandardMaterial).dispose();
    }
  });
}

/**
 * Masque de la voirie (chaussée, trottoirs, allées) rastérisé à 0,5 m, élargi de 0,5 m.
 * Sert à passer le relief LiDAR (MNS : voitures, mobilier, feuillage bas) sous la chaussée.
 */
export function masqueVoirie(v: Voirie, bbox: [number, number, number, number], res = 0.5, chausseeSeule = false): (p: XY) => boolean {
  const w = Math.ceil((bbox[2] - bbox[0]) / res), h = Math.ceil((bbox[3] - bbox[1]) / res);
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  ctx.lineWidth = chausseeSeule ? 0.6 : 2; // 1 m de marge (0,5 m de chaque côté) ; 15 cm pour la chaussée seule
  for (const poly of chausseeSeule ? v.chaussee : [...v.chaussee, ...v.trottoirs, ...v.allees]) {
    ctx.beginPath();
    for (const r of poly)
      r.forEach((p, i) => {
        const x = (p.x - bbox[0]) / res, y = (bbox[3] - p.y) / res;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.stroke();
  }
  const d = ctx.getImageData(0, 0, w, h).data;
  return (p) => {
    const i = Math.floor((p.x - bbox[0]) / res), j = Math.floor((bbox[3] - p.y) / res);
    return i >= 0 && j >= 0 && i < w && j < h && d[(j * w + i) * 4]! > 0;
  };
}
