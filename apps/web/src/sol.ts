/**
 * Sol réaliste (zone détaillée) : on n'affiche plus la photo aérienne au sol (elle contient le dessus des arbres,
 * les voitures, les ombres). On reconstruit le sol en matières physiques à partir de données ouvertes :
 *
 *   1. IGN CoSIA (couverture du sol par IA, 20 cm, Licence Ouverte 2.0) : imperméable, perméable, pelouse, sol nu,
 *      eau, bâti, végétation…
 *   2. Sous les couronnes d'arbres (CoSIA ne voit que le feuillage) : le sol est déduit du voisinage le plus proche
 *      (trottoir sous un platane, pelouse sous un arbre de parc) ; au cœur d'un bois : litière de feuilles.
 *   3. OpenStreetMap (ODbL, « © contributeurs OpenStreetMap ») : nature du revêtement (pavés, stabilisé, terre…).
 *
 * Sortie : deux textures de poids (« splat ») lues par le matériau du relief, qui mélange 7 matières photo
 * (Poly Haven, CC0) avec un mélange par hauteur, sans répétition visible, normales et rugosité.
 */
import * as THREE from 'three';
import { urlWms } from '@lumen/urban';

export type Bbox = [number, number, number, number];

/** Matières du sol, dans l'ordre des couches de texture. */
export const MATIERES = ['asphalte', 'paves', 'stabilise', 'pelouse', 'terre', 'litiere'] as const;
const ECHELLES = [3.0, 1.6, 2.2, 2.4, 2.6, 2.4]; // mètres par répétition (avant anti-répétition)

// Classes CoSIA (couleurs de la légende officielle IGN) → classe interne
const enum C { Impermeable, Permeable, Pelouse, SolNu, Eau, Bati, Vegetation, Inconnu }
const LEGENDE: [number, number, number, C][] = [
  [206, 112, 121, C.Bati], [166, 170, 183, C.Impermeable], [152, 119, 82, C.Permeable], [98, 208, 255, C.Eau],
  [187, 176, 150, C.SolNu], [51, 117, 161, C.Eau], [233, 239, 254, C.Impermeable], [33, 110, 46, C.Vegetation],
  [76, 145, 41, C.Vegetation], [228, 142, 77, C.SolNu], [181, 195, 53, C.Vegetation], [140, 215, 106, C.Pelouse],
  [222, 207, 85, C.Pelouse], [208, 163, 115, C.SolNu], [180, 120, 200, C.Pelouse], [60, 80, 100, C.Impermeable],
];
function classer(r: number, g: number, b: number, a: number): C {
  if (a < 128) return C.Inconnu;
  let best = C.Inconnu, d = 1e9;
  for (const [R, G, B, c] of LEGENDE) { const e = (R - r) ** 2 + (G - g) ** 2 + (B - b) ** 2; if (e < d) (d = e), (best = c); }
  return d < 2500 ? best : C.Inconnu;
}

const MILLESIMES = ['IGNF_COSIA_2024-2026', 'IGNF_COSIA_2021-2023', 'IGNF_COSIA_2017-2020'];

async function imageWms(couche: string, bbox: Bbox, n: number): Promise<ImageData> {
  const r = await fetch(urlWms(couche, bbox, n, n, 'image/png'));
  if (!r.ok) throw new Error(`CoSIA ${r.status}`);
  const img = await createImageBitmap(await r.blob());
  const cv = new OffscreenCanvas(n, n);
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, n, n);
  return g.getImageData(0, 0, n, n);
}

/** Couverture CoSIA de l'emprise (dernier millésime couvrant au moins 60 % de la zone). */
async function couverture(bbox: Bbox, n: number): Promise<Uint8Array> {
  for (const m of MILLESIMES) {
    try {
      const d = (await imageWms(m, bbox, n)).data;
      const c = new Uint8Array(n * n);
      let connus = 0;
      for (let i = 0; i < n * n; i++) { c[i] = classer(d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!, d[i * 4 + 3]!); if (c[i] !== C.Inconnu) connus++; }
      if (connus > n * n * 0.6) return c;
    } catch { /* millésime suivant */ }
  }
  throw new Error('CoSIA indisponible');
}

// --- OpenStreetMap : nature des revêtements ---------------------------------------
interface WayOSM { tags: Record<string, string>; geometry?: { lat: number; lon: number }[] }
const SURF: Record<string, number> = {
  sett: 1, cobblestone: 1, unhewn_cobblestone: 1, paving_stones: 1, granite: 1, stone: 1, 'cobblestone:flattened': 1,
  gravel: 2, fine_gravel: 2, compacted: 2, pebblestone: 2, sand: 2,
  dirt: 4, earth: 4, ground: 4, mud: 4, grass: 3,
};
const LARGEUR: Record<string, number> = {
  primary: 12, secondary: 11, tertiary: 9, residential: 7, unclassified: 7, living_street: 6, service: 4, pedestrian: 7,
  footway: 2.5, path: 2.2, cycleway: 2, track: 3, steps: 2.5,
};

async function surfacesOSM(bboxWgs: [number, number, number, number]): Promise<WayOSM[]> {
  const [o, s, e, n] = bboxWgs;
  const b = `${s},${o},${n},${e}`;
  const q = `[out:json][timeout:20];(way["surface"](${b});way["natural"="water"](${b});way["water"](${b});way["leisure"~"^(park|garden)$"](${b}););out tags geom;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) });
  if (!r.ok) throw new Error('Overpass');
  return ((await r.json()) as { elements: WayOSM[] }).elements.filter((w) => w.geometry?.length);
}

/** Rasterise les revêtements OSM : renvoie une carte matière (0 = rien, sinon 1 + indice de matière ; 7 = eau). */
function rasterOSM(ways: WayOSM[], bbox: Bbox, n: number, versL93: (lon: number, lat: number) => { x: number; y: number }): Uint8Array {
  const cv = new OffscreenCanvas(n, n);
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = false;
  const res = (bbox[2] - bbox[0]) / n;
  const px = (lon: number, lat: number) => { const p = versL93(lon, lat); return [(p.x - bbox[0]) / res, (bbox[3] - p.y) / res] as const; };
  const trace = (w: WayOSM) => { g.beginPath(); w.geometry!.forEach((p, i) => { const [x, y] = px(p.lon, p.lat); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); };
  // ordre : eau, puis surfaces, puis voies (les plus précises en dernier)
  const tri = [...ways].sort((a, b) => rang(a) - rang(b));
  for (const w of tri) {
    const t = w.tags;
    const eau = t.natural === 'water' || !!t.water;
    const m = eau ? 7 : t.surface ? SURF[t.surface] : undefined;
    if (m === undefined) continue;
    g.fillStyle = g.strokeStyle = `rgb(${m + 1},0,0)`;
    const g0 = w.geometry!, ferme = g0.length > 3 && g0[0]!.lat === g0[g0.length - 1]!.lat && g0[0]!.lon === g0[g0.length - 1]!.lon;
    trace(w);
    if (ferme && (eau || t.area === 'yes' || !t.highway || t.highway === 'pedestrian')) g.fill();
    else { g.lineWidth = (LARGEUR[t.highway ?? ''] ?? 3) / res; g.lineCap = g.lineJoin = 'round'; g.stroke(); }
  }
  const d = g.getImageData(0, 0, n, n).data;
  const out = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) out[i] = d[i * 4 + 3]! > 127 ? d[i * 4]! : 0; // pas d'anticrénelage dans la carte
  return out;
}
const rang = (w: WayOSM) => (w.tags.natural === 'water' || w.tags.water ? 0 : w.tags.highway ? 2 : 1);

// --- Carte des matières --------------------------------------------------------------
export interface CarteSol {
  bbox: Bbox;
  n: number;
  /** Poids des matières : A = asphalte, pavés, stabilisé, pelouse ; B = terre, litière, eau, bâti. */
  a: THREE.DataTexture;
  b: THREE.DataTexture;
  stats: Record<string, number>;
  sources: string[];
}

export async function construireCarteSol(
  bbox: Bbox,
  res: number,
  versWgs: (x: number, y: number) => { lon: number; lat: number },
  versL93: (lon: number, lat: number) => { x: number; y: number },
): Promise<CarteSol> {
  const n = Math.min(2048, Math.round((bbox[2] - bbox[0]) / res));
  const sources = ['IGN CoSIA (Licence Ouverte 2.0)'];
  const [cosia, osm] = await Promise.all([
    couverture(bbox, n),
    (async () => {
      try {
        const sw = versWgs(bbox[0], bbox[1]), ne = versWgs(bbox[2], bbox[3]);
        const w = await surfacesOSM([sw.lon, sw.lat, ne.lon, ne.lat]);
        sources.push('© contributeurs OpenStreetMap (ODbL)');
        return rasterOSM(w, bbox, n, versL93);
      } catch { return null; }
    })(),
  ]);

  // 1. Sous la végétation : propagation de la classe voisine la plus proche (parcours en largeur).
  const cl = cosia.slice();
  const dist = new Uint16Array(n * n).fill(65535);
  let file: number[] = [];
  for (let i = 0; i < n * n; i++) if (cl[i] !== C.Vegetation && cl[i] !== C.Inconnu) { dist[i] = 0; file.push(i); }
  for (let d = 1; file.length && d < 2000; d++) {
    const suiv: number[] = [];
    for (const i of file) {
      const x = i % n, y = (i / n) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < n - 1 ? i + 1 : -1, y > 0 ? i - n : -1, y < n - 1 ? i + n : -1]) {
        if (j < 0 || dist[j] !== 65535) continue;
        dist[j] = d;
        cl[j] = cl[i]!;
        suiv.push(j);
      }
    }
    file = suiv;
  }
  // Sous les arbres d'une ville, le sol est celui d'à côté (trottoir, sable stabilisé des parcs, pelouse) ;
  // seulement au cœur d'un vrai bois (> 25 m de tout sol visible) : litière de feuilles.
  const loinBois = Math.round(25 / ((bbox[2] - bbox[0]) / n));

  // 2. Matière par pixel
  const mat = new Uint8Array(n * n); // indice 0..5 = MATIERES, 6 = eau, 7 = bâti
  const stats: Record<string, number> = {};
  for (let i = 0; i < n * n; i++) {
    let m: number;
    const c = cl[i]!;
    if (cosia[i] === C.Vegetation && dist[i]! > loinBois) m = 5;
    else if (c === C.Eau) m = 6;
    else if (c === C.Bati) m = 7;
    else if (c === C.Pelouse) m = 3;
    else if (c === C.SolNu) m = 4;
    else if (c === C.Permeable) m = 2; // allées en sable stabilisé (parcs, squares)
    else m = 0;
    const o = osm?.[i] ?? 0;
    if (o) {
      const om = o - 1;
      if (om === 7) m = 6;
      else if (om === 1 && (m === 0 || m === 7)) m = 1; // pavés : seulement sur l'imperméable
      else if (om === 2 && m !== 6) m = 2;
      else if (om === 4 && m !== 6) m = 4;
      else if (om === 3 && m !== 6 && m !== 7) m = 3;
    }
    mat[i] = m;
    const k = m < 6 ? MATIERES[m]! : m === 6 ? 'eau' : 'bati';
    stats[k] = (stats[k] ?? 0) + 1;
  }

  // 3. Poids (8 canaux), adoucis par un flou 3×3 pour des transitions naturelles
  const A = new Uint8Array(n * n * 4), B = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const w = new Float32Array(8);
      let t = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(n - 1, Math.max(0, x + dx)), yy = Math.min(n - 1, Math.max(0, y + dy));
          const k = dx || dy ? 1 : 4;
          w[mat[yy * n + xx]!]! += k;
          t += k;
        }
      const i = (y * n + x) * 4;
      for (let c = 0; c < 4; c++) { A[i + c] = Math.round((255 * w[c]!) / t); B[i + c] = Math.round((255 * w[c + 4]!) / t); }
    }
  const tex = (d: Uint8Array<ArrayBuffer>) => {
    const t = new THREE.DataTexture(d, n, n, THREE.RGBAFormat);
    t.flipY = false;
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  };
  for (const k in stats) stats[k] = Math.round((stats[k]! / (n * n)) * 1000) / 10;
  return { bbox, n, a: tex(A), b: tex(B), stats, sources };
}

// --- Textures de matières (tableaux de textures : 2 échantillonneurs pour 6 matières) -------
export interface TexturesSol { couleur: THREE.DataArrayTexture; normale: THREE.DataArrayTexture; echelles: number[] }

export async function chargerTexturesSol(base: string, taille: number): Promise<TexturesSol> {
  const charger = (src: string) =>
    fetch(src).then((r) => r.blob()).then((b) => createImageBitmap(b, { resizeWidth: taille, resizeHeight: taille, resizeQuality: 'high' }));
  const cv = new OffscreenCanvas(taille, taille);
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  const L = MATIERES.length, px = taille * taille;
  const coul = new Uint8Array(px * 4 * L), nor = new Uint8Array(px * 4 * L);
  await Promise.all(
    MATIERES.map(async (m, k) => {
      const [c, r, n] = await Promise.all(['c', 'r', 'n'].map((s) => charger(`${base}${m}_${s}.webp`)));
      // couleur (RVB) + rugosité (A) ; normale (RVB)
      const lire = (img: ImageBitmap) => { const t = new OffscreenCanvas(taille, taille).getContext('2d', { willReadFrequently: true })!; t.drawImage(img, 0, 0); return t.getImageData(0, 0, taille, taille).data; };
      const dc = lire(c!), dr = lire(r!), dn = lire(n!);
      for (let i = 0; i < px; i++) {
        const o = k * px * 4 + i * 4;
        coul[o] = dc[i * 4]!; coul[o + 1] = dc[i * 4 + 1]!; coul[o + 2] = dc[i * 4 + 2]!; coul[o + 3] = dr[i * 4]!;
        nor[o] = dn[i * 4]!; nor[o + 1] = dn[i * 4 + 1]!; nor[o + 2] = dn[i * 4 + 2]!; nor[o + 3] = 255;
      }
    }),
  );
  void g;
  const tab = (d: Uint8Array<ArrayBuffer>, srgb: boolean) => {
    const t = new THREE.DataArrayTexture(d, taille, taille, L);
    t.format = THREE.RGBAFormat;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { couleur: tab(coul, true), normale: tab(nor, false), echelles: ECHELLES };
}

// --- Shader (injecté dans le matériau du relief) ------------------------------------------
export const uniformesSol = {
  uSol: { value: 0 },
  uSolA: { value: null as THREE.Texture | null },
  uSolB: { value: null as THREE.Texture | null },
  uSolBox: { value: new THREE.Vector4() }, // xmin, zmin (repère local), taille x, taille z
  uSolTexel: { value: 1 / 1024 },
  uSolCoul: { value: null as THREE.DataArrayTexture | null },
  uSolNor: { value: null as THREE.DataArrayTexture | null },
  uSolEch: { value: ECHELLES.slice() },
  // Correction de teinte vers les sols parisiens : enrobé gris, pavés de granit, sable stabilisé beige clair,
  // pelouse plus verte et dense, terre brune, litière.
  uSolSat: { value: [1, 0.9, 0.32, 1, 0.55, 0.9] },
  uSolTeinte: { value: [[1, 1, 1], [1.05, 1.02, 1.0], [1.3, 1.27, 1.2], [0.8, 1.06, 0.66], [0.85, 0.78, 0.7], [0.9, 0.85, 0.8]].map(([r, g, b]) => new THREE.Vector3(r, g, b)) },
};

export const GLSL_SOL_DECL = `
uniform float uSol; uniform sampler2D uSolA, uSolB; uniform vec4 uSolBox; uniform float uSolTexel;
uniform highp sampler2DArray uSolCoul, uSolNor; uniform float uSolEch[6]; uniform vec3 uSolTeinte[6]; uniform float uSolSat[6];
varying vec3 vWpSol;
float hSol(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float nSol(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hSol(i),hSol(i+vec2(1,0)),f.x), mix(hSol(i+vec2(0,1)),hSol(i+vec2(1,1)),f.x), f.y); }
// Échantillonnage sans répétition visible (variante d'I. Quilez) dans une couche du tableau.
vec4 solTex(highp sampler2DArray t, vec2 x, float couche){
  float k = nSol(x * 0.9); vec2 dx = dFdx(x), dy = dFdy(x);
  float l = k * 8.0, f = fract(l), ia = floor(l), ib = ia + 1.0;
  vec2 oa = sin(vec2(3.0, 7.0) * ia), ob = sin(vec2(3.0, 7.0) * ib);
  vec4 a = textureGrad(t, vec3(x + oa, couche), dx, dy), b = textureGrad(t, vec3(x + ob, couche), dx, dy);
  return mix(a, b, smoothstep(0.2, 0.8, f - 0.1 * dot(a.rgb - b.rgb, vec3(1.0))));
}`;

/**
 * Corps : calcule solCoul (albédo linéaire), solRug, solN (normale monde), solMasque (0..1 : part où le sol
 * reconstruit remplace la photo ; 0 sur le bâti, hors zone ou sur les surfaces en pente).
 */
export const GLSL_SOL_CORPS = `
  vec3 solCoul = vec3(0.0); float solRug = 0.9; vec3 solN = vec3(0.0, 1.0, 0.0); float solMasque = 0.0;
  vec2 suv = (vWpSol.xz - uSolBox.xy) / uSolBox.zw;
  if (uSol > 0.5 && suv.x > 0.0 && suv.y > 0.0 && suv.x < 1.0 && suv.y < 1.0) {
    vec4 wa = texture2D(uSolA, suv), wb = texture2D(uSolB, suv);
    float w[8]; w[0]=wa.r; w[1]=wa.g; w[2]=wa.b; w[3]=wa.a; w[4]=wb.r; w[5]=wb.g; w[6]=wb.b; w[7]=wb.a;
    vec2 p = vec2(vWpSol.x, -vWpSol.z);
    float dist = length(cameraPosition - vWpSol);
    vec3 acc = vec3(0.0), accN = vec3(0.0); float accR = 0.0, tot = 0.0;
    // mélange par hauteur : aux frontières, les gravillons dépassent du sable, l'herbe déborde sur la terre
    for (int k = 0; k < 6; k++) {
      if (w[k] < 0.004) continue;
      vec4 c = solTex(uSolCoul, p / uSolEch[k], float(k));
      vec3 nm = solTex(uSolNor, p / uSolEch[k], float(k)).xyz * 2.0 - 1.0;
      c.rgb = mix(vec3(dot(c.rgb, vec3(0.3, 0.59, 0.11))), c.rgb, uSolSat[k]) * uSolTeinte[k];
      float hauteur = dot(c.rgb, vec3(0.33));
      float poids = pow(w[k], 1.0) * (0.25 + hauteur);
      poids = poids * poids * poids;
      acc += c.rgb * poids; accR += c.a * poids; accN += nm * poids; tot += poids;
    }
    if (tot > 0.0) { acc /= tot; accR /= tot; accN /= tot; } else { accN = vec3(0.0, 0.0, 1.0); accR = 0.9; }
    // macro-variations (pas de motif répété à grande échelle) et salissure au pied des murs
    float macro = nSol(p * 0.05) * 0.6 + nSol(p * 0.21) * 0.4;
    acc *= 0.82 + 0.36 * macro;
    float pied = 0.0;
    for (int i = 0; i < 4; i++) { vec2 o = vec2(i == 0 ? 1.0 : i == 1 ? -1.0 : 0.0, i == 2 ? 1.0 : i == 3 ? -1.0 : 0.0) * uSolTexel * 3.0; pied += texture2D(uSolB, suv + o).a; }
    pied = clamp(pied * 0.25 - w[7], 0.0, 1.0);
    acc *= 1.0 - 0.35 * pied;
    // eau : sombre, lisse, légèrement ridée
    float eau = w[6];
    vec3 rides = vec3(nSol(p * 3.0 + 0.3) - 0.5, 0.0, nSol(p * 3.1 - 0.7) - 0.5) * 0.15;
    solCoul = mix(acc, vec3(0.025, 0.04, 0.045), eau);
    solRug = mix(accR, 0.04, eau);
    vec3 nt = vec3(accN.x, accN.z, -accN.y);
    nt = dot(nt, nt) > 1e-6 ? normalize(nt) : vec3(0.0, 1.0, 0.0); // jamais de NaN (sinon pixels noirs)
    float fondu = 1.0 - smoothstep(60.0, 220.0, dist); // relief des normales atténué au loin (pas de scintillement)
    solN = normalize(mix(vec3(0.0, 1.0, 0.0), nt, 0.85 * fondu) + rides * eau);
    vec2 bord = min(suv, 1.0 - suv);
    solMasque = (1.0 - w[7]) * smoothstep(0.0, 0.02, min(bord.x, bord.y));
  }`;
