import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh';
import { azimutDe, utcDepuisParis, versWgs84, type Adresse, type Batiment, type XY } from '@lumen/core';
import { Code, directionSoleil, positionSoleil } from '@lumen/analysis';
import { batimentsAutour, contient, COUCHES, geocoder, urlWms } from '@lumen/urban';
import type { Requete } from './worker';
import { initPlan2D } from './plan2d';
import { initStudio } from './studio3d';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const TZ = 'Europe/Paris';
const RAYON = 300;
const mobile = matchMedia('(pointer: coarse)').matches;

// ---------------------------------------------------------------------------
// Scène
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas: $<HTMLCanvasElement>('c'), antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.75 : 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9cc4ef, 500, 1400);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 6000);
camera.position.set(260, 320, 380);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 20;
controls.maxDistance = 1200;

const hemi = new THREE.HemisphereLight(0xdfeaff, 0x6b6258, 0.8);
const soleil = new THREE.DirectionalLight(0xfff1dc, 3);
soleil.castShadow = true;
soleil.shadow.mapSize.setScalar(mobile ? 2048 : 4096);
Object.assign(soleil.shadow.camera, { left: -330, right: 330, top: 330, bottom: -330, near: 10, far: 2500 });
soleil.shadow.bias = -0.0003;
soleil.shadow.normalBias = 0.8;
scene.add(hemi, soleil, soleil.target);

const fondSol = new THREE.Mesh(new THREE.CircleGeometry(4000, 64), new THREE.MeshLambertMaterial({ color: 0x6f6a62 }));
fondSol.rotation.x = -Math.PI / 2;
fondSol.position.y = -2;
scene.add(fondSol);

// Matériau du relief : orthophoto sur les surfaces horizontales, couleur de classe sur les murs.
const uniformes = { uPhoto: { value: 1 } };
const matRelief = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
matRelief.onBeforeCompile = (s) => {
  s.uniforms.uPhoto = uniformes.uPhoto;
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uPhoto;')
    .replace('#include <map_fragment>', '#ifdef USE_MAP\n vec3 photo = texture2D(map, vMapUv).rgb;\n#else\n vec3 photo = vec3(1.0);\n#endif')
    .replace('#include <color_fragment>', '')
    .replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
       float haut = inverseTransformDirection(normal, viewMatrix).y;
       vec3 dessus = mix(vColor * 1.08, photo, uPhoto);
       diffuseColor.rgb = mix(vColor * 0.9, dessus, smoothstep(0.45, 0.8, haut));`,
    );
};
let relief: THREE.Mesh | null = null;
let facades: THREE.Mesh | null = null;

// Façades : murs verticaux BD TOPO avec fenêtres procédurales (étages de 3 m), teinte variée par immeuble.
const matFacade = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
matFacade.defines = { USE_UV: '' };
matFacade.onBeforeCompile = (s) => {
  s.vertexShader = s.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float teinte;\nvarying float vTeinte;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTeinte = teinte;');
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vTeinte;')
    .replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
       vec3 pierre = mix(vec3(0.86, 0.80, 0.70), vec3(0.93, 0.89, 0.82), vTeinte);
       pierre = mix(pierre, vec3(0.78, 0.66, 0.58), step(0.85, vTeinte));
       float u = vUv.x / 3.1, v = vUv.y / 3.0;
       float fx = fract(u), fy = fract(v);
       float fenetre = step(0.32, fx) * step(fx, 0.68) * step(0.3, fy) * step(fy, 0.86) * step(1.0, v);
       float bandeau = step(0.92, fy) * 0.08;
       vec3 vitre = mix(vec3(0.09, 0.11, 0.14), vec3(0.35, 0.42, 0.5), smoothstep(0.3, 0.86, fy) * 0.5);
       diffuseColor.rgb = mix(pierre * (1.0 - bandeau), vitre, fenetre);
       roughnessFactor = mix(0.85, 0.15, fenetre);`,
    );
};

const overlay = new THREE.Group();
scene.add(overlay);

// Trajectoire du soleil
const trajet = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffd257, dashSize: 6, gapSize: 4, transparent: true, opacity: 0.8, fog: false }));
const disque = new THREE.Mesh(new THREE.SphereGeometry(7, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffe08a, fog: false }));
scene.add(trajet, disque);

function redim() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', redim);
redim();

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------
interface Terrain { bbox: [number, number, number, number]; n: number; mnt: Float32Array; nT: number; couverture: number; surf: Float32Array }
let adresse: Adresse | null = null;
let alt0 = 0;
let batiments: Batiment[] = [];
let terrain: Terrain | null = null;
let selBat: Batiment | null = null;
let facade: { a: XY; b: XY; normale: XY; azimut: number; point: XY } | null = null;
let etage = 2;
let vueFenetre = false;

const local = (p: XY, z: number) => new THREE.Vector3(p.x - adresse!.l93.x, z - alt0, -(p.y - adresse!.l93.y));
const versL93 = (v: THREE.Vector3): XY => ({ x: v.x + adresse!.l93.x, y: -v.z + adresse!.l93.y });

function solA(p: XY): number {
  if (!terrain) return alt0;
  const { bbox, nT, mnt } = terrain;
  const c = Math.floor((p.x - bbox[0]) / 2), r = Math.floor((bbox[3] - p.y) / 2);
  const z = mnt[Math.max(0, Math.min(nT - 1, r)) * nT + Math.max(0, Math.min(nT - 1, c))];
  return z !== undefined && Number.isFinite(z) ? z : alt0;
}

/** Altitude de la surface LiDAR (1 m) en un point. */
function surfA(p: XY): number {
  if (!terrain) return NaN;
  const { bbox, n, surf } = terrain;
  const res = (bbox[2] - bbox[0]) / n;
  const c = Math.floor((p.x - bbox[0]) / res), r = Math.floor((bbox[3] - p.y) / res);
  return c < 0 || r < 0 || c >= n || r >= n ? NaN : surf[r * n + c]!;
}
/** Hauteur max de la surface juste devant un point de façade (1,5 à 4 m). */
function devant(p: XY, nrm: XY): number {
  let m = -Infinity;
  for (const t of [1.5, 2.5, 3.5]) m = Math.max(m, surfA({ x: p.x + nrm.x * t, y: p.y + nrm.y * t }));
  return m;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const envoyer = (r: Requete) => worker.postMessage(r);
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'etape') chargement(m.texte);
  else if (m.type === 'erreur') {
    chargement(null);
    alerte(m.texte);
  } else if (m.type === 'pret') construireRelief(m);
  else if (m.type === 'progression') ($('barre').firstElementChild as HTMLElement).style.width = `${m.f * 100}%`;
  else if (m.type === 'resultat') afficherResultat(m);
};

function chargement(t: string | null) {
  $('chargement').hidden = !t;
  if (t) $('chargementTxt').textContent = t;
}
const alerte = (t: string) => ($('aide').textContent = t);

// ---------------------------------------------------------------------------
// Temps et soleil
// ---------------------------------------------------------------------------
const jour = $<HTMLInputElement>('jour');
const heure = $<HTMLInputElement>('heure');
jour.value = new Date().toISOString().slice(0, 10);
const hhmm = (d: Date) => d.toLocaleTimeString('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dateCourante = () => {
  const [y, m, d] = jour.value.split('-').map(Number) as [number, number, number];
  return new Date(utcDepuisParis(y, m - 1, d, +heure.value));
};
const lieu = () => adresse?.position ?? { lon: 2.35, lat: 48.85 };

function majSoleil() {
  const d = dateCourante();
  const s = positionSoleil(d, lieu());
  const [x, y, z] = directionSoleil(s);
  const c = vueFenetre ? new THREE.Vector3() : controls.target;
  soleil.position.set(c.x + x * 900, c.y + y * 900, c.z + z * 900);
  soleil.target.position.copy(c);
  soleil.target.updateMatrixWorld();
  const f = THREE.MathUtils.clamp(s.elevation / 12, 0, 1);
  soleil.intensity = s.elevation > -0.5 ? 0.3 + 2.9 * f : 0;
  soleil.color.setHSL(0.1, 0.9, 0.62 + 0.28 * f);
  hemi.intensity = 0.15 + 0.75 * f;
  const ciel = new THREE.Color().lerpColors(new THREE.Color(0x141b2d), new THREE.Color(0x9cc4ef), Math.max(0, Math.min(1, (s.elevation + 6) / 18)));
  scene.background = ciel;
  scene.fog!.color.copy(ciel);
  disque.position.set(x * 420, y * 420, z * 420);
  disque.visible = s.elevation > -1 && !vueFenetre;
  $('heureTxt').textContent = hhmm(d);
  $('soleilTxt').textContent = s.elevation > 0 ? `soleil à ${s.elevation.toFixed(0)}° · ${cardinal(s.azimut)}` : 'nuit';
}

function majTrajet() {
  const [y, m, d] = jour.value.split('-').map(Number) as [number, number, number];
  const pts: THREE.Vector3[] = [];
  for (let min = 0; min <= 1440; min += 6) {
    const s = positionSoleil(new Date(utcDepuisParis(y, m - 1, d, min)), lieu());
    if (s.elevation < -1) continue;
    const [a, b, c] = directionSoleil(s);
    pts.push(new THREE.Vector3(a * 420, b * 420, c * 420));
  }
  trajet.geometry.dispose();
  trajet.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  trajet.computeLineDistances();
}

heure.oninput = majSoleil;
jour.oninput = () => (majTrajet(), majSoleil());
document.querySelectorAll<HTMLButtonElement>('[data-date]').forEach((b) => {
  b.onclick = () => {
    jour.value = `${new Date().getFullYear()}-${b.dataset.date}`;
    jour.oninput!(new Event('input'));
  };
});
let lecture = false;
$('lecture').onclick = () => {
  lecture = !lecture;
  $('lecture').textContent = lecture ? '❚❚' : '▶';
};

// ---------------------------------------------------------------------------
// Recherche
// ---------------------------------------------------------------------------
const q = $<HTMLInputElement>('q');
const sugg = $<HTMLUListElement>('suggestions');
let minuteur = 0;
q.oninput = () => {
  clearTimeout(minuteur);
  if (q.value.trim().length < 3) return void (sugg.innerHTML = '');
  minuteur = window.setTimeout(async () => {
    const demande = q.value;
    const res = await geocoder(demande).catch(() => []);
    if (demande !== q.value || document.activeElement !== q) return;
    sugg.innerHTML = '';
    for (const a of res) {
      const li = document.createElement('li');
      li.textContent = a.label;
      li.onclick = () => charger(a);
      sugg.append(li);
    }
  }, 220);
};
$<HTMLFormElement>('recherche').onsubmit = async (e) => {
  e.preventDefault();
  const [a] = await geocoder(q.value, 1).catch(() => []);
  if (a) charger(a);
};

// ---------------------------------------------------------------------------
// Chargement du quartier
// ---------------------------------------------------------------------------
async function charger(a: Adresse) {
  clearTimeout(minuteur);
  sugg.innerHTML = '';
  q.value = a.label;
  q.blur();
  adresse = a;
  reinitialiserSelection();
  $('resultat').hidden = true;
  chargement('Bâtiments IGN…');
  try {
    batiments = await batimentsAutour(a.position, RAYON + 20);
  } catch (e) {
    chargement(null);
    return alerte((e as Error).message);
  }
  envoyer({ type: 'charger', centre: a.l93, rayon: RAYON, emprises: batiments.map((b) => b.contour) });
}

function construireRelief(m: { n: number; bbox: Terrain['bbox']; hauteurs: Float32Array; classes: Uint8Array; mnt: Float32Array; nT: number; couverture: number }) {
  terrain = { bbox: m.bbox, n: m.n, mnt: m.mnt, nT: m.nT, couverture: m.couverture, surf: m.hauteurs };
  alt0 = solA(adresse!.l93);
  const { n, bbox, hauteurs, classes } = m;
  const taille = bbox[2] - bbox[0];
  const geo = new THREE.PlaneGeometry(taille - taille / n, taille - taille / n, n - 1, n - 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(bbox[0] + taille / 2 - adresse!.l93.x, 0, -(bbox[1] + taille / 2 - adresse!.l93.y));
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const col = new Float32Array(n * n * 3);
  const teintes = [new THREE.Color(0x8d877d), new THREE.Color(0xe3d8c6), new THREE.Color(0x4f7a45)];
  for (let i = 0; i < n * n; i++) {
    pos.setY(i, hauteurs[i]! - alt0);
    const x = pos.getX(i) + adresse!.l93.x, y = -pos.getZ(i) + adresse!.l93.y;
    uv.setXY(i, (x - bbox[0]) / taille, (bbox[3] - y) / taille);
    teintes[classes[i]!]!.toArray(col, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundsTree();

  if (relief) {
    relief.geometry.dispose();
    scene.remove(relief);
  }
  relief = new THREE.Mesh(geo, matRelief);
  relief.castShadow = relief.receiveShadow = true;
  scene.add(relief);
  fondSol.position.y = solA({ x: bbox[0], y: bbox[1] }) - alt0 - 1;

  // Murs des immeubles
  const geos: THREE.BufferGeometry[] = [];
  const dedans = (p: XY) => p.x > bbox[0] && p.x < bbox[2] && p.y > bbox[1] && p.y < bbox[3];
  for (const b of batiments) {
    if (!b.contour.every(dedans) || b.hauteur.valeur < 2.5) continue;
    const cx = b.contour.reduce((s, p) => s + p.x, 0) / b.contour.length, cy = b.contour.reduce((s, p) => s + p.y, 0) / b.contour.length;
    const base = solA({ x: cx, y: cy });
    const forme = new THREE.Shape(b.contour.map((p) => new THREE.Vector2(p.x - adresse!.l93.x, p.y - adresse!.l93.y)));
    const g = new THREE.ExtrudeGeometry(forme, { depth: Math.max(2, b.altitudeSol.valeur + b.hauteur.valeur - base - 0.6), bevelEnabled: false });
    // v des murs = hauteur depuis le sol (m)
    const uvA = g.attributes.uv as THREE.BufferAttribute, posA = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uvA.count; i++) uvA.setY(i, posA.getZ(i));
    g.rotateX(-Math.PI / 2);
    g.translate(0, base - alt0, 0);
    let h = 0;
    for (const ch of b.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    g.setAttribute('teinte', new THREE.BufferAttribute(new Float32Array(posA.count).fill((h % 1000) / 1000), 1));
    geos.push(g);
  }
  if (facades) (facades.geometry.dispose(), scene.remove(facades));
  if (geos.length) {
    facades = new THREE.Mesh(mergeGeometries(geos), matFacade);
    facades.castShadow = facades.receiveShadow = true;
    scene.add(facades);
    geos.forEach((g) => g.dispose());
  }

  // Orthophoto IGN (~30 cm), décodée hors du fil principal.
  const indic = $('modePhoto');
  indic.textContent = 'Photo…';
  fetch(urlWms(COUCHES.ortho, bbox, 2048, 2048, 'image/jpeg'))
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b))
    .then((img) => {
      const t = new THREE.Texture(img);
      t.flipY = false;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      t.needsUpdate = true;
      matRelief.map?.dispose();
      matRelief.map = t;
      matRelief.needsUpdate = true;
    })
    .catch(() => {})
    .finally(() => (indic.textContent = 'Photo'));
  chargement(null);

  controls.target.set(0, 10, 0);
  camera.position.set(170, 230, 260);
  majTrajet();
  majSoleil();
  $('accueil').hidden = true;
  $('temps').hidden = $('etapeBat').hidden = false;
  $('outils').hidden = false;
  alerte(
    terrain.couverture < 0.9
      ? 'LiDAR partiel ici (zone non publiée par l’IGN) : précision réduite. Touche le mur de l’immeuble.'
      : 'Touche le mur de l’immeuble, à l’endroit de la fenêtre.',
  );
}

// ---------------------------------------------------------------------------
// Sélection de la façade
// ---------------------------------------------------------------------------
const cardinal = (az: number) => ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'][Math.round(az / 45) % 8]!;

interface Arete { d: number; a: XY; b: XY; t: number; nrm: XY; libre: boolean }
function aretes(b: Batiment, p: XY): Arete[] {
  const out: Arete[] = [];
  const toit = b.altitudeSol.valeur + b.hauteur.valeur;
  for (let i = 0; i < b.contour.length; i++) {
    const a = b.contour[i]!, c = b.contour[(i + 1) % b.contour.length]!;
    const dx = c.x - a.x, dy = c.y - a.y, l2 = dx * dx + dy * dy;
    if (l2 < 1) continue;
    const t = Math.max(0.1, Math.min(0.9, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const m = { x: a.x + t * dx, y: a.y + t * dy };
    const l = Math.sqrt(l2);
    let nrm = { x: dy / l, y: -dx / l };
    if (contient(b.contour, { x: m.x + nrm.x * 0.6, y: m.y + nrm.y * 0.6 })) nrm = { x: -nrm.x, y: -nrm.y };
    const libre = devant(m, nrm) < toit - 3; // mur mitoyen si l'espace devant est aussi haut que le toit
    out.push({ d: Math.hypot(m.x - p.x, m.y - p.y), a, b: c, t, nrm, libre });
  }
  return out.sort((u, v) => u.d - v.d);
}

function choisir(p: XY) {
  let bat = batiments.find((b) => contient(b.contour, p));
  if (!bat) {
    let best = Infinity;
    for (const b of batiments) {
      const e = aretes(b, p)[0];
      if (e && e.d < 4 && e.d < best) (best = e.d), (bat = b);
    }
  }
  if (!bat) return;
  const liste = aretes(bat, p);
  const ar = liste.find((e) => e.libre && e.d < liste[0]!.d + 12) ?? liste[0];
  if (!ar) return;
  selBat = bat;
  const mil = { x: ar.a.x + (ar.b.x - ar.a.x) * ar.t, y: ar.a.y + (ar.b.y - ar.a.y) * ar.t };
  facade = { a: ar.a, b: ar.b, normale: ar.nrm, azimut: azimutDe(ar.nrm.x, ar.nrm.y), point: mil };
  const etagesMax = Math.max(0, Math.floor(bat.hauteur.valeur / +$<HTMLSelectElement>('hEtage').value) - 1);
  etage = Math.min(etage, etagesMax);
  majSelection();
}

function reinitialiserSelection() {
  selBat = null;
  facade = null;
  overlay.clear();
  $('reglages').hidden = true;
  $('vueFenetre').hidden = true;
  $('infoBat').innerHTML = '';
  if (vueFenetre) basculerVue();
}

const matMur = new THREE.MeshBasicMaterial({ color: 0xffb000, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false });
const matFenetre = new THREE.MeshBasicMaterial({ color: 0xffd257, side: THREE.DoubleSide });
const matContour = new THREE.LineBasicMaterial({ color: 0xffd257 });

function pointFenetre() {
  const hE = +$<HTMLSelectElement>('hEtage').value;
  const f = facade!;
  const sol = solA({ x: f.point.x + f.normale.x * 2, y: f.point.y + f.normale.y * 2 });
  return { sol, z: sol + etage * hE + 1.4 };
}

function majSelection() {
  if (!selBat || !facade) return;
  overlay.clear();
  const b = selBat, f = facade;
  const sol = selBat.altitudeSol.valeur, toit = sol + b.hauteur.valeur;
  overlay.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(b.contour.map((p) => local(p, toit + 0.3))), matContour));
  // Mur sélectionné
  const off = { x: f.normale.x * 0.4, y: f.normale.y * 0.4 };
  const A = { x: f.a.x + off.x, y: f.a.y + off.y }, B = { x: f.b.x + off.x, y: f.b.y + off.y };
  const mur = new THREE.BufferGeometry().setFromPoints([local(A, sol), local(B, sol), local(B, toit), local(A, sol), local(B, toit), local(A, toit)]);
  overlay.add(new THREE.Mesh(mur, matMur));
  // Fenêtre
  const { z } = pointFenetre();
  const fen = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.6), matFenetre);
  const c = local({ x: f.point.x + f.normale.x * 0.5, y: f.point.y + f.normale.y * 0.5 }, z);
  fen.position.copy(c);
  fen.lookAt(c.clone().add(new THREE.Vector3(f.normale.x, 0, -f.normale.y)));
  overlay.add(fen);

  const hE = +$<HTMLSelectElement>('hEtage').value;
  const max = Math.max(0, Math.floor(b.hauteur.valeur / hE) - 1);
  $('etageTxt').textContent = etage === 0 ? 'RDC' : String(etage);
  $('infoBat').innerHTML =
    `<b>${b.usage ?? b.nature ?? 'Bâtiment'}</b>${b.nbLogements ? ` · ${b.nbLogements} logements` : ''} · ${b.hauteur.valeur.toFixed(1)} m` +
    ` <span class="doux">(${b.hauteur.source === 'mesure' ? `IGN, ±${b.hauteur.precision_m ?? '?'} m` : 'hauteur estimée'} · ~${max + 1} niveaux)</span>`;
  $('infoFacade').innerHTML = `Façade <b>${cardinal(f.azimut)}</b> (${f.azimut.toFixed(0)}°, déduit du cadastre IGN) · fenêtre à ${(z - pointFenetre().sol).toFixed(1)} m du sol (estimé)`;
  $('reglages').hidden = false;
  $('vueFenetre').hidden = false;
  const bouche = devant(f.point, f.normale) > z + 1;
  alerte(bouche ? '⚠ Juste devant cette fenêtre, il y a un mur ou un toit plus haut (mur mitoyen ?). Touche une autre façade ou monte d’étage.' : 'Règle l’étage puis lance le calcul.');
  if (vueFenetre) placerCameraFenetre();
}

$('moins').onclick = () => ((etage = Math.max(0, etage - 1)), majSelection());
$('plus').onclick = () => {
  const max = selBat ? Math.max(0, Math.floor(selBat.hauteur.valeur / +$<HTMLSelectElement>('hEtage').value) - 1) : 0;
  etage = Math.min(max, etage + 1);
  majSelection();
};
$('hEtage').onchange = majSelection;

// Toucher (sans glisser)
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;
let depart = { x: 0, y: 0, t: 0 };
renderer.domElement.addEventListener('pointerdown', (e) => (depart = { x: e.clientX, y: e.clientY, t: performance.now() }));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!relief || vueFenetre || Math.hypot(e.clientX - depart.x, e.clientY - depart.y) > 8 || performance.now() - depart.t > 500) return;
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const hit = ray.intersectObject(relief)[0];
  if (hit) choisir(versL93(hit.point));
});

// ---------------------------------------------------------------------------
// Vue depuis la fenêtre
// ---------------------------------------------------------------------------
const memo = { pos: new THREE.Vector3(), cible: new THREE.Vector3() };
function placerCameraFenetre() {
  const f = facade!;
  const { z } = pointFenetre();
  const p = local({ x: f.point.x + f.normale.x * 0.8, y: f.point.y + f.normale.y * 0.8 }, z);
  camera.position.copy(p);
  controls.target.copy(p.clone().add(new THREE.Vector3(f.normale.x, -0.02, -f.normale.y).multiplyScalar(0.5)));
}
function basculerVue() {
  vueFenetre = !vueFenetre;
  $('vueFenetre').classList.toggle('actif', vueFenetre);
  $('vueFenetre').textContent = vueFenetre ? '↩ Vue quartier' : '👁 Vue fenêtre';
  overlay.visible = trajet.visible = !vueFenetre;
  if (vueFenetre) {
    memo.pos.copy(camera.position);
    memo.cible.copy(controls.target);
    camera.fov = 70;
    controls.minDistance = 0.01;
    controls.maxPolarAngle = Math.PI;
    controls.enablePan = controls.enableZoom = false;
    controls.rotateSpeed = -0.35;
    placerCameraFenetre();
  } else {
    camera.fov = 45;
    controls.minDistance = 20;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.enablePan = controls.enableZoom = true;
    controls.rotateSpeed = 1;
    camera.position.copy(memo.pos);
    controls.target.copy(memo.cible);
  }
  camera.updateProjectionMatrix();
  majSoleil();
}
$('vueFenetre').onclick = basculerVue;

$('modePhoto').onclick = () => {
  uniformes.uPhoto.value = 1;
  $('modePhoto').classList.add('actif');
  $('modeMaquette').classList.remove('actif');
};
$('modeMaquette').onclick = () => {
  uniformes.uPhoto.value = 0;
  $('modeMaquette').classList.add('actif');
  $('modePhoto').classList.remove('actif');
};

// ---------------------------------------------------------------------------
// Calcul
// ---------------------------------------------------------------------------
$('calculer').onclick = () => {
  if (!facade || !adresse) return;
  const f = facade;
  const { z } = pointFenetre();
  const tangente = { x: -f.normale.y, y: f.normale.x };
  // 3 points sur la largeur de la fenêtre (1,2 m), à 1 m devant la façade (résolution LiDAR 50 cm).
  const points = [-0.5, 0, 0.5].map((s) => ({
    x: f.point.x + f.normale.x * 1.0 + tangente.x * s,
    y: f.point.y + f.normale.y * 1.0 + tangente.y * s,
    z,
  }));
  $<HTMLButtonElement>('calculer').disabled = true;
  $('barre').hidden = false;
  envoyer({ type: 'calculer', lieu: versWgs84(f.point), points, azimut: f.azimut, annee: new Date().getFullYear() });
};

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const COULEURS: Record<number, [number, number, number]> = {
  [Code.Rien]: [22, 28, 44],
  [Code.Soleil]: [255, 194, 26],
  [Code.OmbreBatiment]: [116, 130, 158],
  [Code.OmbreVegetation]: [84, 140, 78],
  [Code.OmbreRelief]: [150, 118, 92],
};
const hm = (min: number) => `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')}`;

function afficherResultat(r: { jours: number; creneaux: number; pasMinutes: number; codes: Uint8Array; ms: number }) {
  $<HTMLButtonElement>('calculer').disabled = false;
  $('barre').hidden = true;
  const annee = new Date().getFullYear();
  const { jours, creneaux, pasMinutes, codes } = r;
  const parJour: number[] = [];
  const total = [0, 0, 0, 0, 0];
  for (let j = 0; j < jours; j++) {
    let n = 0;
    for (let k = 0; k < creneaux; k++) {
      const c = codes[j * creneaux + k]!;
      total[c]!++;
      if (c === Code.Soleil) n++;
    }
    parJour.push(n * pasMinutes);
  }
  const debutMois = (m: number) => Math.round((Date.UTC(annee, m, 1) - Date.UTC(annee, 0, 1)) / 864e5);
  const moyMois = MOIS.map((_, m) => {
    const a = debutMois(m), b = m === 11 ? jours : debutMois(m + 1);
    return parJour.slice(a, b).reduce((s, x) => s + x, 0) / (b - a);
  });
  const moy = (ms: number[]) => ms.reduce((s, m) => s + moyMois[m]!, 0) / ms.length;
  const annuel = parJour.reduce((s, x) => s + x, 0) / 60;
  const masque = total[2]! + total[3]! + total[4]!;
  const part = (c: number) => (masque ? Math.round((total[c]! / (masque + total[1]!)) * 100) : 0);

  // Plages du 21 de chaque mois
  const plages = (j: number) => {
    const out: string[] = [];
    let d = -1;
    for (let k = 0; k <= creneaux; k++) {
      const s = k < creneaux && codes[j * creneaux + k] === Code.Soleil;
      if (s && d < 0) d = k;
      if (!s && d >= 0) {
        const f = (x: number) => `${String(Math.floor((x * pasMinutes) / 60)).padStart(2, '0')}:${String((x * pasMinutes) % 60).padStart(2, '0')}`;
        out.push(`${f(d)}–${f(k)}`);
        d = -1;
      }
    }
    return out.join(' · ') || 'pas de soleil direct';
  };
  const maxM = Math.max(1, ...moyMois);
  const res = $('resultat');
  res.hidden = false;
  res.innerHTML = `
    <h2>Ensoleillement direct de la fenêtre</h2>
    <div class="kpis">
      <div class="kpi"><b>${hm(moy([5, 6, 7]))}</b><span>par jour en été</span></div>
      <div class="kpi"><b>${hm(moy([11, 0, 1]))}</b><span>par jour en hiver</span></div>
      <div class="kpi"><b>${Math.round(annuel)} h</b><span>par an</span></div>
    </div>
    <h2>Chaque jour, chaque heure</h2>
    <canvas id="carte" width="${jours}" height="${(22 - 5) * (60 / pasMinutes)}"></canvas>
    <div class="axe">${MOIS.filter((_, i) => i % 2 === 0).map((m) => `<span>${m}</span>`).join('')}</div>
    <div class="legende"><span><i style="background:#ffc21a"></i>Soleil</span><span><i style="background:#74829e"></i>Bâtiments ${part(2)} %</span><span><i style="background:#548c4e"></i>Arbres ${part(3)} %</span><span><i style="background:#161c2c"></i>Nuit / soleil derrière la façade</span></div>
    <div class="doux">Axe vertical : de 5 h (haut) à 22 h (bas), heure de Paris.</div>
    <h2>Moyenne par jour et plages du 21</h2>
    <div class="mois">${MOIS.map((m, i) => `<span>${m}</span><div class="b" style="width:${(moyMois[i]! / maxM) * 100}%"></div><b>${hm(moyMois[i]!)}</b><div class="p">${plages(debutMois(i) + 20)}</div>`).join('')}</div>
    <div class="prov">Méthode : rayons tous les ${pasMinutes} min sur ${jours} jours, 3 points sur la largeur de la fenêtre, obstacles issus du MNS LiDAR HD IGN (50 cm : bâtiments réels, toits, arbres, relief). Arbres comptés comme opaques toute l'année. Étage et hauteur d'étage estimés. Calcul en ${(r.ms / 1000).toFixed(1)} s.</div>`;
  const cv = $<HTMLCanvasElement>('carte');
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(cv.width, cv.height);
  const k0 = (5 * 60) / pasMinutes;
  for (let j = 0; j < jours; j++)
    for (let y = 0; y < cv.height; y++) {
      const [R, G, B] = COULEURS[codes[j * creneaux + k0 + y]!]!;
      const i = (y * cv.width + j) * 4;
      img.data.set([R, G, B, 255], i);
    }
  ctx.putImageData(img, 0, 0);
  res.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------------------
// Feuille : réduite quand on manipule la 3D
// ---------------------------------------------------------------------------
const feuille = $('feuille');
renderer.domElement.addEventListener('pointerdown', () => feuille.classList.add('reduite'));
feuille.addEventListener('pointerdown', () => feuille.classList.remove('reduite'));

// ---------------------------------------------------------------------------
// Boucle
// ---------------------------------------------------------------------------
let avant = performance.now();
renderer.setAnimationLoop((t) => {
  if (document.body.classList.contains('studio')) return; // le Studio 3D a son propre rendu
  const dt = Math.min(0.1, (t - avant) / 1000);
  avant = t;
  if (lecture) {
    heure.value = String((+heure.value + dt * 90) % 1440);
    majSoleil();
  }
  controls.update();
  renderer.render(scene, camera);
});
majTrajet();
majSoleil();

// Diagnostic (tests automatisés)
(window as unknown as { __lumen: unknown }).__lumen = { facade: () => facade, fen: () => facade && pointFenetre(), adresse: () => adresse };

// Étape 1 : plan 2D du logement (indépendant de la 3D).
// Studio 3D : appartement 3D depuis plusieurs sources (plan 2D, RoomPlan, scan 3D, DXF).
let studio: ReturnType<typeof initStudio> | null = null;
const plan2d = initPlan2D({ voir3D: (p) => studio?.depuisPlan2D(p) });
studio = initStudio({ ouvrirPlan2D: () => plan2d.ouvrir() });
$('monPlan').onclick = plan2d.ouvrir;
$('studio3d').onclick = () => studio?.ouvrir();
