// Sol urbain hors bâtiments et hors voirie (places, cours, squares, parcs).
// Forme : terrain nu IGN (MNT RGE ALTI), sans les objets du LiDAR. Matière : déduite de l'orthophoto IGN
// à chaque point (végétation → pelouse, teinte sable claire → allée stabilisée, sinon pavés de granit).
// La nature du sol est donc mesurée (photo) ; seul le motif (pavé, brin d'herbe) est généré.
import * as THREE from 'three';
import type { XY } from '@lumen/core';

export interface ParamsSol {
  bbox: [number, number, number, number];
  centre: XY;
  /** Faut-il un sol ici ? (ni bâtiment, ni voirie) */
  garder: (p: XY) => boolean;
  /** Position 3D à dz mètres au-dessus du terrain nu (MNT). */
  vers3: (p: XY, dz: number) => THREE.Vector3;
  mobile: boolean;
}

const uOrtho = { value: null as THREE.Texture | null };
const uBbox = { value: new THREE.Vector4() };

/** Branche l'orthophoto IGN (texture couvrant bbox) sur le sol urbain. */
export function orthoSol(t: THREE.Texture | null) {
  uOrtho.value = t;
}

function materiau(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  m.name = 'sol_urbain';
  m.onBeforeCompile = (s) => {
    s.uniforms.uOrtho = uOrtho;
    s.uniforms.uBbox = uBbox;
    s.vertexShader = 'varying vec3 vWp;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uOrtho; uniform vec4 uBbox; varying vec3 vWp;
        float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }`,
      )
      .replace(
        '#include <map_fragment>',
        `vec3 col; float rough; float hB = 0.0;
        {
          // nature du sol lue sur l'orthophoto (moyenne de 5 échantillons, ~1,5 m)
          vec2 uv = vec2((vWp.x - uBbox.x) / uBbox.z, (vWp.z - uBbox.y) / uBbox.w);
          vec3 o = vec3(0.0); float e = 1.5 / uBbox.z;
          o += texture2D(uOrtho, uv).rgb; o += texture2D(uOrtho, uv + vec2(e, 0)).rgb; o += texture2D(uOrtho, uv - vec2(e, 0)).rgb;
          o += texture2D(uOrtho, uv + vec2(0, e)).rgb; o += texture2D(uOrtho, uv - vec2(0, e)).rgb; o /= 5.0;
          o = pow(o, vec3(1.0 / 2.2));
          float s = o.r + o.g + o.b + 1e-3;
          float veg = smoothstep(0.015, 0.06, (2.0 * o.g - o.r - o.b) / s);
          // contexte ~10 m (niveau de mipmap 5) : sol clair entouré de végétation = allée de parc
          vec3 oc = pow(texture2D(uOrtho, uv, 5.0).rgb, vec3(1.0 / 2.2)); float sc = oc.r + oc.g + oc.b + 1e-3;
          float ctx = smoothstep(0.015, 0.06, (2.0 * oc.g - oc.r - oc.b) / sc);
          float lum = s / 3.0;
          float sable = (1.0 - veg) * max(smoothstep(0.03, 0.07, (o.r - o.b) / s) * smoothstep(0.25, 0.35, lum),
                                          smoothstep(0.3, 0.55, ctx) * smoothstep(0.3, 0.45, lum));
          vec2 w = vWp.xz; float dist = length(cameraPosition - vWp);
          // pavés de granit 14 × 20 cm, à joints décalés
          float rg = floor(w.y / 0.15); vec2 q = vec2(w.x / 0.21 + 0.5 * rg, w.y / 0.15);
          vec2 f = fract(q), id = floor(q);
          float b = min(min(f.x, 1.0 - f.x) * 0.21, min(f.y, 1.0 - f.y) * 0.15);
          // anticrénelage : au loin, joints et contrastes des pavés se fondent en teinte moyenne (pas de moiré)
          float flou = smoothstep(0.12, 0.45, max(fwidth(q.x), fwidth(q.y)));
          float joint = (1.0 - smoothstep(0.004, 0.014, b)) * (1.0 - flou) + 0.16 * flou;
          vec3 pave = vec3(0.17, 0.165, 0.16) * mix(0.65 + 0.6 * h21(id), 0.95, flou) * (0.85 + 0.3 * vn(w * 9.0));
          pave = mix(pave, vec3(0.05, 0.048, 0.045), joint * 0.85) * (0.85 + 0.3 * vn(w * 0.3));
          // pelouse : touffes, brins, terre visible par endroits
          float t1 = vn(w * 1.3), t2 = vn(w * 11.0), t3 = vn(w * 47.0);
          vec3 herbe = mix(vec3(0.045, 0.075, 0.018), vec3(0.11, 0.15, 0.04), 0.5 * t1 + 0.5 * t2) * (0.8 + 0.4 * t3);
          herbe = mix(herbe, vec3(0.1, 0.08, 0.05), smoothstep(0.75, 0.9, vn(w * 0.7)) * 0.5);
          // allée stabilisée (sable de parc)
          vec3 sab = vec3(0.4, 0.35, 0.26) * (0.8 + 0.35 * vn(w * 23.0)) * (0.9 + 0.2 * vn(w * 0.8));
          col = mix(mix(pave, sab, sable), herbe, veg);
          rough = mix(mix(0.75 + 0.15 * h21(id), 0.95, sable), 0.97, veg);
          hB = mix(mix(smoothstep(0.0, 0.02, b) * 0.012 * (1.0 - flou), vn(w * 23.0) * 0.004, sable), t3 * 0.01, veg) * (1.0 - smoothstep(25.0, 70.0, dist));
        }
        diffuseColor.rgb *= col;`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rough;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        { vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition), vN = normal;
          vec3 R1 = cross(sy, vN), R2 = cross(vN, sx); float det = dot(sx, R1);
          vec2 dH = vec2(dFdx(hB), dFdy(hB)) * 2.5;
          normal = normalize(abs(det) * vN - sign(det) * (dH.x * R1 + dH.y * R2)); }`,
      );
  };
  return m;
}

/** Sol en deux grilles : fine près du centre, plus lâche au-delà (performances iPhone). */
export function creerSolUrbain(P: ParamsSol): THREE.Mesh {
  const [x0, y0, x1, y1] = P.bbox;
  // le repère de la scène : x = est, z = sud ; uBbox ramène la position monde aux UV de l'orthophoto
  const o = P.vers3({ x: x0, y: y1 }, 0);
  uBbox.value.set(o.x, o.z, x1 - x0, y1 - y0);
  const pos: number[] = [], idx: number[] = [];
  const grille = (pas: number, dedans: (p: XY) => boolean) => {
    const nx = Math.ceil((x1 - x0) / pas), ny = Math.ceil((y1 - y0) / pas);
    const ids = new Int32Array((nx + 1) * (ny + 1)).fill(-1);
    const v = (i: number, j: number) => {
      const k = j * (nx + 1) + i;
      if (ids[k]! < 0) {
        const p = { x: Math.min(x1, x0 + i * pas), y: Math.max(y0, y1 - j * pas) };
        const q = P.vers3(p, 0.03); // 3 cm au-dessus du terrain nu
        pos.push(q.x, q.y, q.z);
        ids[k] = pos.length / 3 - 1;
      }
      return ids[k]!;
    };
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = { x: x0 + (i + 0.5) * pas, y: y1 - (j + 0.5) * pas };
        if (!dedans(c) || !P.garder(c)) continue;
        const a = v(i, j), b = v(i + 1, j), d = v(i, j + 1), e = v(i + 1, j + 1);
        idx.push(a, d, b, b, d, e);
      }
  };
  const rFin = P.mobile ? 90 : 130;
  const pres = (p: XY) => Math.hypot(p.x - P.centre.x, p.y - P.centre.y) < rFin;
  grille(P.mobile ? 1.5 : 1, pres);
  grille(P.mobile ? 4 : 2, (p) => !pres(p));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, materiau());
  m.name = 'sol_urbain';
  m.receiveShadow = true;
  return m;
}
