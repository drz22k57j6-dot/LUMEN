import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { azimutDe, RepereLocal, type Adresse, type Batiment, type Donnee } from '@lumen/core';
import { directionSoleil, ensoleillementAnnuel, positionSoleil, type ResultatJour } from '@lumen/analysis';
import { batimentsAutour, geocoder } from '@lumen/urban';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const TZ = 'Europe/Paris';

// --- Scène ----------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas: $<HTMLCanvasElement>('c'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 1, 5000);
camera.position.set(250, 300, 250);
const controls = new OrbitControls(camera, renderer.domElement);
controls.maxPolarAngle = Math.PI * 0.49;
controls.enableDamping = true;

const hemi = new THREE.HemisphereLight(0xdde8ff, 0x8a8172, 0.9);
scene.add(hemi);
const soleil = new THREE.DirectionalLight(0xfff4e0, 2.6);
soleil.castShadow = true;
soleil.shadow.mapSize.set(4096, 4096);
const ombre = soleil.shadow.camera;
ombre.left = ombre.bottom = -350;
ombre.right = ombre.top = 350;
ombre.near = 1;
ombre.far = 2000;
soleil.shadow.bias = -0.0004;
soleil.shadow.normalBias = 0.6;
scene.add(soleil, soleil.target);

const sol = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0xbdb6a8 }));
sol.rotation.x = -Math.PI / 2;
sol.receiveShadow = true;
scene.add(sol);

const groupe = new THREE.Group();
scene.add(groupe);
const matBat = new THREE.MeshStandardMaterial({ color: 0xece6da, roughness: 0.9 });
const matSel = new THREE.MeshStandardMaterial({ color: 0x7fb3ff, roughness: 0.8 });
const matGenere = new THREE.MeshStandardMaterial({ color: 0xd7c7c7, roughness: 0.9 });
const fenetre = new THREE.Mesh(new THREE.SphereGeometry(1.2), new THREE.MeshBasicMaterial({ color: 0xff2d55 }));
fenetre.visible = false;
scene.add(fenetre);

function redim() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', redim);
redim();

// --- État -----------------------------------------------------------------
let adresse: Adresse | null = null;
let repere: RepereLocal | null = null;
let batiments: Batiment[] = [];
let bvh: MeshBVH | null = null;
let selection: { mesh: THREE.Mesh; bat: Batiment } | null = null;
let facade: { point: THREE.Vector3; normale: THREE.Vector3; azimut: number } | null = null;

// --- Heure de Paris -------------------------------------------------------
/** Date UTC correspondant à une heure murale à Paris. */
function dateParis(jourIso: string, minutes: number): Date {
  const [y, m, d] = jourIso.split('-').map(Number) as [number, number, number];
  const naif = Date.UTC(y, m - 1, d, 0, minutes);
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(naif))
    .reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  const vu = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!);
  return new Date(naif - (vu - naif));
}
const hhmm = (d: Date) => d.toLocaleTimeString('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

const jour = $<HTMLInputElement>('jour');
const heure = $<HTMLInputElement>('heure');
jour.value = new Date().toISOString().slice(0, 10);
heure.value = '780';

function majSoleil() {
  const lieu = adresse?.position ?? { lon: 2.35, lat: 48.85 };
  const d = dateParis(jour.value, +heure.value);
  const s = positionSoleil(d, lieu);
  const [x, y, z] = directionSoleil(s);
  const cible = controls.target;
  soleil.position.set(cible.x + x * 800, cible.y + y * 800, cible.z + z * 800);
  soleil.target.position.copy(cible);
  const jourF = THREE.MathUtils.clamp(s.elevation / 15, 0, 1);
  soleil.intensity = s.elevation > 0 ? 2.6 * jourF + 0.2 : 0;
  hemi.intensity = 0.25 + 0.7 * jourF;
  scene.background = new THREE.Color().lerpColors(new THREE.Color(0x1b2233), new THREE.Color(0x9cc4ef), jourF);
  $('heureTxt').textContent = `${hhmm(d)} — soleil ${s.elevation.toFixed(1)}° / az. ${s.azimut.toFixed(0)}°`;
}
heure.oninput = jour.oninput = majSoleil;

let lecture = false;
$('lecture').onclick = () => {
  lecture = !lecture;
  $('lecture').textContent = lecture ? '❚❚' : '▶';
};

// --- Recherche d'adresse --------------------------------------------------
const q = $<HTMLInputElement>('q');
const sugg = $<HTMLUListElement>('suggestions');
let minuteur = 0;
q.oninput = () => {
  clearTimeout(minuteur);
  if (q.value.length < 4) return void (sugg.innerHTML = '');
  minuteur = window.setTimeout(async () => {
    const res = await geocoder(q.value).catch(() => []);
    sugg.innerHTML = '';
    for (const a of res) {
      const li = document.createElement('li');
      li.textContent = a.label;
      li.onclick = () => charger(a);
      sugg.append(li);
    }
  }, 300);
};
$<HTMLFormElement>('recherche').onsubmit = async (e) => {
  e.preventDefault();
  const [a] = await geocoder(q.value, 1).catch(() => []);
  if (a) charger(a);
  else statut('Adresse introuvable.');
};
const statut = (t: string) => ($('statut').textContent = t);

// --- Chargement du quartier -----------------------------------------------
async function charger(a: Adresse) {
  sugg.innerHTML = '';
  q.value = a.label;
  q.blur();
  adresse = a;
  statut('Chargement des bâtiments IGN…');
  const t0 = performance.now();
  try {
    batiments = await batimentsAutour(a.position, 300);
  } catch (e) {
    return statut(`Erreur : ${(e as Error).message}`);
  }
  // Altitude de référence : sol du bâtiment le plus proche de l'adresse.
  const proche = batiments
    .map((b) => ({ b, d: Math.min(...b.contour.map((p) => Math.hypot(p.x - a.l93.x, p.y - a.l93.y))) }))
    .sort((u, v) => u.d - v.d)[0]?.b;
  repere = new RepereLocal(a.l93, proche?.altitudeSol.valeur ?? 0);
  construire();
  statut(`${batiments.length} bâtiments chargés en ${((performance.now() - t0) / 1000).toFixed(1)} s. Touche un bâtiment.`);
  controls.target.set(0, 0, 0);
  camera.position.set(180, 220, 220);
  majSoleil();
}

function construire() {
  for (const m of groupe.children as THREE.Mesh[]) m.geometry.dispose();
  groupe.clear();
  selection = null;
  facade = null;
  fenetre.visible = false;
  $('selection').hidden = true;
  $('resultat').innerHTML = '';
  if (!repere) return;
  const geos: THREE.BufferGeometry[] = [];
  for (const b of batiments) {
    const forme = new THREE.Shape(b.contour.map((p) => new THREE.Vector2(p.x - repere!.origine.x, p.y - repere!.origine.y)));
    const g = new THREE.ExtrudeGeometry(forme, { depth: b.hauteur.valeur, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    g.translate(0, b.altitudeSol.valeur - repere.altitude0, 0);
    const m = new THREE.Mesh(g, b.hauteur.source === 'genere' ? matGenere : matBat);
    m.castShadow = m.receiveShadow = true;
    m.userData.bat = b;
    groupe.add(m);
    geos.push(g);
  }
  const fusion = geos.length ? mergeGeometries(geos.map((g) => g.clone().deleteAttribute('uv').deleteAttribute('normal'))) : null;
  bvh = fusion ? new MeshBVH(fusion) : null;
}

// --- Sélection (toucher) --------------------------------------------------
const ray = new THREE.Raycaster();
let depart = { x: 0, y: 0 };
renderer.domElement.addEventListener('pointerdown', (e) => (depart = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - depart.x, e.clientY - depart.y) > 8) return; // c'était un glisser
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const hit = ray.intersectObjects(groupe.children, false)[0];
  if (!hit || !hit.face) return;
  const mesh = hit.object as THREE.Mesh;
  const bat = mesh.userData.bat as Batiment;
  if (selection?.mesh !== mesh) {
    if (selection) selection.mesh.material = selection.bat.hauteur.source === 'genere' ? matGenere : matBat;
    mesh.material = matSel;
    selection = { mesh, bat };
    facade = null;
    fenetre.visible = false;
    afficherBatiment(bat);
  }
  const n = hit.face.normal.clone();
  if (Math.abs(n.y) > 0.5) return void ($('infoFacade').textContent = 'Ça, c’est le toit. Touche un mur.');
  n.y = 0;
  n.normalize();
  facade = { point: hit.point.clone(), normale: n, azimut: azimutDe(n.x, -n.z) };
  placerFenetre();
});

const prov = (d: Donnee<number>, u = 'm') =>
  `${d.valeur.toFixed(1)} ${u} <span class="prov">(${d.source}, ${d.origine}${d.precision_m ? `, ±${d.precision_m} m` : ''})</span>`;

function afficherBatiment(b: Batiment) {
  $('selection').hidden = false;
  $('infoBat').innerHTML =
    `<b>${b.usage ?? b.nature ?? 'Bâtiment'}</b>${b.nbLogements ? ` · ${b.nbLogements} logements` : ''}<br>` +
    `Hauteur : ${prov(b.hauteur)}` +
    (b.idRnb ? `<br><span class="prov">RNB ${b.idRnb}</span>` : '');
  const maxEtage = Math.max(0, Math.floor(b.hauteur.valeur / 3) - 1);
  const e = $<HTMLInputElement>('etage');
  e.max = String(maxEtage);
  if (+e.value > maxEtage) e.value = String(maxEtage);
  $('infoFacade').textContent = 'Touche une façade pour placer la fenêtre.';
  $<HTMLButtonElement>('calculer').disabled = true;
}

function placerFenetre() {
  if (!facade || !selection || !repere) return;
  const baseY = selection.bat.altitudeSol.valeur - repere.altitude0;
  const h = +$<HTMLInputElement>('etage').value * +$<HTMLInputElement>('hEtage').value + 1.5;
  fenetre.position.set(facade.point.x, baseY + Math.min(h, selection.bat.hauteur.valeur - 0.5), facade.point.z);
  fenetre.visible = true;
  const cardinal = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(facade.azimut / 45) % 8];
  $('infoFacade').innerHTML = `Façade orientée <b>${cardinal} (${facade.azimut.toFixed(0)}°)</b> <span class="prov">(déduit du contour IGN)</span> · fenêtre à ${h.toFixed(1)} m du sol <span class="prov">(généré : étage × hauteur d'étage + 1,5 m)</span>`;
  $<HTMLButtonElement>('calculer').disabled = false;
}
$('etage').oninput = $('hEtage').oninput = placerFenetre;

// --- Calcul d'ensoleillement ----------------------------------------------
const MOIS = ['Janv.', 'Févr.', 'Mars', 'Avr.', 'Mai', 'Juin', 'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.'];
const rayon = new THREE.Ray();

$('calculer').onclick = () => {
  if (!facade || !adresse || !bvh) return;
  const p = fenetre.position.clone().addScaledVector(facade.normale, 0.3);
  const t0 = performance.now();
  const res = ensoleillementAnnuel({
    lieu: adresse.position,
    point: [p.x, p.y, p.z],
    azimutFacade: facade.azimut,
    annee: new Date().getFullYear(),
    obstacle: (o, d) => {
      rayon.origin.set(...o);
      rayon.direction.set(...d);
      return bvh!.raycastFirst(rayon, THREE.DoubleSide) !== null;
    },
  });
  afficherResultat(res, performance.now() - t0);
};

function afficherResultat(res: ResultatJour[], ms: number) {
  const max = Math.max(1, ...res.map((r) => r.minutes));
  const h = (m: number) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  const saison = (i: number[]) => h(Math.round(i.reduce((s, k) => s + res[k]!.minutes, 0) / i.length / 10) * 10);
  $('resultat').innerHTML =
    `<b>Soleil direct sur la fenêtre (le 21 de chaque mois)</b>` +
    `<div class="prov">Printemps ${saison([2, 3, 4])} · Été ${saison([5, 6, 7])} · Automne ${saison([8, 9, 10])} · Hiver ${saison([11, 0, 1])} par jour</div>` +
    `<table><tr><th>Mois</th><th>Durée</th><th>Plages (heure de Paris)</th></tr>` +
    res
      .map(
        (r, i) =>
          `<tr><td>${MOIS[i]}</td><td>${h(r.minutes)}<div class="barre" style="width:${(r.minutes / max) * 100}%"></div></td>` +
          `<td>${r.plages.map((pl) => `${hhmm(pl.debut)}–${hhmm(pl.fin)}`).join(', ') || '—'}</td></tr>`,
      )
      .join('') +
    `</table><div class="prov">Pas de 10 min · obstacles : bâtiments IGN BD TOPO (volumes simplifiés, toits plats) · arbres et relief non pris en compte pour l'instant · calcul ${ms.toFixed(0)} ms</div>`;
}

// --- Boucle ---------------------------------------------------------------
let dernier = performance.now();
renderer.setAnimationLoop((t) => {
  if (lecture) {
    heure.value = String((+heure.value + ((t - dernier) / 1000) * 60) % 1440);
    majSoleil();
  }
  dernier = t;
  controls.update();
  renderer.render(scene, camera);
});
majSoleil();
