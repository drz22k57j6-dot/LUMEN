/**
 * Nuages volumétriques 3D (rendu par lancer de rayons, façon jeux AAA).
 *
 * - Trois couches réelles : basse (cumulus / stratocumulus / stratus, 600–2200 m),
 *   moyenne (altocumulus / altostratus, 2800–4600 m), haute (cirrus, 7500–8700 m).
 * - La couverture de chaque couche vient de la grille météo 5 × 5 (20 km) : les nuages sont là où
 *   le modèle les met ; le bruit 3D (Perlin-Worley) ne fait que sculpter leur forme et dérive avec le vent réel.
 * - Éclairage : extinction de Beer-Lambert, effet « poudre », diffusion avant/arrière (Henyey-Greenstein),
 *   ambiance du ciel ; couleur du soleil (aube, couchant) fournie par le modèle d'éclairement.
 * - Rendu à basse résolution dans une texture, composé derrière la ville (les immeubles masquent le ciel).
 * - Ombres des nuages au sol : un écran invisible, qui ne fait qu'ombrer, découpé par la couverture.
 */
import * as THREE from 'three';
import { N, PAS_KM, type EtatMeteo } from './meteo';

// --- Bruit 3D périodique (Perlin-Worley + Worley), calculé une fois ---------------------------
function texturesBruit(n: number): THREE.Data3DTexture {
  const data = new Uint8Array(n * n * n * 4);
  const rnd = (i: number) => {
    i = Math.imul(i ^ (i >>> 15), 0x2c1b3c6d);
    i = Math.imul(i ^ (i >>> 12), 0x297a2d39);
    return ((i ^ (i >>> 15)) >>> 0) / 4294967296;
  };
  // Worley périodique à c cellules
  const worley = (x: number, y: number, z: number, c: number, graine: number) => {
    const xi = Math.floor(x * c), yi = Math.floor(y * c), zi = Math.floor(z * c);
    let d = 9;
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (let e = -1; e <= 1; e++) {
          const cx = xi + a, cy = yi + b, cz = zi + e;
          const wx = ((cx % c) + c) % c, wy = ((cy % c) + c) % c, wz = ((cz % c) + c) % c;
          const h = (wx * 73856093) ^ (wy * 19349663) ^ (wz * 83492791) ^ graine;
          const px = (cx + rnd(h)) / c, py = (cy + rnd(h + 1)) / c, pz = (cz + rnd(h + 2)) / c;
          d = Math.min(d, (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2);
        }
    return 1 - Math.min(1, Math.sqrt(d) * c);
  };
  // Valeur lisse périodique (Perlin simplifié par valeurs aux sommets)
  const valeur = (x: number, y: number, z: number, c: number, graine: number) => {
    const X = x * c, Y = y * c, Z = z * c;
    const xi = Math.floor(X), yi = Math.floor(Y), zi = Math.floor(Z);
    const fx = X - xi, fy = Y - yi, fz = Z - zi;
    const u = (t: number) => t * t * (3 - 2 * t);
    const v = (a: number, b: number, e: number) => rnd((((xi + a) % c) * 73856093) ^ (((yi + b) % c) * 19349663) ^ (((zi + e) % c) * 83492791) ^ graine);
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(
      l(l(v(0, 0, 0), v(1, 0, 0), u(fx)), l(v(0, 1, 0), v(1, 1, 0), u(fx)), u(fy)),
      l(l(v(0, 0, 1), v(1, 0, 1), u(fx)), l(v(0, 1, 1), v(1, 1, 1), u(fx)), u(fy)),
      u(fz),
    );
  };
  for (let k = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = i / n, y = j / n, z = k / n;
        const perlin = valeur(x, y, z, 4, 1) * 0.5 + valeur(x, y, z, 8, 2) * 0.3 + valeur(x, y, z, 16, 3) * 0.2;
        const w1 = worley(x, y, z, 4, 11), w2 = worley(x, y, z, 8, 12), w3 = worley(x, y, z, 16, 13);
        const wfbm = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
        const pw = Math.min(1, Math.max(0, perlin - (1 - wfbm) * 0.5 + 0.25)); // Perlin-Worley
        const det = worley(x, y, z, 8, 21) * 0.625 + worley(x, y, z, 16, 22) * 0.25 + worley(x, y, z, 32, 23) * 0.125;
        const o = ((k * n + j) * n + i) * 4;
        data[o] = pw * 255;
        data[o + 1] = wfbm * 255;
        data[o + 2] = det * 255;
        data[o + 3] = 255;
      }
  const t = new THREE.Data3DTexture(data, n, n, n);
  t.format = THREE.RGBAFormat;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
varying vec2 vUv;
uniform mat4 uInvProj, uCamMonde;
uniform vec3 uCam, uSoleil, uCouleurSoleil, uCielHaut, uCielBas, uVent;
uniform sampler2D uCouv;
uniform sampler3D uBruit;
uniform vec2 uCouvOrigine; // coin nord-ouest de la grille météo, repère local (x, z)
uniform float uCouvTaille, uPas, uAleat, uLumiere, uBrumeDist;
uniform vec3 uBrume;

float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

vec3 couverture(vec3 p) {
  vec2 uv = (p.xz - uCouvOrigine) / uCouvTaille;
  return texture2D(uCouv, clamp(uv, 0.0, 1.0)).rgb;
}

// Densité d'une couche : forme Perlin-Worley découpée par la couverture réelle, érodée par le détail.
float densite(vec3 p, float bas, float haut, float cov, float echelle, float arrondi) {
  float h = clamp((p.y - bas) / (haut - bas), 0.0, 1.0);
  float profil = smoothstep(0.0, arrondi, h) * smoothstep(1.0, 0.55, h);
  if (cov < 0.01 || profil <= 0.0) return 0.0;
  vec3 q = (p + uVent) / echelle;
  vec4 n = texture(uBruit, q);
  float forme = remap(n.r, n.g - 1.0, 1.0, 0.0, 1.0) * profil;
  float c = clamp(cov * 1.05, 0.0, 1.0);
  forme = pow(forme, 0.85);
  float d = clamp(remap(forme, 1.0 - c, 1.0, 0.0, 1.0), 0.0, 1.0) * c;
  if (d <= 0.0) return 0.0;
  float det = texture(uBruit, q * 4.3 + vec3(0.0, uVent.x * 0.00002, 0.0)).b;
  d = clamp(remap(d, det * 0.35 * (1.0 - h * 0.5), 1.0, 0.0, 1.0), 0.0, 1.0);
  return d;
}

float champ(vec3 p) {
  vec3 cv = couverture(p);
  float d = 0.0;
  d += densite(p, 600.0, 2200.0, cv.r, 2600.0, 0.12) * 1.0;
  d += densite(p, 2800.0, 4600.0, cv.g, 4200.0, 0.3) * 0.55;
  d += densite(p, 7500.0, 8700.0, cv.b, 9000.0, 0.5) * 0.12;
  return d;
}

bool tranche(vec3 o, vec3 dir, float a, float b, out float t0, out float t1) {
  if (abs(dir.y) < 1e-4) { if (o.y < a || o.y > b) return false; t0 = 0.0; t1 = 60000.0; return true; }
  float ta = (a - o.y) / dir.y, tb = (b - o.y) / dir.y;
  t0 = max(min(ta, tb), 0.0); t1 = max(ta, tb);
  t1 = min(t1, 60000.0);
  return t1 > t0;
}

void main() {
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 v = uInvProj * ndc; v /= v.w;
  vec3 dir = normalize((uCamMonde * vec4(v.xyz, 0.0)).xyz);
  vec3 o = uCam;
  float t0, t1;
  if (!tranche(o, dir, 600.0, 8700.0, t0, t1)) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float cosT = dot(dir, uSoleil);
  float phase = mix(hg(cosT, 0.75), hg(cosT, -0.25), 0.35) * 4.0 * 3.14159;
  float T = 1.0;
  vec3 L = vec3(0.0);
  float tPremier = -1.0;
  float bruitPix = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); // bruit de gradient entrelacé (stable)
  float pas = max(uPas, (t1 - t0) / 64.0);
  float t = t0 + pas * bruitPix;
  for (int i = 0; i < 64; i++) {
    if (t > t1 || T < 0.02) break;
    vec3 p = o + dir * t;
    float d = champ(p);
    if (d > 0.002) {
      if (tPremier < 0.0) tPremier = t;
      // Lumière : 4 pas vers le soleil
      float dl = 0.0;
      for (int k = 1; k <= 4; k++) dl += champ(p + uSoleil * (float(k * k) * 90.0));
      float ext = d * 0.06 * pas;
      float lum = exp(-dl * 1.1) * mix(1.0, 1.0 - exp(-dl * 2.0), 0.45);
      float hRel = clamp((p.y - 600.0) / 2000.0, 0.0, 1.0);
      vec3 amb = mix(uCielBas * 0.7, uCielHaut, hRel * hRel) * 0.55;
      vec3 c = uCouleurSoleil * lum * phase * uLumiere * 3.2 + amb;
      float a = 1.0 - exp(-ext);
      L += T * a * c;
      T *= 1.0 - a;
    }
    t += pas;
  }
  // Perspective aérienne : les nuages lointains se fondent dans la brume
  if (tPremier > 0.0) {
    float f = 1.0 - exp(-tPremier / uBrumeDist);
    L = mix(L, uBrume * (1.0 - T), f);
  }
  gl_FragColor = vec4(L, T);
}`;

// Composition : dôme à l'infini, échantillonne la texture des nuages (lissée).
const COMPO_V = /* glsl */ `
varying vec4 vPos;
void main() { vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; vPos = gl_Position; }`;
const COMPO_F = /* glsl */ `
uniform sampler2D uNuages;
uniform vec2 uTexel;
varying vec4 vPos;
void main() {
  vec2 uv = vPos.xy / vPos.w * 0.5 + 0.5;
  // filtre doux 3×3 (efface le tramage du lancer de rayons à basse résolution)
  vec4 c = texture2D(uNuages, uv) * 0.25;
  c += (texture2D(uNuages, uv + vec2(uTexel.x, 0.0)) + texture2D(uNuages, uv - vec2(uTexel.x, 0.0)) + texture2D(uNuages, uv + vec2(0.0, uTexel.y)) + texture2D(uNuages, uv - vec2(0.0, uTexel.y))) * 0.125;
  c += (texture2D(uNuages, uv + uTexel) + texture2D(uNuages, uv - uTexel) + texture2D(uNuages, uv + vec2(uTexel.x, -uTexel.y)) + texture2D(uNuages, uv + vec2(-uTexel.x, uTexel.y))) * 0.0625;
  gl_FragColor = vec4(c.rgb, 1.0 - c.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Nuages {
  private rt: THREE.WebGLRenderTarget;
  private passe: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private scenePasse = new THREE.Scene();
  private camPasse = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly dome: THREE.Mesh;
  readonly ombre: THREE.Mesh;
  private couvTex: THREE.DataTexture;
  private ombreCanvas = document.createElement('canvas');
  private ombreTex: THREE.CanvasTexture;
  private vent = new THREE.Vector3();
  private etat: EtatMeteo | null = null;
  private derniereOmbre = 0;
  private reduction: number;

  constructor(private renderer: THREE.WebGLRenderer, mobile: boolean) {
    this.reduction = mobile ? 3 : 2;
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    this.couvTex = new THREE.DataTexture(new Uint8Array(N * N * 4), N, N, THREE.RGBAFormat);
    this.couvTex.magFilter = this.couvTex.minFilter = THREE.LinearFilter;
    const U = {
      uInvProj: { value: new THREE.Matrix4() }, uCamMonde: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() },
      uSoleil: { value: new THREE.Vector3(0, 1, 0) }, uCouleurSoleil: { value: new THREE.Color(1, 1, 1) },
      uCielHaut: { value: new THREE.Color(0.5, 0.6, 0.8) }, uCielBas: { value: new THREE.Color(0.7, 0.7, 0.7) },
      uVent: { value: this.vent }, uCouv: { value: this.couvTex }, uBruit: { value: texturesBruit(mobile ? 48 : 64) },
      uCouvOrigine: { value: new THREE.Vector2() }, uCouvTaille: { value: N * PAS_KM * 1000 },
      uPas: { value: mobile ? 140 : 100 }, uAleat: { value: 0 }, uLumiere: { value: 1 }, uBrumeDist: { value: 22000 }, uBrume: { value: new THREE.Color(0.7, 0.75, 0.8) },
    };
    this.passe = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: U, depthTest: false, depthWrite: false }));
    this.passe.frustumCulled = false;
    this.scenePasse.add(this.passe);

    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(7000, 32, 16),
      new THREE.ShaderMaterial({ vertexShader: COMPO_V, fragmentShader: COMPO_F, uniforms: { uNuages: { value: this.rt.texture }, uTexel: { value: new THREE.Vector2(0.01, 0.01) } }, side: THREE.BackSide, transparent: true, depthWrite: false, fog: false }),
    );
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;

    // Ombres des nuages au sol : écran invisible à 180 m qui ne fait que porter des ombres.
    this.ombreCanvas.width = this.ombreCanvas.height = 192;
    this.ombreTex = new THREE.CanvasTexture(this.ombreCanvas);
    this.ombre = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    this.ombre.rotation.x = -Math.PI / 2;
    this.ombre.castShadow = true;
    this.ombre.customDepthMaterial = new THREE.MeshDepthMaterial({ alphaMap: this.ombreTex, alphaTest: 0.5, depthPacking: THREE.RGBADepthPacking });
    this.ombre.frustumCulled = false;
  }

  /** Centre de la grille météo (adresse) en repère local : la grille est centrée sur l'origine. */
  majMeteo(e: EtatMeteo) {
    this.etat = e;
    const d = this.couvTex.image.data as Uint8Array;
    for (let k = 0; k < N * N; k++) for (let c = 0; c < 3; c++) d[k * 4 + c] = Math.round(e.couv[k * 3 + c]! * 255);
    this.couvTex.needsUpdate = true;
    const U = this.passe.material.uniforms;
    const L = N * PAS_KM * 1000;
    // texels centrés sur les points : coin = centre - (N/2)·pas
    (U.uCouvOrigine!.value as THREE.Vector2).set(-L / 2, -L / 2);
  }

  /** Lumière : direction (repère local), couleur du soleil et du ciel (linéaires, déjà à l'échelle de la scène). */
  majLumiere(dir: THREE.Vector3, couleurSoleil: THREE.Color, cielHaut: THREE.Color, cielBas: THREE.Color, brume: THREE.Color) {
    const U = this.passe.material.uniforms;
    (U.uSoleil!.value as THREE.Vector3).copy(dir).normalize();
    (U.uCouleurSoleil!.value as THREE.Color).copy(couleurSoleil);
    (U.uCielHaut!.value as THREE.Color).copy(cielHaut);
    (U.uCielBas!.value as THREE.Color).copy(cielBas);
    (U.uBrume!.value as THREE.Color).copy(brume);
  }

  /** Rend la texture des nuages. `secondes` = temps écoulé depuis minuit UTC : la dérive due au vent
   *  est déterministe (même date et heure → mêmes nuages au même endroit). */
  rendre(camera: THREE.PerspectiveCamera, secondes: number, centreOmbre: THREE.Vector3, soleilDir: THREE.Vector3) {
    if (this.etat) this.vent.set(-this.etat.ventE * secondes, 0, this.etat.ventN * secondes);
    const w = Math.max(64, Math.round(this.renderer.domElement.width / this.reduction));
    const h = Math.max(64, Math.round(this.renderer.domElement.height / this.reduction));
    if (this.rt.width !== w || this.rt.height !== h) {
      this.rt.setSize(w, h);
      ((this.dome.material as THREE.ShaderMaterial).uniforms.uTexel!.value as THREE.Vector2).set(1 / w, 1 / h);
    }
    const U = this.passe.material.uniforms;
    (U.uInvProj!.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (U.uCamMonde!.value as THREE.Matrix4).copy(camera.matrixWorld);
    (U.uCam!.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
    
    const avant = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scenePasse, this.camPasse);
    this.renderer.setRenderTarget(avant);
    this.dome.position.copy(camera.position);

    // Ombres au sol (mise à jour 4 fois par seconde)
    this.ombre.position.set(centreOmbre.x, centreOmbre.y + 180, centreOmbre.z);
    const t = performance.now();
    if (this.etat && t - this.derniereOmbre > 250) {
      this.derniereOmbre = t;
      this.dessinerOmbre(centreOmbre, soleilDir);
    }
  }

  private dessinerOmbre(c: THREE.Vector3, s: THREE.Vector3) {
    const n = this.ombreCanvas.width, ctx = this.ombreCanvas.getContext('2d')!;
    const img = ctx.createImageData(n, n);
    const L = N * PAS_KM * 1000;
    // L'ombre au sol vient du nuage situé à ~1300 m vers le soleil.
    const dec = s.y > 0.05 ? 1300 / s.y : 0;
    const sx = s.x * dec, sz = s.z * dec;
    const e = this.etat!;
    const couv = (x: number, z: number) => {
      const u = Math.min(N - 1.001, Math.max(0, ((x + L / 2) / L) * N - 0.5)), v = Math.min(N - 1.001, Math.max(0, ((z + L / 2) / L) * N - 0.5));
      const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
      const g = (a: number, b: number) => {
        const k = (b * N + a) * 3;
        return 1 - (1 - e.couv[k]!) * (1 - e.couv[k + 1]! * 0.7);
      };
      return (g(i, j) * (1 - fu) + g(i + 1, j) * fu) * (1 - fv) + (g(i, j + 1) * (1 - fu) + g(i + 1, j + 1) * fu) * fv;
    };
    const bruit = (x: number, z: number) => {
      // bruit de valeur 2D multi-octaves, cellules de ~400 m, dérivant avec le vent
      let a = 0, amp = 0.5, f = 1 / 420;
      for (let o = 0; o < 4; o++) {
        const X = (x + this.vent.x) * f, Z = (z + this.vent.z) * f;
        const xi = Math.floor(X), zi = Math.floor(Z), fx = X - xi, fz = Z - zi;
        const h = (p: number, q: number) => {
          let m = Math.imul(p * 374761393 + q * 668265263, 1274126177);
          m ^= m >>> 13;
          return ((Math.imul(m, 1274126177) >>> 0) % 1000) / 1000;
        };
        const u = fx * fx * (3 - 2 * fx), w = fz * fz * (3 - 2 * fz);
        a += amp * ((h(xi, zi) * (1 - u) + h(xi + 1, zi) * u) * (1 - w) + (h(xi, zi + 1) * (1 - u) + h(xi + 1, zi + 1) * u) * w);
        amp *= 0.5;
        f *= 2;
      }
      return a / 0.9375;
    };
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = c.x + ((i + 0.5) / n - 0.5) * 1800 + sx, z = c.z + ((j + 0.5) / n - 0.5) * 1800 + sz;
        const cv = couv(x, z);
        const v = bruit(x, z) < cv ? 255 : 0; // nuage au-dessus → ombre
        const o = (j * n + i) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
        img.data[o + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    this.ombreTex.needsUpdate = true;
  }
}

/** Transmission du soleil direct et facteur de diffus, à partir du rayonnement réel si disponible. */
export function transmission(e: EtatMeteo, elevationDeg: number): { direct: number; diffus: number; niveau: number; libelle: string } {
  const el = Math.max(0.5, elevationDeg);
  const am = 1 / (Math.sin((el * Math.PI) / 180) + 0.50572 * (el + 6.07995) ** -1.6364);
  const dniClair = 1361 * 0.7 ** (am ** 0.678);
  const dhiClair = 0.14 * dniClair * Math.sin((el * Math.PI) / 180) + 8;
  let direct: number, diffus: number;
  if (e.dni !== null && e.dhi !== null && elevationDeg > 3) {
    direct = Math.min(1, Math.max(0, e.dni / dniClair));
    diffus = Math.min(3.5, Math.max(0.25, e.dhi / dhiClair));
  } else {
    const tau = 4.5 * e.bas ** 1.5 + 2.2 * e.moyen ** 1.5 + 0.35 * e.haut;
    direct = Math.exp(-tau / Math.max(Math.sin((el * Math.PI) / 180), 0.08)) * (1 - 0.85 * e.bas ** 3);
    diffus = 1 + 1.6 * e.total - 1.3 * e.total ** 3;
  }
  // 25 niveaux (0 = grand ciel bleu, 24 = ciel bouché et sombre)
  const niveau = Math.max(0, Math.min(24, Math.round(e.total * 12 + (1 - direct) * 12)));
  const libelles = ['Grand ciel bleu', 'Ciel bleu, quelques voiles', 'Ciel bleu, rares nuages', 'Peu nuageux', 'Peu nuageux, soleil franc', 'Quelques nuages', 'Nuages épars', 'Belles éclaircies', 'Éclaircies', 'Partiellement nuageux', 'Mi-nuageux', 'Nuageux avec éclaircies', 'Nuageux, soleil par moments', 'Nuageux', 'Soleil voilé', 'Très voilé', 'Très nuageux', 'Très nuageux, rares trouées', 'Couvert clair', 'Couvert', 'Couvert épais', 'Ciel gris', 'Ciel gris et bas', 'Ciel bouché', 'Ciel bouché et sombre'];
  return { direct, diffus, niveau, libelle: libelles[niveau]! };
}
