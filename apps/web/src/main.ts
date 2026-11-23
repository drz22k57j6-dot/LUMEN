import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh';
import { azimutDe, azimutVrai, utcDepuisParis, versWgs84, versL93 as wgsVersL93, type Adresse, type Batiment, type XY } from '@lumen/core';
import { Code, directionSoleil, eclairement, positionSoleil } from '@lumen/analysis';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { chargerMeteo, etatA, type GrilleMeteo } from './ciel/meteo';
import { Nuages, transmission } from './ciel/nuages';
import { batimentsAutour, contient, COUCHES, geocoder, tronconsAutour, urlWms, type Troncon, type Voirie } from '@lumen/urban';
import { creerVoirie3D, libererVoirie, masqueVoirie } from './voirie3d';
import { creerSolUrbain, orthoSol } from './sol3d';
import { adressesAutour, creerPlaques, type AdresseBan, type PanFacade } from './plaques';
import { creerHerbe, masqueHerbe, type Herbe } from './herbe';
import { catalogueMonuments, chargerMonuments, emprisesMonuments, empreinteModeles, libererMonuments, monumentsDans, remplace, type Monument } from './monuments';
import type { Requete } from './worker';
import { initPlan2D } from './plan2d';
import { creerForet, type Foret } from './arbres3d';
import { depuisParis, especeDuGenre, urlArbresParis, type Arbre, type ArbreParis } from '@lumen/vegetation';
import { initStudio } from './studio3d';
import { initCarte } from './carte2d';
import { Habillage, styleDe, type TacheFacade } from './habillage';

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
// Éclairage d'ambiance réaliste (reflets du zinc, des vitres et de la pierre).
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.3;
scene.fog = new THREE.Fog(0x9cc4ef, 1200, 4800);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 9000);
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

// Ciel physique (diffusion Rayleigh + Mie, modèle de Preetham) ; disque solaire à sa taille réelle (0,53°).
const ciel = new Sky();
ciel.scale.setScalar(8000);
{
  const U = ciel.material.uniforms;
  U.turbidity!.value = 2.8; // ciel clair urbain, cohérent avec les aérosols de eclairement()
  U.rayleigh!.value = 1;
  U.mieCoefficient!.value = 0.005;
  U.mieDirectionalG!.value = 0.8;
  U.uEchelle = { value: 0.48 };
  ciel.material.fragmentShader = 'uniform float uEchelle;\n' + ciel.material.fragmentShader.replace('gl_FragColor = vec4( retColor, 1.0 );', 'gl_FragColor = vec4( retColor * uEchelle, 1.0 );');
}
scene.add(ciel);
// Nuages volumétriques pilotés par la météo réelle (ou simulée hors période couverte).
const nuages = new Nuages(renderer, mobile);
scene.add(nuages.dome, nuages.ombre);
let meteo: GrilleMeteo | null = null;
let meteoCle = '';
/** Intensité three.js par lux : 100 000 lx de soleil → 3,2. Ratios direct / diffus / sol réels. */
const PAR_LUX = 3.2 / 100_000;

const fondSol = new THREE.Mesh(new THREE.CircleGeometry(4000, 64), new THREE.MeshLambertMaterial({ color: 0x6f6a62 }));
fondSol.rotation.x = -Math.PI / 2;
fondSol.position.y = -2;
scene.add(fondSol);

// Matériau du relief : orthophoto sur les surfaces horizontales, couleur de classe sur les murs.
const uniformes = { uPhoto: { value: 1 } };
function creerMatRelief() {
const matRelief = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, envMapIntensity: 0.3 });
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
return matRelief;
}
const matRelief = creerMatRelief();
const matLoin = creerMatRelief();

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
const disque = new THREE.Mesh(new THREE.SphereGeometry(420 * Math.tan(THREE.MathUtils.degToRad(0.2665)), 24, 16), new THREE.MeshBasicMaterial({ color: 0xffe08a, fog: false }));
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
interface Terrain { bbox: [number, number, number, number]; n: number; mnt: Float32Array; nT: number; couverture: number; surf: Float32Array; classes: Uint8Array }
let adresse: Adresse | null = null;
let alt0 = 0;
let batiments: Batiment[] = [];
let troncons: Troncon[] = [];
let voirie: THREE.Group | null = null;
let solUrbain: THREE.Mesh | null = null;
let herbe: Herbe | null = null;
let orthoProche: ImageBitmap | null = null;
let garderHerbe: ((p: XY) => boolean) | null = null;

/** Herbe 3D : dès que l'orthophoto et la voirie (masques) sont prêtes. */
function tenterHerbe() {
  if (herbe) (scene.remove(herbe.groupe), herbe.liberer(), (herbe = null));
  if (!terrain || !orthoProche || !garderHerbe || !adresse) return;
  const { masque, n } = masqueHerbe(orthoProche, terrain.bbox, garderHerbe);
  herbe = creerHerbe({ bbox: terrain.bbox, masque, nMasque: n, mnt: terrain.mnt, nT: terrain.nT, origine: adresse.l93, alt0, mobile });
  scene.add(herbe.groupe);
  majSoleil();
}
let monuments: Monument[] = [];
let groupeMonuments: THREE.Group | null = null;
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

/** Altitude du terrain (MNT 2 m) interpolée : la voirie épouse le relief sans marches. */
function solB(p: XY): number {
  if (!terrain) return alt0;
  const { bbox, nT, mnt } = terrain;
  const fx = (p.x - bbox[0]) / 2 - 0.5, fy = (bbox[3] - p.y) / 2 - 0.5;
  const c = Math.max(0, Math.min(nT - 2, Math.floor(fx))), r = Math.max(0, Math.min(nT - 2, Math.floor(fy)));
  const u = Math.max(0, Math.min(1, fx - c)), v = Math.max(0, Math.min(1, fy - r));
  const z = (i: number, j: number) => mnt[j * nT + i]!;
  const q = [z(c, r), z(c + 1, r), z(c, r + 1), z(c + 1, r + 1)];
  if (!q.every(Number.isFinite)) return solA(p);
  return (q[0]! * (1 - u) + q[1]! * u) * (1 - v) + (q[2]! * (1 - u) + q[3]! * u) * v;
}

function construireVoirie3D(v: Voirie) {
  if (voirie) (libererVoirie(voirie), scene.remove(voirie));
  voirie = creerVoirie3D(v, (p, dz) => local(p, solB(p) + dz), mobile);
  scene.add(voirie);
  // Le relief LiDAR (MNS) contient voitures, mobilier, bas des arbres : partout hors bâtiments on le passe
  // 15 cm sous le terrain nu (MNT). La voirie et le sol urbain (places, cours, parcs) le recouvrent.
  if (!terrain) return;
  const dans = masqueVoirie(v, terrain.bbox);
  const T = terrain;
  const classe = (p: XY) => {
    const i = Math.floor(p.x - T.bbox[0]), j = Math.floor(T.bbox[3] - p.y);
    return i < 0 || j < 0 || i >= T.n || j >= T.n ? 0 : T.classes[j * T.n + i]!;
  };
  for (const r of [relief, detail]) {
    if (!r) continue;
    const pos = r.geometry.attributes.position as THREE.BufferAttribute;
    let modifie = false;
    for (let i = 0; i < pos.count; i++) {
      const p = { x: pos.getX(i) + adresse!.l93.x, y: -pos.getZ(i) + adresse!.l93.y };
      if (!dans(p) && classe(p) === 1) continue;
      const sol = solB(p) - alt0 - 0.15;
      if (pos.getY(i) > sol) (pos.setY(i, sol), (modifie = true));
    }
    if (modifie) (pos.needsUpdate = true), r.geometry.computeVertexNormals();
  }
  if (solUrbain) (scene.remove(solUrbain), solUrbain.geometry.dispose(), (solUrbain.material as THREE.Material).dispose());
  solUrbain = creerSolUrbain({
    bbox: T.bbox,
    centre: adresse!.l93,
    garder: (p) => classe(p) !== 1, // passe aussi sous la voirie : aucun jour entre trottoir et place
    vers3: (p, dz) => local(p, solB(p) + dz),
    mobile,
  });
  scene.add(solUrbain);
  garderHerbe = (p) => !dans(p) && classe(p) !== 1;
  tenterHerbe();
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
  else if (m.type === 'voirie') construireVoirie3D(m.v);
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
  foret?.majSaison(d);
  const s = positionSoleil(d, lieu());
  const [x, y, z] = directionSoleil(s);
  const c = vueFenetre || vueRue ? camera.position : controls.target;
  soleil.position.set(c.x + x * 900, c.y + y * 900, c.z + z * 900);
  soleil.target.position.copy(c);
  soleil.target.updateMatrixWorld();
  // Lumière calculée à travers l'atmosphère (packages/analysis/lumiere.ts), aucun réglage à l'œil.
  const E = eclairement(s.elevation);
  const lin = THREE.LinearSRGBColorSpace;
  // Météo : nuages au bon endroit, et soleil / ciel atténués comme dans la réalité.
  const cleM = `${lieu().lat.toFixed(2)},${lieu().lon.toFixed(2)},${Math.floor(d.getTime() / 864e5)}`;
  if (cleM !== meteoCle) {
    meteoCle = cleM;
    void chargerMeteo(lieu(), d).then((g) => {
      if (meteoCle === cleM) (meteo = g), majSoleil();
    });
  }
  const em = meteo ? etatA(meteo, d.getTime()) : null;
  const tr = em ? transmission(em, s.elevation) : { direct: 1, diffus: 1, niveau: 0, libelle: '' };
  if (em) {
    nuages.majMeteo(em);
    $('meteoTxt').textContent = `${em.reel ? '☁' : '🎲'} ${Math.round(em.total * 100)} % · ${tr.libelle} (${tr.niveau}/24)${em.pluie > 0.2 ? ' · pluie' : ''}`;
    $('meteoTxt').title = em.source;
  }
  soleil.intensity = PAR_LUX * E.directNormal * tr.direct;
  soleil.color.setRGB(...E.couleurSoleil, lin);
  hemi.intensity = PAR_LUX * E.diffusHorizontal * tr.diffus;
  hemi.color.setRGB(...E.couleurCiel, lin);
  const sol = (0.18 * E.globalHorizontal) / Math.max(E.diffusHorizontal, 1e-6); // albédo urbain 0,18
  hemi.groundColor.setRGB(0.9 * sol, 0.85 * sol, 0.78 * sol, lin);
  scene.environmentIntensity = 0.3 * (E.diffusHorizontal / 16_700) * tr.diffus;
  // Exposition automatique, comme un appareil photo (limitée : la nuit reste la nuit).
  const globalReel = E.directNormal * tr.direct * Math.max(0, Math.sin((s.elevation * Math.PI) / 180)) + E.diffusHorizontal * tr.diffus;
  const expo = THREE.MathUtils.clamp(Math.sqrt(100_000 / Math.max(globalReel, 1e-3)), 1, 16);
  renderer.toneMappingExposure = 1.05 * expo;
  ciel.material.uniforms.sunPosition!.value.set(x, y, z);
  const brume = 0.86 * Math.min(1.2, (E.diffusHorizontal * expo) / 16_700);
  scene.fog!.color.setRGB(E.couleurCiel[0] * brume, E.couleurCiel[1] * brume, E.couleurCiel[2] * brume, lin);
  scene.background = null;
  if (em) {
    // Ciel couvert : brume plus grise et plus dense
    const gris = scene.fog!.color.r * 0.3 + scene.fog!.color.g * 0.59 + scene.fog!.color.b * 0.11;
    scene.fog!.color.lerp(new THREE.Color(gris, gris, gris), em.total * 0.8);
  }
  {
    const dir = new THREE.Vector3(x, y, z);
    herbe?.soleil(dir, soleil.color.clone().multiplyScalar(soleil.intensity), d.getMonth());
    const cs = new THREE.Color().setRGB(...E.couleurSoleil, lin).multiplyScalar(PAR_LUX * E.directNormal * 0.35 + 1e-4);
    const ch = new THREE.Color().setRGB(...E.couleurCiel, lin).multiplyScalar(PAR_LUX * E.diffusHorizontal * 1.2 * (0.6 + 0.4 * tr.diffus));
    const cb = ch.clone().multiplyScalar(0.55);
    nuages.majLumiere(dir, cs, ch, cb, scene.fog!.color);
  }
  (disque.material as THREE.MeshBasicMaterial).color.setRGB(...E.couleurSoleil, lin);
  disque.position.set(x * 420, y * 420, z * 420);
  disque.visible = s.elevation > -1 && !vueFenetre;
  const centreCiel = vueRue ? camera.position : new THREE.Vector3();
  disque.position.add(centreCiel);
  trajet.position.copy(centreCiel);
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
      li.onclick = () => choisirAdresse(a);
      sugg.append(li);
    }
  }, 220);
};
$<HTMLFormElement>('recherche').onsubmit = async (e) => {
  e.preventDefault();
  const [a] = await geocoder(q.value, 1).catch(() => []);
  if (a) choisirAdresse(a);
};

// ---------------------------------------------------------------------------
// Chargement du quartier
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Parcours : carte 2D → immeuble confirmé → plan → 3D
// ---------------------------------------------------------------------------
let adresseCarte: Adresse | null = null;
let batimentVise: Batiment | null = null;
const carte = initCarte({
  surSelection: (b) => {
    batimentVise = b;
    $<HTMLButtonElement>('ecOui').disabled = !b;
    $('ecInfo').textContent = b
      ? `${b.usage ?? b.nature ?? 'Bâtiment'} · ${b.hauteur.valeur.toFixed(0)} m${b.nbLogements ? ` · ${b.nbLogements} logement${b.nbLogements > 1 ? 's' : ''}` : ''}${b.nbEtages ? ` · ${b.nbEtages} étages` : ''}`
      : 'Aucun bâtiment trouvé ici : touche l’immeuble sur la carte.';
  },
});
function choisirAdresse(a: Adresse) {
  sugg.innerHTML = '';
  q.value = a.label;
  q.blur();
  if (!document.body.classList.contains('mode-carte')) return void charger(a);
  adresseCarte = a;
  $('accueil').hidden = true;
  $('etapeCarte').hidden = false;
  $('ecConfirmer').hidden = false;
  $('ecPlan').hidden = true;
  $('ecInfo').textContent = 'Recherche de l’immeuble…';
  void carte.aller(a);
}
function passer3D() {
  if (!adresseCarte) return;
  document.body.classList.remove('mode-carte');
  carte.montrer(false);
  redim();
  void charger(adresseCarte);
}
function retourCarte() {
  document.body.classList.add('mode-carte');
  carte.montrer(true);
}
$('ecOui').onclick = () => (($('ecConfirmer').hidden = true), ($('ecPlan').hidden = false));
$('ec3D').onclick = passer3D;
$('retourCarte').onclick = retourCarte;

async function charger(a: Adresse) {
  clearTimeout(minuteur);
  sugg.innerHTML = '';
  q.value = a.label;
  q.blur();
  adresse = a;
  reinitialiserSelection();
  $('resultat').hidden = true;
  chargement('Bâtiments IGN…');
  adressesBan = adressesAutour(a.position.lon, a.position.lat, RAYON).catch(() => []);
  try {
    let cat: Monument[];
    [batiments, troncons, cat] = await Promise.all([
      batimentsAutour(a.position, RAYON + 20),
      tronconsAutour(a.position, RAYON + 40).catch(() => [] as Troncon[]), // la voirie est un plus : jamais bloquante
      catalogueMonuments(),
    ]);
    monuments = monumentsDans(cat, [a.l93.x - RAYON, a.l93.y - RAYON, a.l93.x + RAYON, a.l93.y + RAYON]);
  } catch (e) {
    chargement(null);
    return alerte((e as Error).message);
  }
  envoyer({ type: 'charger', centre: a.l93, rayon: RAYON, rayonDetail: 150, rayonLoin: 2000, emprises: batiments.map((b) => b.contour) });
}

type Grille2 = { n: number; bbox: Terrain['bbox']; hauteurs: Float32Array; classes: Uint8Array };

/** Maillage d'une grille d'altitudes (sommets aux centres des cellules), UV sur l'orthophoto globale. */
function maillage(g: Grille2, bboxOrtho: Terrain['bbox'], basse?: (x: number, y: number) => boolean, mat = matRelief) {
  const { n, bbox, hauteurs, classes } = g;
  const taille = bbox[2] - bbox[0], tO = bboxOrtho[2] - bboxOrtho[0];
  const geo = new THREE.PlaneGeometry(taille - taille / n, taille - taille / n, n - 1, n - 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(bbox[0] + taille / 2 - adresse!.l93.x, 0, -(bbox[1] + taille / 2 - adresse!.l93.y));
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const col = new Float32Array(n * n * 3);
  const teintes = [new THREE.Color(0x8d877d), new THREE.Color(0xe3d8c6), new THREE.Color(0x4f7a45)];
  // sous un monument modélisé, le relief LiDAR (qui contient l'édifice) est ramené au sol (MNT)
  const dansMonument = emprisesMonuments(monuments, batiments);
  for (let i = 0; i < n * n; i++) {
    const x = pos.getX(i) + adresse!.l93.x, y = -pos.getZ(i) + adresse!.l93.y;
    pos.setY(i, basse?.(x, y) ? solA({ x, y }) - alt0 - 3 : (monuments.length && dansMonument({ x, y }) ? solA({ x, y }) : hauteurs[i]!) - alt0);
    uv.setXY(i, (x - bboxOrtho[0]) / tO, (bboxOrtho[3] - y) / tO);
    teintes[classes[i]!]!.toArray(col, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundsTree();
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = mat === matRelief;
  m.receiveShadow = true;
  return m;
}

/** Façades à habiller dans la zone de détail, calées sur le LiDAR HD :
 *  pour chaque mur, on lit le profil LiDAR (50 cm) perpendiculaire à la façade tous les 2 m,
 *  on y trouve la vraie ligne du mur (chute toit → sol) et la vraie hauteur de gouttière/corniche.
 *  La façade est posée exactement là, à cette hauteur ; seules les fenêtres sont générées. */
function tachesFacades(g: Grille2 & { brut: Float32Array }): TacheFacade[] {
  const zone = g.bbox;
  const zB = (x: number, y: number) => {
    const c = Math.floor((x - zone[0]) / 0.5), r = Math.floor((zone[3] - y) / 0.5);
    return c < 0 || r < 0 || c >= g.n || r >= g.n ? NaN : g.brut[r * g.n + c]!;
  };
  const mediane = (v: number[]) => (v.sort((a2, b2) => a2 - b2), v[Math.floor(v.length / 2)]!);
  const t: (TacheFacade & { d: number })[] = [];
  const dans = (p: XY) => p.x > zone[0] + 8 && p.x < zone[2] - 8 && p.y > zone[1] + 8 && p.y < zone[3] - 8;
  for (const b of batiments) {
    if (!b.contour.every(dans) || b.hauteur.valeur < 4 || remplace(monuments, b)) continue;
    const style = styleDe(b.id, b.hauteur.valeur);
    b.contour.forEach((p, i) => {
      const q2 = b.contour[(i + 1) % b.contour.length]!;
      const L = Math.hypot(q2.x - p.x, q2.y - p.y);
      if (L < 3.5) return;
      const dx = (q2.x - p.x) / L, dy = (q2.y - p.y) / L;
      const m = { x: (p.x + q2.x) / 2, y: (p.y + q2.y) / 2 };
      let nrm = { x: dy, y: -dx }, A = p, B = q2;
      if (contient(b.contour, { x: m.x + nrm.x * 0.6, y: m.y + nrm.y * 0.6 })) (nrm = { x: -dy, y: dx }), (A = q2), (B = p);
      const dist = Math.hypot(m.x - adresse!.l93.x, m.y - adresse!.l93.y);
      if (dist > 150) return;
      // Profils LiDAR perpendiculaires
      const decalages: number[] = [], gouttieres: number[] = [];
      for (let s2 = Math.min(1, L / 4); s2 <= L - Math.min(1, L / 4) + 1e-6; s2 += Math.max(1.2, Math.min(2, L / 4))) {
        const o = { x: A.x + ((B.x - A.x) / L) * s2, y: A.y + ((B.y - A.y) / L) * s2 };
        const sol = solA({ x: o.x + nrm.x * 3, y: o.y + nrm.y * 3 });
        // Hauteur de référence du toit (intérieur) puis ligne du mur = dernier point au niveau du toit
        // (les auvents, balcons et arbres, plus bas, ne déplacent pas le mur).
        let hr = 0;
        for (let k = -4; k <= -0.5; k += 0.5) hr = Math.max(hr, zB(o.x + nrm.x * k, o.y + nrm.y * k) - sol);
        if (!(hr > 3)) continue;
        const seuil = Math.max(2.5, hr * 0.6);
        let mur = NaN;
        for (let k = -4; k <= 4; k += 0.5) {
          const h = zB(o.x + nrm.x * k, o.y + nrm.y * k) - sol;
          if (h > seuil) mur = k;
          else if (Number.isFinite(mur) && h < seuil * 0.5) break;
        }
        if (!Number.isFinite(mur) || mur >= 4) continue; // pas de chute nette : mitoyen
        const h1 = zB(o.x + nrm.x * mur, o.y + nrm.y * mur), h2 = zB(o.x + nrm.x * (mur - 0.5), o.y + nrm.y * (mur - 0.5));
        decalages.push(mur + 0.25);
        gouttieres.push(Math.min(h1, Number.isFinite(h2) ? h2 : h1));
      }
      if (decalages.length < Math.max(1, Math.floor(L / 4))) return;
      const dec = mediane(decalages), gout = mediane(gouttieres);
      const A2 = { x: A.x + nrm.x * dec, y: A.y + nrm.y * dec }, B2 = { x: B.x + nrm.x * dec, y: B.y + nrm.y * dec };
      const m2 = { x: m.x + nrm.x * dec, y: m.y + nrm.y * dec };
      const base = solA({ x: m2.x + nrm.x * 1.5, y: m2.y + nrm.y * 1.5 });
      if (gout - base < 3) return;
      // Rue ou cour : espace dégagé sur au moins 5 m devant la façade.
      if (Math.max(zB(m2.x + nrm.x * 4, m2.y + nrm.y * 4), zB(m2.x + nrm.x * 5.5, m2.y + nrm.y * 5.5)) > gout - 2) return;
      const la = local(A2, 0), lb = local(B2, 0);
      t.push({ id: `${b.id}:${i}`, a: [la.x, la.z], b: [lb.x, lb.z], y: base - alt0, hGout: gout - base, style, lod: dist < (mobile ? 40 : 70) ? 0 : 1, d: dist });
    });
  }
  return t.sort((u, v) => u.d - v.d);
}

/** Ajuste le LiDAR autour des façades : sol juste derrière la façade (rien ne passe devant),
 *  puis relevé à la hauteur de gouttière jusqu'au vrai toit (pas de fente entre façade et toit). */
function abaisserSousFacades(g: Grille2, taches: TacheFacade[]) {
  const { n, bbox } = g;
  const cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const base0 = alt0 - 60;
  const px = (lx: number, lz: number) => [(lx + adresse!.l93.x - bbox[0]) / 0.5, (bbox[3] - (adresse!.l93.y - lz)) / 0.5] as const;
  const bande = (t: TacheFacade, de: number, a2: number) => {
    const [ax, az] = t.a, [bx, bz] = t.b;
    const W = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / W, dz = (bz - az) / W;
    const nx = -dz, nz = dx; // normale sortante
    const pts = [px(ax + nx * de, az + nz * de), px(bx + nx * de, bz + nz * de), px(bx + nx * a2, bz + nz * a2), px(ax + nx * a2, az + nz * a2)];
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.fill();
  };
  for (const t of taches) {
    const v = Math.max(2, Math.min(255, Math.round(t.y + alt0 + t.hGout - base0)));
    ctx.fillStyle = `rgb(${v},0,0)`;
    bande(t, -0.5, -2.5);
  }
  ctx.fillStyle = 'rgb(1,0,0)';
  for (const t of taches) bande(t, 1.5, -0.5);
  const d = ctx.getImageData(0, 0, n, n).data;
  for (let i = 0; i < n * n; i++) {
    const v = d[i * 4]!;
    if (!v || d[i * 4 + 3]! === 0) continue; // pixels de bord inclus : sinon des pics LiDAR restent devant la façade
    const x = bbox[0] + ((i % n) + 0.5) * 0.5, y = bbox[3] - (Math.floor(i / n) + 0.5) * 0.5;
    if (v === 1) {
      g.hauteurs[i] = solA({ x, y });
      g.classes[i] = 0;
    } else {
      const gout = base0 + v;
      if (g.hauteurs[i]! < gout) (g.hauteurs[i] = gout), (g.classes[i] = 1);
    }
  }
}

/** Le LiDAR « bâtiment » hors des emprises IGN (élargies de 1 m) est ramené au sol :
 *  supprime les rideaux en dents de scie (marches du raster 50 cm) le long des murs. */
function nettoyerBords(g: Grille2) {
  const { n, bbox } = g;
  const cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2; // 1 m de marge autour de chaque emprise
  ctx.lineJoin = 'round';
  for (const b of batiments) {
    ctx.beginPath();
    b.contour.forEach((p, k) => { const x = (p.x - bbox[0]) / 0.5, y = (bbox[3] - p.y) / 0.5; if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  const d = ctx.getImageData(0, 0, n, n).data;
  for (let i = 0; i < n * n; i++) {
    if (g.classes[i] !== 1 || d[i * 4 + 3]! > 0) continue;
    const x = bbox[0] + ((i % n) + 0.5) * 0.5, y = bbox[3] - (Math.floor(i / n) + 0.5) * 0.5;
    g.hauteurs[i] = solA({ x, y });
    g.classes[i] = 0;
  }
}

// ---------------------------------------------------------------------------
// Arbres (moteur Végétation)
// ---------------------------------------------------------------------------
let foret: Foret | null = null;
let arbres: Arbre[] = [];
function aplanirVegetation(g: Grille2) {
  const { n, bbox } = g, res = (bbox[2] - bbox[0]) / n;
  for (let i = 0; i < n * n; i++) {
    if (g.classes[i] !== 2) continue;
    g.hauteurs[i] = solA({ x: bbox[0] + ((i % n) + 0.5) * res, y: bbox[3] - (Math.floor(i / n) + 0.5) * res });
    g.classes[i] = 0;
  }
}
function afficherForet(liste: Arbre[]) {
  if (foret) (foret.liberer(), scene.remove(foret.groupe));
  arbres = liste;
  const c = adresse!.l93;
  foret = creerForet(liste, (a) => local(a.p, solA(a.p)), (a) => Math.hypot(a.p.x - c.x, a.p.y - c.y), mobile ? 60 : 130);
  foret.majSaison(dateCourante());
  scene.add(foret.groupe);
}
/** Arbres : uniquement l'inventaire officiel de la Ville de Paris (« Les arbres », open data),
 *  positions, espèces et hauteurs telles que publiées. Aucune autre source, aucune correction. */
function planterArbres(bbox: Terrain['bbox']) {
  const dedans = (p: XY) => p.x > bbox[0] && p.x < bbox[2] && p.y > bbox[1] && p.y < bbox[3];
  afficherForet([]);
  const a = adresse!, { lon, lat } = a.position;
  if (lon < 2.2 || lon > 2.48 || lat < 48.8 || lat > 48.92) return; // inventaire disponible : Paris
  fetch(urlArbresParis(lon, lat, RAYON * 1.2))
    .then((r) => (r.ok ? r.json() : []))
    .then((liste: ArbreParis[]) => {
      if (adresse !== a) return;
      afficherForet(liste.map((x) => depuisParis(x, (lo, la) => wgsVersL93({ lon: lo, lat: la }))).filter((x): x is Arbre => !!x && dedans(x.p)));
    })
    .catch(() => undefined);
}

let detail: THREE.Mesh | null = null;

// Plaques de rue et numéros (BAN + BD TOPO), posés sur les façades visibles.
let adressesBan: Promise<AdresseBan[]> = Promise.resolve([]);
let plaques: THREE.Group | null = null;
async function poserPlaques(taches: TacheFacade[], zD: Terrain['bbox']) {
  const a = adresse!;
  const adr = await adressesBan;
  if (adresse !== a) return;
  const pans: PanFacade[] = taches.map((t) => {
    const A = versL93(new THREE.Vector3(t.a[0], 0, t.a[1])), B = versL93(new THREE.Vector3(t.b[0], 0, t.b[1]));
    const L = Math.hypot(B.x - A.x, B.y - A.y) || 1;
    // normale sortante du générateur (-dz, dx) en repère local → (est, nord)
    const dx = (t.b[0] - t.a[0]) / L, dz = (t.b[1] - t.a[1]) / L;
    return { a: A, b: B, n: { x: -dz, y: -dx }, sol: t.y + alt0 };
  });
  // Hors zone de détail : les murs BD TOPO sont les façades affichées.
  const dansD = (p: XY) => p.x > zD[0] && p.x < zD[2] && p.y > zD[1] && p.y < zD[3];
  for (const b of batiments) {
    if (b.contour.every(dansD) || b.hauteur.valeur < 3) continue;
    b.contour.forEach((p, i) => {
      const q = b.contour[(i + 1) % b.contour.length]!;
      const L = Math.hypot(q.x - p.x, q.y - p.y);
      if (L < 2) return;
      let n = { x: (q.y - p.y) / L, y: -(q.x - p.x) / L };
      const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      if (contient(b.contour, { x: m.x + n.x * 0.5, y: m.y + n.y * 0.5 })) n = { x: -n.x, y: -n.y };
      pans.push({ a: p, b: q, n, sol: solB({ x: m.x + n.x * 1.5, y: m.y + n.y * 1.5 }) });
    });
  }
  if (plaques) (scene.remove(plaques), plaques.traverse((o) => o instanceof THREE.Mesh && (o.geometry.dispose(), (o.material as THREE.MeshStandardMaterial).dispose())));
  plaques = creerPlaques({ adresses: adr, troncons, pans, local, centre: a.l93, rayon: RAYON, aniso: renderer.capabilities.getMaxAnisotropy() });
  scene.add(plaques);
}
let loin: THREE.Mesh | null = null;

/** Zone lointaine (2 km) : LiDAR à 8 m + orthophoto, creusée sous la zone à 1 m. */
function construireLoin(m: Grille2) {
  if (!terrain || !adresse) return;
  if (loin) (loin.geometry.dispose(), scene.remove(loin));
  const z = terrain.bbox;
  loin = maillage(m, m.bbox, (x, y) => x > z[0] + 8 && x < z[2] - 8 && y > z[1] + 8 && y < z[3] - 8, matLoin);
  scene.add(loin);
  fetch(urlWms(COUCHES.ortho, m.bbox, 2048, 2048, 'image/jpeg'))
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b))
    .then((img) => {
      const t = new THREE.Texture(img);
      t.flipY = false;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      t.needsUpdate = true;
      matLoin.map?.dispose();
      matLoin.map = t;
      matLoin.needsUpdate = true;
    })
    .catch(() => {});
}
const habillage = new Habillage(import.meta.env.BASE_URL + 'tex/');
scene.add(habillage.groupe);

function construireRelief(m: Grille2 & { mnt: Float32Array; nT: number; couverture: number; detail: Grille2 & { brut: Float32Array } }) {
  terrain = { bbox: m.bbox, n: m.n, mnt: m.mnt, nT: m.nT, couverture: m.couverture, surf: m.hauteurs, classes: m.classes };
  alt0 = solA(adresse!.l93);
  const { bbox } = m;
  const zD = m.detail.bbox;
  for (const r of [relief, detail]) if (r) (r.geometry.dispose(), scene.remove(r));
  // Large zone à 1 m, creusée là où la zone de détail à 50 cm prend le relais.
  // Végétation du LiDAR ramenée au sol : les arbres viennent uniquement de l'inventaire de la Ville de Paris.
  const dansD = (p: XY) => p.x > zD[0] && p.x < zD[2] && p.y > zD[1] && p.y < zD[3];
  void dansD;
  aplanirVegetation(m);
  aplanirVegetation(m.detail);
  planterArbres(bbox);
  relief = maillage(m, bbox, (x, y) => x > zD[0] + 1 && x < zD[2] - 1 && y > zD[1] + 1 && y < zD[3] - 1);
  const taches = tachesFacades(m.detail);
  (window as unknown as { __taches: unknown }).__taches = taches;
  abaisserSousFacades(m.detail, taches);
  nettoyerBords(m.detail);
  detail = maillage(m.detail, bbox);
  scene.add(relief, detail);
  habillage.lancer(taches);
  void poserPlaques(taches, zD);
  fondSol.position.y = solA({ x: bbox[0], y: bbox[1] }) - alt0 - 1;

  // Murs des immeubles
  const geos: THREE.BufferGeometry[] = [];
  const dedans = (p: XY) => p.x > bbox[0] && p.x < bbox[2] && p.y > bbox[1] && p.y < bbox[3];
  for (const b of batiments) {
    if (!b.contour.every(dedans) || b.hauteur.valeur < 2.5 || remplace(monuments, b)) continue;
    if (b.contour.every((p) => p.x > zD[0] && p.x < zD[2] && p.y > zD[1] && p.y < zD[3])) continue; // zone de détail : LiDAR 50 cm + façades générées
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

  // Monuments modélisés (Open Landmarks), à leur position et altitude réelles.
  if (groupeMonuments) (libererMonuments(groupeMonuments), scene.remove(groupeMonuments), (groupeMonuments = null));
  if (monuments.length) {
    const ici = adresse;
    chargerMonuments(monuments, (p, z) => local(p, z), mobile).then((g) => {
      if (adresse !== ici) return libererMonuments(g);
      groupeMonuments = g;
      scene.add(g);
      // relief LiDAR ramené au sol sous l'empreinte réelle des modèles (portiques, marches, colonnes compris)
      const sous = empreinteModeles(g);
      for (const r of [relief, detail]) {
        if (!r) continue;
        const pos = r.geometry.attributes.position as THREE.BufferAttribute;
        let modifie = false;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), z = pos.getZ(i);
          if (!sous(x, z)) continue;
          const sol = solA({ x: x + adresse!.l93.x, y: -z + adresse!.l93.y }) - alt0;
          if (pos.getY(i) > sol) (pos.setY(i, sol), (modifie = true));
        }
        if (modifie) (pos.needsUpdate = true), r.geometry.computeVertexNormals();
      }
    });
  }

  // Voirie (chaussée, trottoirs, bordures, marquages), calculée dans le worker.
  if (troncons.length) envoyer({ type: 'voirie', troncons, batiments, emprise: bbox });

  // Orthophoto IGN (~30 cm), décodée hors du fil principal.
  const indic = $('modePhoto');
  indic.textContent = 'Photo…';
  orthoProche = null;
  garderHerbe = null;
  fetch(urlWms(COUCHES.ortho, bbox, 2048, 2048, 'image/jpeg'))
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b))
    .then((img) => {
      orthoProche = img;
      tenterHerbe();
      const t = new THREE.Texture(img);
      t.flipY = false;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      t.needsUpdate = true;
      matRelief.map?.dispose();
      matRelief.map = t;
      orthoSol(t);
      matRelief.needsUpdate = true;
    })
    .catch(() => {})
    .finally(() => (indic.textContent = 'Photo'));
  chargement(null);

  $('vueRue').hidden = false;
  entrerRue();
  if (batimentVise) {
    const bv = batimentVise;
    const b2 = batiments.find((b) => b.id === bv.id);
    if (b2) setTimeout(() => choisir(contient(b2.contour, adresse!.l93) ? adresse!.l93 : b2.contour[0]!), 0);
  }
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
  facade = { a: ar.a, b: ar.b, normale: ar.nrm, azimut: azimutVrai(azimutDe(ar.nrm.x, ar.nrm.y), adresse!.position.lon), point: mil };
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
    `<b>${b.usage ?? b.nature ?? 'Bâtiment'}</b>${b.nbLogements ? ` · ${b.nbLogements} logement${b.nbLogements > 1 ? 's' : ''}` : ''} · ${b.hauteur.valeur.toFixed(1)} m` +
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
  const hit = ray.intersectObjects([detail, relief, habillage.groupe].filter(Boolean) as THREE.Object3D[], true)[0];
  if (!hit) return;
  const p = versL93(hit.point);
  const sol = hit.point.y + alt0 - solA(p) < 0.6 && (hit.face?.normal.y ?? 0) > 0.6;
  if (vueRue && sol) {
    // Marcher jusqu'au point touché (en gardant la direction du regard).
    const dir = new THREE.Vector3().subVectors(controls.target, camera.position);
    placerPieton(p, { x: dir.x, y: -dir.z });
  } else choisir(p);
});

// ---------------------------------------------------------------------------
// Vue piéton (dans la rue, à 2 m du sol)
// ---------------------------------------------------------------------------
let vueRue = false;
function regles(pieton: boolean) {
  camera.fov = pieton ? 70 : 45;
  controls.minDistance = pieton ? 0.01 : 20;
  controls.maxPolarAngle = pieton ? Math.PI : Math.PI * 0.47;
  controls.enablePan = controls.enableZoom = !pieton;
  controls.rotateSpeed = pieton ? -0.35 : 1;
  camera.updateProjectionMatrix();
}
/** Place le piéton en p (L93), regard horizontal vers la direction donnée. */
function placerPieton(p: XY, regard: XY) {
  const c = local(p, solA(p) + 2);
  const l = Math.hypot(regard.x, regard.y) || 1;
  camera.position.copy(c);
  controls.target.copy(c.clone().add(new THREE.Vector3(regard.x / l, 0.18, -regard.y / l).multiplyScalar(0.5)));
  controls.update();
  majSoleil();
}
/** Point de rue le plus proche de l'adresse (sol dégagé, hors bâtiment). */
function pointDeRue(a: XY): XY {
  for (let r = 0; r <= 60; r += 1)
    for (let k = 0; k < (r ? 24 : 1); k++) {
      const an = (k / 24) * Math.PI * 2;
      const q2 = { x: a.x + Math.cos(an) * r, y: a.y + Math.sin(an) * r };
      if (surfA(q2) - solA(q2) < 0.8 && !batiments.some((b) => contient(b.contour, q2))) return q2;
    }
  return a;
}
function entrerRue() {
  if (!adresse) return;
  if (vueFenetre) basculerVue();
  vueRue = true;
  regles(true);
  // Point de rue devant l'adresse, puis on recule vers le milieu de la rue (max 7 m) pour voir la façade.
  const a = adresse.l93;
  const q0 = pointDeRue(a);
  let u = { x: q0.x - a.x, y: q0.y - a.y };
  const lu = Math.hypot(u.x, u.y);
  if (lu < 0.1) u = { x: 0, y: -1 };
  else u = { x: u.x / lu, y: u.y / lu };
  let t = 0;
  while (t < 30) {
    const q2 = { x: q0.x + u.x * (t + 0.5), y: q0.y + u.y * (t + 0.5) };
    if (surfA(q2) - solA(q2) > 2) break;
    t += 0.5;
  }
  const p = { x: q0.x + u.x * Math.min(t / 2, 7), y: q0.y + u.y * Math.min(t / 2, 7) };
  // Regard vers l'immeuble, légèrement de biais pour voir la rue en perspective.
  const an = 1.0, rx = -u.x, ry = -u.y;
  placerPieton(p, { x: rx * Math.cos(an) - ry * Math.sin(an), y: rx * Math.sin(an) + ry * Math.cos(an) });
  $('vueRue').textContent = '🛩 Vue aérienne';
  majSoleil();
}
function sortirRue() {
  vueRue = false;
  regles(false);
  $('vueRue').hidden = false;
  entrerRue();
  if (batimentVise) {
    const bv = batimentVise;
    const b2 = batiments.find((b) => b.id === bv.id);
    if (b2) setTimeout(() => choisir(contient(b2.contour, adresse!.l93) ? adresse!.l93 : b2.contour[0]!), 0);
  }
  $('vueRue').textContent = '🚶 Vue rue';
  majSoleil();
}
$('vueRue').onclick = () => (vueRue ? sortirRue() : entrerRue());

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
    regles(true);
    placerCameraFenetre();
  } else {
    regles(vueRue);
    camera.position.copy(memo.pos);
    controls.target.copy(memo.cible);
  }
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
    x: f.point.x + f.normale.x * 0.3 + tangente.x * s,
    y: f.point.y + f.normale.y * 0.3 + tangente.y * s,
    z,
  }));
  $<HTMLButtonElement>('calculer').disabled = true;
  $('barre').hidden = false;
  const especes: Record<string, number> = {};
  for (const ar of arbres) if (Math.hypot(ar.p.x - f.point.x, ar.p.y - f.point.y) < 80) especes[ar.espece] = (especes[ar.espece] ?? 0) + 1;
  envoyer({ type: 'calculer', lieu: versWgs84(f.point), points, azimut: f.azimut, annee: new Date().getFullYear(), especes });
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
    <div class="prov">Méthode : rayons tous les ${pasMinutes} min sur ${jours} jours, 3 points sur la largeur de la fenêtre, obstacles issus du MNS LiDAR HD IGN (50 cm : bâtiments réels, toits, arbres, relief). Arbres semi-transparents selon la saison et l'espèce (feuillage, branches nues en hiver). Étage et hauteur d'étage estimés. Calcul en ${(r.ms / 1000).toFixed(1)} s.</div>`;
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
let interaction = false;
controls.addEventListener('start', () => (interaction = true));
controls.addEventListener('end', () => (interaction = false));
let dureeHab = 0;
renderer.setAnimationLoop((t) => {
  herbe?.maj(camera, t);
  ciel.position.copy(camera.position);
  if (document.body.classList.contains('studio')) return; // le Studio 3D a son propre rendu
  const dt = Math.min(0.1, (t - avant) / 1000);
  avant = t;
  if (lecture) {
    heure.value = String((+heure.value + dt * 90) % 1440);
    majSoleil();
  }
  const tH = performance.now();
  habillage.etape(interaction ? (mobile ? 6 : 10) : mobile ? 22 : 30);
  dureeHab += performance.now() - tH;
  const p = habillage.progression;
  const ft = $('facadesTxt');
  ft.hidden = p >= 1;
  if (p < 1) ft.textContent = `Façades ${Math.round(p * 100)} %`;
  controls.update();
  {
    const dC = dateCourante();
    const sec = (dC.getTime() % 864e5) / 1000;
    const cO = vueFenetre || vueRue ? camera.position : controls.target;
    camera.updateMatrixWorld();
    nuages.rendre(camera, sec, cO, soleil.position.clone().sub(soleil.target.position).normalize());
  }
  renderer.render(scene, camera);
});
majTrajet();
majSoleil();

// Diagnostic (tests automatisés) — exposé seulement en mode développeur (voir plus bas)
const diagnostic = { bb: () => { const b = new THREE.Box3().setFromObject(habillage.groupe); return [b.min.toArray(), b.max.toArray()]; }, cam: (p: number[], t: number[]) => (camera.position.set(p[0]!, p[1]!, p[2]!), controls.target.set(t[0]!, t[1]!, t[2]!)), hab: () => ({ ms: Math.round(dureeHab), fait: habillage.fait, p: habillage.progression, meshes: habillage.groupe.children.length }), facade: () => facade, fen: () => facade && pointFenetre(), adresse: () => adresse };

// Étape 1 : plan 2D du logement (indépendant de la 3D).
// Studio 3D : appartement 3D depuis plusieurs sources (plan 2D, RoomPlan, scan 3D, DXF).
let studio: ReturnType<typeof initStudio> | null = null;
const plan2d = initPlan2D({ voir3D: (p) => studio?.depuisPlan2D(p) });
$('ecDessin').onclick = () => plan2d.ouvrir();
$('ecImage').onclick = () => {
  plan2d.ouvrir();
  document.getElementById('edImport')?.click();
};
$('ecScan').onclick = () => studio?.ouvrir();
studio = initStudio({ ouvrirPlan2D: () => plan2d.ouvrir() });
$('monPlan').onclick = plan2d.ouvrir;
$('studio3d').onclick = () => studio?.ouvrir();

// Mode développeur (temporaire) : présent seulement si le site est construit avec VITE_MODE_DEV=1.
// Sans ce réglage, cette branche et tout le dossier src/dev/ disparaissent du site publié.
if (import.meta.env.VITE_MODE_DEV === '1')
  void import('./dev/panneau').then((m) =>
    m.installerModeDev({
      scene, camera, renderer, controls,
      // Ouvre directement le monde 3D (en sautant la carte 2D d'accueil)
      charger: (a) => { document.body.classList.remove('mode-carte'); carte.montrer(false); $('accueil').hidden = true; $('etapeCarte').hidden = true; redim(); return charger(a); },
      carte2D: () => retourCarte(),
      ouvrirStudio: () => studio?.ouvrir(), ouvrirPlan: () => plan2d.ouvrir(),
      etat: () => ({ adresse: adresse?.label, batiments: batiments.length, troncons: troncons.length, monuments: monuments.length, etage, selection: selBat?.id ?? null, facade: facade?.azimut ?? null }),
      diagnostic,
    }),
  );

// Erreurs visibles (diagnostic sur téléphone)
const toast = (t: string) => {
  let e = document.getElementById('toastErreur');
  if (!e) {
    e = document.createElement('div');
    e.id = 'toastErreur';
    e.style.cssText = 'position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top) + 120px);z-index:9;padding:10px 12px;border-radius:12px;background:#b3261e;color:#fff;font-size:12px';
    e.onclick = () => e!.remove();
    document.body.append(e);
  }
  e.textContent = `Erreur : ${t}`;
};
addEventListener('error', (e) => toast(e.message));
addEventListener('unhandledrejection', (e) => toast(String((e as PromiseRejectionEvent).reason)));

// Diagnostic (tests automatisés)
(window as unknown as { __lumen: unknown }).__lumen = {
  cam: (p: number[], t: number[]) => (camera.position.set(p[0]!, p[1]!, p[2]!), controls.target.set(t[0]!, t[1]!, t[2]!)),
  vers: (i: number) => {
    const im = plaques?.children[i] as THREE.InstancedMesh | undefined;
    if (!im) return null;
    const m = new THREE.Matrix4();
    im.getMatrixAt(0, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m), n = new THREE.Vector3(0, 0, 1).transformDirection(m);
    camera.position.copy(p).addScaledVector(n, 1.6).add(new THREE.Vector3(0, -0.4, 0));
    controls.target.copy(p);
    return [(im.geometry as THREE.PlaneGeometry).parameters.width, im.count];
  },
  plaques: () => plaques?.children.reduce((n, o) => n + (o as THREE.InstancedMesh).count, 0) ?? 0,
};
