// Ville la nuit : fenêtres allumées, lampadaires de la Ville de Paris, lumière urbaine au sol et sur les façades.
//
// Fenêtres : chaque pièce (attribut aPiece, voir generateur/facades.js) a un seuil propre ; elle est allumée si
// seuil < part de fenêtres allumées à cette heure. Cette part suit un MODÈLE horaire (rythmes de vie : retour
// en soirée, coucher vers 23 h–minuit, réveil 6 h 30–8 h, décalé le week-end) et ne joue que s'il fait sombre
// dehors. Ce n'est pas une mesure : la provenance l'indique.
//
// Lampadaires : position réelle de chaque point lumineux (Ville de Paris, « Éclairage public », une ligne par
// lampe). Allumage astronomique : soleil 2° sous l'horizon (≈ 15 min après le coucher, avant le lever).
// Éclairement au sol calculé par la loi de l'inverse du carré (E = I·h / (h² + r²)^1,5), stocké dans une texture
// unique lue par toutes les matières (une seule lecture de texture par pixel : supportable sur iPhone).
import * as THREE from 'three';
import { versL93, type LonLat, type XY } from '@lumen/core';

// ---------------------------------------------------------------------------
// Modèle d'occupation (part de fenêtres de logement allumées quand il fait nuit)
// ---------------------------------------------------------------------------
const SEMAINE = [0.14, 0.08, 0.05, 0.035, 0.03, 0.04, 0.12, 0.22, 0.14, 0.07, 0.05, 0.05, 0.06, 0.06, 0.05, 0.05, 0.07, 0.14, 0.26, 0.36, 0.42, 0.44, 0.36, 0.24];
const WEEKEND = [0.2, 0.13, 0.08, 0.05, 0.035, 0.03, 0.04, 0.08, 0.14, 0.16, 0.12, 0.08, 0.07, 0.07, 0.06, 0.06, 0.08, 0.15, 0.26, 0.34, 0.4, 0.43, 0.4, 0.3];

/** Part de fenêtres allumées (0..1). heure = heure locale de Paris (décimale), elevation = hauteur du soleil (°). */
export function partFenetres(heure: number, jourSemaine: number, elevation: number): number {
  const c = jourSemaine === 0 || jourSemaine === 6 ? WEEKEND : SEMAINE;
  const h = ((heure % 24) + 24) % 24, i = Math.floor(h), f = h - i;
  const p = c[i]! * (1 - f) + c[(i + 1) % 24]! * f;
  // on allume quand l'intérieur devient sombre : dès ~5° de soleil, pleinement sous −4°
  const sombre = Math.min(1, Math.max(0, (5 - elevation) / 9));
  return p * sombre;
}

// ---------------------------------------------------------------------------
// Uniformes partagés
// ---------------------------------------------------------------------------
export const U = {
  uFrac: { value: 0 }, // part de fenêtres allumées
  uLuxInt: { value: 0 }, // radiance d'un intérieur éclairé (unités de la scène)
  uTemps: { value: 0 },
  uLu: { value: null as THREE.Texture | null }, // éclairement des lampadaires (rgb lux, a = altitude locale du sol)
  uLuOn: { value: 0 },
  uLuBbox: { value: new THREE.Vector4() },
  uLuOrig: { value: new THREE.Vector2() },
  uPar: { value: 0 },
};

/** Lampes allumées ? (allumage astronomique, soleil à −2°) */
export const lampesAllumees = (elevation: number) => elevation < -2;

// ---------------------------------------------------------------------------
// Fenêtres : intérieurs, rideaux (vitres : on voit l'intérieur à travers)
// ---------------------------------------------------------------------------
const GLSL_PIECE = /* glsl */ `
float allume(float pid, vec3 wp, out vec3 c, out float I) {
  c = vec3(0.0); I = 0.0;
  if (pid < 0.0) return 0.0;
  float h = fract(pid * 7.13 + dot(floor(wp.xz * 0.02), vec2(0.371, 0.917)));
  if (h >= uFrac) return 0.0;
  float k = fract(h * 91.7);
  if (k < 0.62) c = vec3(1.0, 0.6, 0.32);        // 2 700 K, lampes chaudes
  else if (k < 0.88) c = vec3(1.0, 0.78, 0.56);  // 3 500 K
  else {                                          // écran de télévision : bleuté, scintillant
    c = vec3(0.5, 0.64, 1.0) * (0.55 + 0.45 * sin(uTemps * 6.3 + h * 40.0) * sin(uTemps * 2.1 + h * 13.0));
  }
  I = uLuxInt * (k < 0.88 ? 0.6 + 0.8 * fract(h * 13.3) : 0.3);
  return 1.0;
}`;

/** Branche l'éclairage de nuit sur les matières d'intérieur et de rideaux du kit de façades. */
export function equiperFenetres(M: { vc: THREE.Material; rideau: THREE.Material; rideauTire: THREE.Material }) {
  const patch = (m: THREE.Material, gain: number) => {
    const prec = m.onBeforeCompile.bind(m);
    m.onBeforeCompile = (s, r) => {
      prec(s, r);
      Object.assign(s.uniforms, { uFrac: U.uFrac, uLuxInt: U.uLuxInt, uTemps: U.uTemps });
      s.vertexShader = 'attribute float aPiece;\nvarying float vPiece; varying vec3 vWpN;\n' +
        s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvPiece = aPiece; vWpN = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uFrac, uLuxInt, uTemps;\nvarying float vPiece; varying vec3 vWpN;\n' + GLSL_PIECE)
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           { vec3 lc; float li; if (allume(vPiece, vWpN, lc, li) > 0.5) totalEmissiveRadiance += diffuseColor.rgb * lc * li * ${gain.toFixed(2)}; }`,
        );
    };
    const cle = m.customProgramCacheKey.bind(m);
    m.customProgramCacheKey = () => cle() + '_nuit';
    m.needsUpdate = true;
  };
  patch(M.vc, 1);
  patch(M.rideau, 0.45); // voilage éclairé par derrière
  patch(M.rideauTire, 0.45);
}

// ---------------------------------------------------------------------------
// Lumière urbaine : ajoutée à toutes les matières standard de la scène
// ---------------------------------------------------------------------------
const GLSL_LU = /* glsl */ `
{
  vec2 L = vec2(vLuW.x + uLuOrig.x, -vLuW.z + uLuOrig.y);
  vec2 uvL = vec2((L.x - uLuBbox.x) / (uLuBbox.z - uLuBbox.x), (uLuBbox.w - L.y) / (uLuBbox.w - uLuBbox.y));
  if (uLuOn > 0.5 && uvL.x > 0.0 && uvL.y > 0.0 && uvL.x < 1.0 && uvL.y < 1.0) {
    vec4 e = texture2D(uLu, uvL);
    float hr = vLuW.y - e.a;                                   // hauteur au-dessus du sol
    float f = 1.0 - smoothstep(5.0, 14.0, hr);                 // les lampes sont à 4–9 m
    vec3 nW = inverseTransformDirection(normal, viewMatrix);
    f *= mix(0.55, 1.0, max(nW.y, 0.0));                       // murs : un peu moins que le sol
    reflectedLight.indirectDiffuse += e.rgb * uPar * f * BRDF_Lambert(diffuseColor.rgb);
  }
}`;

/** Ajoute la lumière des lampadaires à une matière standard (une fois). */
export function equiperLumiere(m: THREE.Material) {
  const ms = m as THREE.MeshStandardMaterial;
  if (!(ms.isMeshStandardMaterial) || ms.userData.lu) return;
  ms.userData.lu = true;
  const prec = ms.onBeforeCompile.bind(ms);
  ms.onBeforeCompile = (s, r) => {
    prec(s, r);
    Object.assign(s.uniforms, { uLu: U.uLu, uLuOn: U.uLuOn, uLuBbox: U.uLuBbox, uLuOrig: U.uLuOrig, uPar: U.uPar });
    if (!s.vertexShader.includes('#include <project_vertex>')) return;
    s.vertexShader = 'varying vec3 vLuW;\n' + s.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
       #ifdef USE_INSTANCING
         vLuW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
       #else
         vLuW = (modelMatrix * vec4(transformed, 1.0)).xyz;
       #endif`,
    );
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uLu; uniform float uLuOn, uPar; uniform vec4 uLuBbox; uniform vec2 uLuOrig;\nvarying vec3 vLuW;')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + GLSL_LU);
  };
  const cle = ms.customProgramCacheKey.bind(ms);
  ms.customProgramCacheKey = () => cle() + '_lu';
  ms.needsUpdate = true;
}

/** Parcourt la scène et équipe les nouvelles matières (appel peu fréquent). */
export function equiperScene(scene: THREE.Object3D) {
  scene.traverse((o) => {
    const me = o as THREE.Mesh;
    if (!me.isMesh || me.userData.sansLu) return;
    for (const m of ([] as THREE.Material[]).concat(me.material)) equiperLumiere(m);
  });
}

// ---------------------------------------------------------------------------
// Lampadaires
// ---------------------------------------------------------------------------
export type TypeLampe = 'candelabre' | 'console' | 'borne';
export interface Lampe {
  p: XY;
  type: TypeLampe;
  /** Hauteur du foyer (m). */
  h: number;
  /** Intensité vers le bas (cd). */
  I: number;
  couleur: [number, number, number];
  source: 'mesure' | 'genere';
}

const LED: [number, number, number] = [1, 0.8, 0.6]; // 3 000 K (rénovation LED de Paris)
const SODIUM: [number, number, number] = [1, 0.55, 0.2]; // sodium haute pression

/** Points lumineux de la Ville de Paris dans un rayon (m). Champs lus de façon tolérante. */
export async function lampesParis(centre: LonLat, rayon: number): Promise<Lampe[]> {
  const where = encodeURIComponent(`within_distance(geo_point_2d, geom'POINT(${centre.lon} ${centre.lat})', ${Math.round(rayon)}m)`);
  const url = `https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/eclairage-public/exports/json?where=${where}&limit=-1`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); // service lent : repli sur lampes générées
  if (!r.ok) throw new Error(`Éclairage public indisponible (${r.status})`);
  const lignes = (await r.json()) as Record<string, unknown>[];
  const out: Lampe[] = [];
  const vus = new Set<string>();
  for (const l of lignes) {
    const g = l.geo_point_2d as { lon: number; lat: number } | undefined;
    if (!g || !Number.isFinite(g.lon)) continue;
    const p = versL93({ lon: g.lon, lat: g.lat });
    const k = `${Math.round(p.x / 0.6)},${Math.round(p.y / 0.6)}`; // plusieurs lampes par ouvrage
    if (vus.has(k)) continue;
    vus.add(k);
    const txt = Object.values(l).filter((v) => typeof v === 'string').join(' ').toLowerCase();
    let hNum = NaN;
    for (const [c, v] of Object.entries(l)) if (/haut/i.test(c) && typeof v === 'number' && v > 0.5 && v < 25) hNum = v;
    const type: TypeLampe = /borne/.test(txt) ? 'borne' : /console|applique|façade|facade|murale/.test(txt) ? 'console' : 'candelabre';
    const h = Number.isFinite(hNum) ? hNum : type === 'borne' ? 1 : type === 'console' ? 6.5 : 8;
    out.push({ p, type, h, I: type === 'borne' ? 90 : type === 'console' ? 1100 : 1500, couleur: /sodium|shp|\bson\b/.test(txt) ? SODIUM : LED, source: 'mesure' });
  }
  return out;
}

/** Repli : lampadaires le long des bordures (côté trottoir), espacement parisien ~25 m, signalés « générés ». */
export function lampesGenerees(bordures: { pts: XY[] }[]): Lampe[] {
  const out: Lampe[] = [];
  for (const b of bordures) {
    let acc = 6;
    for (let i = 0; i < b.pts.length - 1; i++) {
      const A = b.pts[i]!, B = b.pts[i + 1]!, l = Math.hypot(B.x - A.x, B.y - A.y);
      while (acc < l) {
        const f = acc / l, nx = (B.y - A.y) / l, ny = -(B.x - A.x) / l; // trottoir à droite de la bordure
        out.push({ p: { x: A.x + (B.x - A.x) * f + nx * 0.6, y: A.y + (B.y - A.y) * f + ny * 0.6 }, type: 'candelabre', h: 8, I: 1500, couleur: LED, source: 'genere' });
        acc += 25;
      }
      acc -= l;
    }
  }
  return out;
}

/** Carte d'éclairement (lux par canal, 1 m) + altitude du sol, en texture demi-flottante. */
export function carteLumiere(lampes: Lampe[], bbox: [number, number, number, number], sol: (p: XY) => number, alt0: number, res = 1): THREE.DataTexture {
  const n = Math.round((bbox[2] - bbox[0]) / res);
  const E = new Float32Array(n * n * 4);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) E[(j * n + i) * 4 + 3] = sol({ x: bbox[0] + (i + 0.5) * res, y: bbox[3] - (j + 0.5) * res }) - alt0;
  for (const L of lampes) {
    const R = Math.min(40, L.h * 4.5), ci = (L.p.x - bbox[0]) / res, cj = (bbox[3] - L.p.y) / res;
    for (let j = Math.max(0, Math.floor(cj - R / res)); j <= Math.min(n - 1, Math.ceil(cj + R / res)); j++)
      for (let i = Math.max(0, Math.floor(ci - R / res)); i <= Math.min(n - 1, Math.ceil(ci + R / res)); i++) {
        const r2 = ((i + 0.5 - ci) * res) ** 2 + ((j + 0.5 - cj) * res) ** 2;
        if (r2 > R * R) continue;
        const e = (L.I * L.h) / Math.pow(L.h * L.h + r2, 1.5);
        const k = (j * n + i) * 4;
        E[k] = E[k]! + e * L.couleur[0];
        E[k + 1] = E[k + 1]! + e * L.couleur[1];
        E[k + 2] = E[k + 2]! + e * L.couleur[2];
      }
  }
  const h16 = new Uint16Array(E.length);
  for (let i = 0; i < E.length; i++) h16[i] = THREE.DataUtils.toHalfFloat(E[i]!);
  const t = new THREE.DataTexture(h16, n, n, THREE.RGBAFormat, THREE.HalfFloatType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Maillages des lampadaires (fût, luminaire, verre lumineux, halo) : 4 appels de dessin. */
export function creerLampadaires(lampes: Lampe[], vers3: (p: XY, dz: number) => THREE.Vector3, versRue: (p: XY) => XY): { groupe: THREE.Group; allumer(on: boolean, expo: number): void } {
  const g = new THREE.Group();
  g.name = 'lampadaires';
  const n = lampes.length;
  const fonte = new THREE.MeshStandardMaterial({ color: 0x23272a, metalness: 0.55, roughness: 0.45 });
  const futG = new THREE.CylinderGeometry(0.06, 0.11, 1, 8).translate(0, 0.5, 0);
  const brasG = new THREE.CylinderGeometry(0.035, 0.035, 1, 6).rotateZ(Math.PI / 2).translate(0.5, 0, 0);
  const teteG = new THREE.BoxGeometry(0.62, 0.11, 0.28).translate(0.31, 0, 0);
  const verreG = new THREE.PlaneGeometry(0.5, 0.2).rotateX(Math.PI / 2).translate(0.31, -0.057, 0);
  const lum = new THREE.MeshBasicMaterial({ color: 0x222222 });
  const fut = new THREE.InstancedMesh(futG, fonte, n), bras = new THREE.InstancedMesh(brasG, fonte, n);
  const tete = new THREE.InstancedMesh(teteG, fonte, n), verre = new THREE.InstancedMesh(verreG, lum, n);
  // halos : quads face caméra, additifs (pas de post-traitement, léger sur iPhone)
  const pl = new THREE.PlaneGeometry(1, 1), haloG = new THREE.InstancedBufferGeometry();
  haloG.setIndex(pl.index);
  haloG.setAttribute('position', pl.attributes.position!);
  haloG.setAttribute('uv', pl.attributes.uv!);
  const centres = new Float32Array(n * 3), couleurs = new Float32Array(n * 3);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), y = new THREE.Vector3(0, 1, 0);
  lampes.forEach((L, i) => {
    const base = vers3(L.p, 0);
    const d = versRue(L.p), ang = Math.atan2(d.y - L.p.y, d.x - L.p.x); // rotation autour de y vers la chaussée (x est, z sud)
    q.setFromAxisAngle(y, ang);
    const bras0 = L.type === 'console' ? 0.9 : L.type === 'borne' ? 0 : 0.7;
    const hFut = L.type === 'console' ? 0.001 : L.h;
    fut.setMatrixAt(i, m.compose(base, q, s.set(1, hFut, 1)));
    const haut = base.clone().setY(base.y + L.h);
    bras.setMatrixAt(i, m.compose(haut, q, s.set(Math.max(bras0, 0.001), 1, 1)));
    const pt = haut.clone().add(new THREE.Vector3(Math.cos(ang) * bras0, 0, -Math.sin(ang) * bras0));
    tete.setMatrixAt(i, m.compose(pt, q, s.set(L.type === 'borne' ? 0.4 : 1, 1, 1)));
    verre.setMatrixAt(i, m.compose(pt, q, s.set(L.type === 'borne' ? 0.4 : 1, 1, 1)));
    verre.setColorAt(i, new THREE.Color(...L.couleur));
    const c = pt.clone().add(new THREE.Vector3(Math.cos(ang) * 0.31, -0.12, -Math.sin(ang) * 0.31));
    centres.set([c.x, c.y, c.z], i * 3);
    couleurs.set(L.couleur, i * 3);
  });
  haloG.setAttribute('aCentre', new THREE.InstancedBufferAttribute(centres, 3));
  haloG.setAttribute('aCouleur', new THREE.InstancedBufferAttribute(couleurs, 3));
  haloG.instanceCount = n;
  const uHalo = { value: 0 };
  const haloM = new THREE.ShaderMaterial({
    uniforms: { uHalo },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aCentre, aCouleur; varying vec2 vUv; varying vec3 vC; uniform float uHalo;
      void main() {
        vUv = uv - 0.5; vC = aCouleur;
        vec4 mv = viewMatrix * vec4(aCentre, 1.0);
        float t = 2.2 * clamp(length(mv.xyz) / 60.0, 0.6, 2.0);   // taille stable à l'écran au loin
        mv.xy += position.xy * t;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vC; uniform float uHalo;
      void main() { float r = length(vUv) * 2.0; float a = exp(-r * r * 9.0) * 0.9 + exp(-r * 3.5) * 0.25; gl_FragColor = vec4(vC * a * uHalo, 1.0); }`,
  });
  const halo = new THREE.Mesh(haloG, haloM);
  halo.frustumCulled = false;
  halo.renderOrder = 10;
  halo.userData.sansLu = true;
  verre.userData.sansLu = true;
  for (const o of [fut, bras, tete]) (o.castShadow = true), (o.receiveShadow = true);
  g.add(fut, bras, tete, verre, halo);
  return {
    groupe: g,
    allumer(on, expo) {
      // verre du luminaire : saturé quand allumé ; halo à intensité perçue constante
      lum.color.setScalar(on ? 1 : 0.08);
      verre.instanceColor && (verre.instanceColor.needsUpdate = true);
      lum.toneMapped = !on;
      uHalo.value = on ? Math.min(1, 0.25 + expo / 4000) : 0;
      halo.visible = on;
    },
  };
}
