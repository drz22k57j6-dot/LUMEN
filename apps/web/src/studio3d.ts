/**
 * Studio 3D — générateur d'appartement 3D à partir de plusieurs sources :
 * plan 2D Lumen, scan Apple RoomPlan (JSON), scan 3D photo (GLB/OBJ/USDZ), plan d'architecte (DXF).
 * Trois vues : Plan 2D (édition fine du modèle), Maquette (vue de dessus), Visite (à hauteur d'yeux).
 * Le soleil réel (éphémérides) entre par les fenêtres si l'orientation est connue.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { USDZLoader } from 'three/examples/jsm/loaders/USDZLoader.js';
import { positionSoleil } from '@lumen/analysis';
import {
  blocsMurs, cardinal, centreContour, dansContour, depuisDXF, depuisPlan, depuisRoomPlan, direction, directionPlan, emprise,
  erreursModele, longueur, modeleVide, nomPiece3D, normaleExterieure, PIECES, planModele, pointSurMur, projeter, aireContour,
  azimutPlan, type CapturedRoomJSON, type Modele, type Mur, type Ouverture3D, type P2, type Plan, type TypeOuverture, type TypePiece,
} from '@lumen/interior';

const PARIS = { lon: 2.3488, lat: 48.8534 };
const TZ = 'Europe/Paris';
const mobile = matchMedia('(pointer: coarse)').matches;
const SOLS_BOIS = new Set<TypePiece>(['sejour', 'chambre', 'bureau', 'entree', 'couloir']);
const COULEURS_OBJETS: Record<string, number> = {
  bed: 0xe9e4dc, sofa: 0x8a8f99, table: 0xb08a63, chair: 0x6b6f78, storage: 0xd9d2c5, refrigerator: 0xe8e8e8, stove: 0x3a3a3a,
  oven: 0x3a3a3a, sink: 0xf2f2f2, toilet: 0xf7f7f7, bathtub: 0xf7f7f7, washerDryer: 0xefefef, dishwasher: 0xdedede, television: 0x1a1a1a,
  fireplace: 0x9a8d80, stairs: 0xb9a58c,
};
const stocker = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* plein */ } };
const relire = <T>(k: string): T | null => { try { const s = localStorage.getItem(k); return s ? (JSON.parse(s) as T) : null; } catch { return null; } };

// --- Textures procédurales (aucune image externe) --------------------------------
function texture(dessin: (g: CanvasRenderingContext2D, s: number) => void, taille: number, metres: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = taille;
  dessin(c.getContext('2d')!, taille);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / metres, 1 / metres);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const alea = (s: number) => () => ((s = (s * 16807) % 2147483647) / 2147483647);
const parquet = () => texture((g, s) => {
  const r = alea(7), lames = 8, l = s / lames;
  for (let i = 0; i < lames; i++) {
    let y = -r() * s;
    while (y < s) {
      const long = s * (0.45 + r() * 0.5);
      const t = 0.86 + r() * 0.2;
      g.fillStyle = `rgb(${Math.round(186 * t)},${Math.round(146 * t)},${Math.round(104 * t)})`;
      g.fillRect(i * l, y, l, long);
      g.globalAlpha = 0.08;
      for (let k = 0; k < 14; k++) { g.fillStyle = r() > 0.5 ? '#5a3a1e' : '#fff3df'; g.fillRect(i * l + r() * l, y, 1 + r() * 2, long); }
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(60,40,20,.55)'; g.fillRect(i * l, y, l, 2); g.fillRect(i * l, y, 2, long);
      y += long;
    }
  }
}, 1024, 1.44);
const carrelage = () => texture((g, s) => {
  const r = alea(3), n = 4, c = s / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const t = 0.94 + r() * 0.06;
    g.fillStyle = `rgb(${Math.round(226 * t)},${Math.round(224 * t)},${Math.round(219 * t)})`;
    g.fillRect(i * c, j * c, c, c);
  }
  g.fillStyle = '#b9b5ad';
  for (let i = 0; i <= n; i++) { g.fillRect(i * c - 2, 0, 4, s); g.fillRect(0, i * c - 2, s, 4); }
}, 512, 1.2);
const crepi = () => texture((g, s) => {
  g.fillStyle = '#f3f0ea'; g.fillRect(0, 0, s, s);
  const r = alea(11);
  for (let k = 0; k < 5000; k++) { g.fillStyle = r() > 0.5 ? 'rgba(0,0,0,.025)' : 'rgba(255,255,255,.05)'; g.fillRect(r() * s, r() * s, 2, 2); }
}, 256, 1);

// --- Matériaux ------------------------------------------------------------------
function materiaux() {
  return {
    mur: new THREE.MeshStandardMaterial({ map: crepi(), roughness: 0.93 }),
    plafond: new THREE.MeshStandardMaterial({ color: 0xfbfaf7, roughness: 0.95, side: THREE.DoubleSide }),
    bois: new THREE.MeshStandardMaterial({ map: parquet(), roughness: 0.55, metalness: 0 }),
    carreau: new THREE.MeshStandardMaterial({ map: carrelage(), roughness: 0.3 }),
    vitre: new THREE.MeshPhysicalMaterial({ color: 0xdfefff, transparent: true, opacity: 0.12, roughness: 0.02, metalness: 0, envMapIntensity: 1.5, depthWrite: false }),
    menuiserie: new THREE.MeshStandardMaterial({ color: 0xf6f6f4, roughness: 0.4 }),
    porte: new THREE.MeshStandardMaterial({ color: 0xefece6, roughness: 0.5 }),
    poignee: new THREE.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.25, metalness: 1 }),
    plinthe: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }),
    sol: new THREE.MeshStandardMaterial({ color: 0x6f7d5b, roughness: 1 }),
    selection: new THREE.MeshStandardMaterial({ color: 0xffc21a, emissive: 0x553c00, roughness: 0.6 }),
  };
}

type Vue = '2d' | 'maquette' | 'visite';

export function initStudio(opts: { ouvrirPlan2D: () => void }) {
  const ui = document.createElement('div');
  ui.id = 'studio';
  ui.hidden = true;
  ui.innerHTML = `
    <canvas id="stCanvas"></canvas>
    <canvas id="stPlan" hidden></canvas>
    <header class="st-haut">
      <button id="stFermer" class="pastille" type="button">✕</button>
      <div class="st-vues">
        <button data-vue="2d" class="pastille" type="button">Plan 2D</button>
        <button data-vue="maquette" class="pastille actif" type="button">Maquette</button>
        <button data-vue="visite" class="pastille" type="button">Visite</button>
      </div>
      <button id="stSources" class="pastille" type="button">＋ Source</button>
    </header>
    <div id="stOutils2d" class="st-outils" hidden>
      <button data-outil="choisir" class="pastille actif" type="button">☝ Choisir</button>
      <button data-outil="mur" class="pastille" type="button">▬ Mur</button>
      <button data-outil="fenetre" class="pastille" type="button">⊟ Fenêtre</button>
      <button data-outil="porte_fenetre" class="pastille" type="button">⊞ Porte-fen.</button>
      <button data-outil="porte" class="pastille" type="button">◫ Porte</button>
      <button id="stAnnuler" class="pastille" type="button">↶</button>
    </div>
    <div id="stProps" class="st-carte" hidden></div>
    <div id="stPied" class="st-carte">
      <div class="ligne serre"><b id="stHeureTxt">13:00</b><span id="stSoleilTxt" class="doux"></span></div>
      <input id="stHeure" type="range" min="300" max="1320" step="1" value="780" />
      <div class="ligne serre">
        <button class="pastille" data-stdate="03-20" type="button">Équinoxe</button>
        <button class="pastille" data-stdate="06-21" type="button">21 juin</button>
        <button class="pastille" data-stdate="12-21" type="button">21 déc.</button>
        <select id="stOrient" class="pastille" title="Orientation"></select>
        <button id="stQualite" class="pastille" type="button"></button>
        <button id="stCoupe" class="pastille" type="button">Murs coupés</button>
      </div>
      <div id="stInfo" class="doux"></div>
    </div>
    <div id="stMenu" class="st-carte st-menu" hidden>
      <b>Ajouter une source</b>
      <button data-src="plan" type="button">▦ Mon plan 2D Lumen</button>
      <button data-src="editeur" type="button">📄 Importer une image de plan (éditeur 2D)</button>
      <label class="st-fichier">📱 Scan Apple RoomPlan (.json)<input data-src="roomplan" type="file" accept=".json,application/json" hidden /></label>
      <label class="st-fichier">🧊 Scan 3D photo (.glb .gltf .obj .usdz)<input data-src="scan" type="file" accept=".glb,.gltf,.obj,.usdz,model/*" hidden /></label>
      <label class="st-fichier">📐 Plan d'architecte (.dxf)<input data-src="dxf" type="file" accept=".dxf" hidden /></label>
      <button data-src="demo" type="button">✨ Démo T3</button>
      <button data-src="vide" type="button">🗑 Repartir de zéro</button>
      <p class="doux">RoomPlan : exporte la pièce en JSON (CapturedRoom) depuis une app de scan RoomPlan. Scan photo : export GLB ou OBJ (Polycam, 3D Scanner App…).</p>
    </div>
    <div id="stJoy" hidden><div></div></div>`;
  document.body.append(ui);
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => ui.querySelector(s) as T;

  // --- Rendu -------------------------------------------------------------------
  const canvas = $<HTMLCanvasElement>('#stCanvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.75 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.localClippingEnabled = true;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;
  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 4000);
  const orbite = new OrbitControls(camera, canvas);
  orbite.enableDamping = true;
  orbite.maxPolarAngle = Math.PI * 0.48;

  const ciel = new Sky();
  ciel.scale.setScalar(3000);
  const u = ciel.material.uniforms;
  u.turbidity!.value = 4; u.rayleigh!.value = 1.2; u.mieCoefficient!.value = 0.004; u.mieDirectionalG!.value = 0.8;
  scene.add(ciel);
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x9c8f7c, 0.55);
  scene.add(hemi);
  const soleil = new THREE.DirectionalLight(0xfff1dc, 3.2);
  soleil.castShadow = true;
  soleil.shadow.bias = -0.0002;
  soleil.shadow.normalBias = 0.02;
  scene.add(soleil, soleil.target);
  const mat = materiaux();
  const terrain = new THREE.Mesh(new THREE.CircleGeometry(1500, 48), mat.sol);
  terrain.rotation.x = -Math.PI / 2;
  terrain.receiveShadow = true;
  scene.add(terrain);
  const racine = new THREE.Group();
  const scanGroupe = new THREE.Group();
  scene.add(racine, scanGroupe);
  const coupe = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1.35);

  let composer: EffectComposer | null = null;
  let ao: GTAOPass | null = null;
  let ultra = !mobile;
  function preparerPost() {
    composer?.dispose();
    composer = null;
    ao = null;
    if (!ultra) return;
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    ao = new GTAOPass(scene, camera, innerWidth, innerHeight);
    ao.normalMaterial.clippingPlanes = vue === 'maquette' && murCoupes ? [coupe] : [];
    ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.5, thickness: 1.2, scale: 1.1 });
    ao.blendIntensity = 0.9;
    composer.addPass(ao);
    composer.addPass(new OutputPass());
    composer.setSize(innerWidth, innerHeight);
  }
  function majQualite() {
    $('#stQualite').textContent = ultra ? 'Qualité Ultra' : 'Qualité Mobile';
    soleil.shadow.mapSize.setScalar(ultra ? 4096 : 2048);
    soleil.shadow.map?.dispose();
    soleil.shadow.map = null;
    preparerPost();
  }

  // --- État ----------------------------------------------------------------------
  let modele: Modele = relire<Modele>('lumen:modele:courant') ?? depuisPlan(planModele('t3'));
  let historique: string[] = [];
  let vue: Vue = 'maquette';
  let murCoupes = true;
  let selection: { type: 'mur' | 'ouverture' | 'piece'; id: string } | null = null;
  const memo = () => { historique.push(JSON.stringify(modele)); if (historique.length > 60) historique.shift(); };
  const sauver = () => stocker('lumen:modele:courant', modele);

  // --- Construction 3D -------------------------------------------------------------
  const geos: THREE.BufferGeometry[] = [];
  const boite = (l: number, h: number, p: number) => { const g = new THREE.BoxGeometry(l, h, p); geos.push(g); return g; };
  const plafonds: THREE.Mesh[] = [];

  function construire() {
    for (const g of geos.splice(0)) g.dispose();
    racine.clear();
    plafonds.length = 0;
    const clip = vue === 'maquette' && murCoupes ? [coupe] : [];
    for (const k of ['mur', 'menuiserie', 'porte', 'plinthe'] as const) mat[k].clippingPlanes = clip;
    mat.vitre.clippingPlanes = clip;
    if (ao) { ao.normalMaterial.clippingPlanes = clip; ao.normalMaterial.needsUpdate = true; } // l'occlusion ambiante respecte la coupe
    const ajoute = (m: THREE.Mesh, ombre = true) => { m.castShadow = ombre; m.receiveShadow = true; racine.add(m); return m; };
    // Murs (découpés autour des ouvertures)
    for (const b of blocsMurs(modele)) {
      const estSel = selection?.type === 'mur' && selection.id === b.mur;
      const m = new THREE.Mesh(boite(b.taille[0], b.taille[2], b.taille[1]), b.type === 'vitre' ? mat.vitre : estSel ? mat.selection : mat.mur);
      m.position.set(b.centre[0], b.centre[2], -b.centre[1]);
      m.rotation.y = b.angle;
      ajoute(m, b.type !== 'vitre');
    }
    // Menuiseries
    for (const o of modele.ouvertures) {
      const w = modele.murs.find((x) => x.id === o.mur);
      if (!w) continue;
      const g = new THREE.Group();
      const c = pointSurMur(w, o.t);
      g.position.set(c[0], 0, -c[1]);
      const [dx, dy] = direction(w);
      g.rotation.y = Math.atan2(dy, dx);
      const n = normaleExterieure(modele, w);
      const cote = Math.sign(n[0] * dy - n[1] * dx) || 1; // +1 si l'extérieur est côté +z local (plan : (dy, −dx))
      const cadre = 0.06, prof = Math.min(0.08, w.epaisseur);
      const barre = (l: number, h: number, x: number, y: number, z = 0, m: THREE.Material = mat.menuiserie) => {
        const b = new THREE.Mesh(boite(l, h, prof), m);
        b.position.set(x, y, z);
        b.castShadow = b.receiveShadow = true;
        g.add(b);
        return b;
      };
      const y0 = o.allege, y1 = o.allege + o.hauteur;
      if (o.type === 'porte' || o.type === 'baie') {
        // Chambranle + vantail entrouvert
        barre(cadre, o.hauteur, -o.largeur / 2 + cadre / 2, (y0 + y1) / 2);
        barre(cadre, o.hauteur, o.largeur / 2 - cadre / 2, (y0 + y1) / 2);
        barre(o.largeur, cadre, 0, y1 - cadre / 2);
        if (o.type === 'porte') {
          const pivot = new THREE.Group();
          pivot.position.set(-o.largeur / 2 + cadre, 0, 0);
          pivot.rotation.y = -0.45 * cote;
          const v = new THREE.Mesh(boite(o.largeur - 2 * cadre, o.hauteur - cadre, 0.04), mat.porte);
          v.position.set((o.largeur - 2 * cadre) / 2, (o.hauteur - cadre) / 2, 0);
          v.castShadow = v.receiveShadow = true;
          const p = new THREE.Mesh(boite(0.12, 0.02, 0.06), mat.poignee);
          p.position.set(o.largeur - 2 * cadre - 0.08, 1.05, 0);
          pivot.add(v, p);
          g.add(pivot);
        }
      } else {
        barre(cadre, o.hauteur, -o.largeur / 2 + cadre / 2, (y0 + y1) / 2);
        barre(cadre, o.hauteur, o.largeur / 2 - cadre / 2, (y0 + y1) / 2);
        barre(o.largeur, cadre, 0, y1 - cadre / 2);
        barre(o.largeur, cadre, 0, y0 + cadre / 2);
        if (o.largeur > 0.9) barre(cadre * 0.8, o.hauteur, 0, (y0 + y1) / 2);
        if (o.allege > 0.05) { const a = barre(o.largeur + 0.04, 0.03, 0, y0 - 0.015, -cote * (w.epaisseur / 2 - 0.02)); a.scale.z = 1.6; }
      }
      racine.add(g);
    }
    // Plinthes (des deux côtés, sauf portes)
    for (const w of modele.murs) {
      const L = longueur(w), [dx, dy] = direction(w), ang = Math.atan2(dy, dx);
      const portes = modele.ouvertures.filter((o) => o.mur === w.id && o.allege < 0.05).map((o) => [o.t - o.largeur / 2, o.t + o.largeur / 2] as const).sort((a, b) => a[0] - b[0]);
      const morceaux: [number, number][] = [];
      let cur = 0;
      for (const [a, b] of portes) { if (a > cur) morceaux.push([cur, a]); cur = Math.max(cur, b); }
      if (cur < L) morceaux.push([cur, L]);
      for (const [a, b] of morceaux) for (const s of [-1, 1]) {
        if (w.exterieur && s === Math.sign(normaleExterieure(modele, w)[0] * -dy + normaleExterieure(modele, w)[1] * dx)) continue;
        const pl = new THREE.Mesh(boite(b - a, 0.08, 0.012), mat.plinthe);
        const c = (a + b) / 2;
        const off = s * (w.epaisseur / 2 + 0.006);
        // décalage perpendiculaire : (−dy, dx) dans le plan
        pl.position.y = 0.04;
        pl.position.x = w.a[0] + dx * c + -dy * off;
        pl.position.z = -(w.a[1] + dy * c + dx * off);
        pl.rotation.y = ang;
        pl.receiveShadow = true;
        racine.add(pl);
      }
    }
    // Sols et plafonds
    const H = modele.hauteurSousPlafond;
    for (const p of modele.pieces) {
      if (p.contour.length < 3) continue;
      const forme = new THREE.Shape(p.contour.map(([x, y]) => new THREE.Vector2(x, y)));
      const gs = new THREE.ShapeGeometry(forme);
      geos.push(gs);
      const sel = selection?.type === 'piece' && selection.id === p.id;
      const s = new THREE.Mesh(gs, sel ? mat.selection : SOLS_BOIS.has(p.type) ? mat.bois : mat.carreau);
      s.rotation.x = -Math.PI / 2;
      s.position.y = 0.001;
      s.receiveShadow = true;
      racine.add(s);
      const pl = new THREE.Mesh(gs, mat.plafond);
      pl.rotation.x = Math.PI / 2;
      pl.scale.y = -1;
      pl.position.y = H;
      pl.castShadow = true;
      plafonds.push(pl);
      racine.add(pl);
    }
    // Objets scannés (RoomPlan)
    for (const o of modele.objets) {
      const m = new THREE.Mesh(boite(o.taille[0], o.taille[2], o.taille[1]), new THREE.MeshStandardMaterial({ color: COULEURS_OBJETS[o.categorie] ?? 0xcfc8bc, roughness: 0.7 }));
      m.position.set(o.centre[0], o.centre[2], -o.centre[1]);
      m.rotation.y = o.angle;
      ajoute(m);
    }
    majPlafonds();
    cadrerOmbre();
    majInfo();
  }

  function majPlafonds() {
    for (const p of plafonds) {
      const m = p.material as THREE.MeshStandardMaterial;
      // En maquette : plafond invisible mais il projette toujours son ombre (lumière réaliste dans les pièces).
      m.colorWrite = m.depthWrite = vue === 'visite';
    }
  }

  function cadrerOmbre() {
    const [x0, y0, x1, y1] = emprise(modele);
    const r = Math.max(6, Math.hypot(x1 - x0, y1 - y0) / 2 + 3);
    const c = soleil.shadow.camera;
    c.left = c.bottom = -r; c.right = c.top = r; c.near = 0.5; c.far = 200;
    c.updateProjectionMatrix();
  }

  const etage = () => 2;
  terrain.position.y = -etage() * 3 - 0.3;

  // --- Soleil ------------------------------------------------------------------------
  let jour = new Date().toISOString().slice(0, 10);
  function dateParis(minutes: number): Date {
    const [y, m, d] = jour.split('-').map(Number) as [number, number, number];
    const naif = Date.UTC(y, m - 1, d, 0, minutes);
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(naif)).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
    return new Date(naif - (Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!) - naif));
  }
  function majSoleil() {
    const min = +$<HTMLInputElement>('#stHeure').value;
    const d = dateParis(min);
    const s = positionSoleil(d, PARIS);
    const az = modele.azimutBas ?? 180;
    const [px, py] = directionPlan(az, s.azimut);
    const e = (Math.max(s.elevation, -2) * Math.PI) / 180;
    const dir = new THREE.Vector3(px * Math.cos(e), Math.sin(e), -py * Math.cos(e));
    const [x0, y0, x1, y1] = emprise(modele);
    const c = new THREE.Vector3((x0 + x1) / 2, 0, -(y0 + y1) / 2);
    soleil.position.copy(c).addScaledVector(dir, 60);
    soleil.target.position.copy(c);
    const jourF = THREE.MathUtils.clamp(s.elevation / 12, 0, 1);
    soleil.intensity = s.elevation > 0 ? 3.4 * jourF : 0;
    hemi.intensity = 0.12 + 0.5 * jourF;
    scene.environmentIntensity = 0.08 + 0.3 * jourF;
    u.sunPosition!.value.copy(dir);
    $('#stHeureTxt').textContent = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    $('#stSoleilTxt').textContent = s.elevation > 0
      ? `soleil ${s.elevation.toFixed(0)}° · plein ${cardinal(s.azimut)}${modele.azimutBas === undefined ? ' · orientation supposée' : ''}`
      : 'soleil couché';
  }

  // --- Vues & caméra -------------------------------------------------------------------
  const visite = { yaw: 0, pitch: -0.05, pos: new THREE.Vector3(), avance: 0, lateral: 0 };
  function cadrer() {
    const [x0, y0, x1, y1] = emprise(modele);
    const c = new THREE.Vector3((x0 + x1) / 2, 0, -(y0 + y1) / 2);
    const r = Math.max(4, Math.hypot(x1 - x0, y1 - y0));
    if (vue === 'maquette') {
      orbite.enabled = true;
      orbite.target.copy(c);
      // Distance qui fait tenir tout le logement, même en portrait (champ horizontal étroit).
      const hfov = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
      const dist = Math.max((r * 0.6) / Math.tan(hfov / 2), (r * 0.6) / Math.tan((camera.fov * Math.PI) / 360));
      const d = new THREE.Vector3(0.3, 1, 0.7).normalize();
      camera.position.copy(c).addScaledVector(d, dist);
    } else if (vue === 'visite') {
      orbite.enabled = false;
      const p = [...modele.pieces].sort((a, b) => aireContour(b.contour) - aireContour(a.contour))[0];
      const [cx, cy] = p ? centreContour(p.contour) : [c.x, -c.z];
      visite.pos.set(cx, 1.6, -cy);
      // Regarde vers la fenêtre la plus proche
      const f = modele.ouvertures.filter((o) => o.type !== 'porte').map((o) => { const w = modele.murs.find((x) => x.id === o.mur)!; return pointSurMur(w, o.t); })
        .sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy))[0];
      visite.yaw = f ? Math.atan2(-(f[0] - cx), (f[1] - cy)) : 0;
      visite.pitch = -0.05;
    }
  }
  function changerVue(v: Vue) {
    vue = v;
    ui.querySelectorAll('[data-vue]').forEach((b) => b.classList.toggle('actif', (b as HTMLElement).dataset.vue === v));
    $('#stPlan').hidden = v !== '2d';
    canvas.hidden = v === '2d';
    $('#stOutils2d').hidden = v !== '2d';
    $('#stJoy').hidden = v !== 'visite' || !mobile;
    $('#stCoupe').hidden = v !== 'maquette';
    camera.near = v === 'visite' ? 0.05 : 0.1;
    camera.updateProjectionMatrix();
    construire();
    if (v === '2d') { ajuster2D(); dessiner2D(); } else cadrer();
    majProps();
  }

  // Visite : glisser = regarder ; joystick (mobile) ou ZQSD/flèches (ordinateur) = avancer
  const touches = new Set<string>();
  addEventListener('keydown', (e) => { if (!ui.hidden) touches.add(e.key.toLowerCase()); });
  addEventListener('keyup', (e) => touches.delete(e.key.toLowerCase()));
  let regard: { x: number; y: number; id: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => { if (vue === 'visite') { regard = { x: e.clientX, y: e.clientY, id: e.pointerId }; canvas.setPointerCapture(e.pointerId); } });
  canvas.addEventListener('pointermove', (e) => {
    if (!regard || regard.id !== e.pointerId) return;
    visite.yaw -= (e.clientX - regard.x) * 0.005;
    visite.pitch = THREE.MathUtils.clamp(visite.pitch - (e.clientY - regard.y) * 0.004, -1.2, 1.2);
    regard.x = e.clientX; regard.y = e.clientY;
  });
  canvas.addEventListener('pointerup', () => (regard = null));
  const joy = $('#stJoy');
  let joyDepart: { x: number; y: number } | null = null;
  joy.addEventListener('pointerdown', (e) => { e.stopPropagation(); joy.setPointerCapture(e.pointerId); joyDepart = { x: e.clientX, y: e.clientY }; });
  joy.addEventListener('pointermove', (e) => {
    if (!joyDepart) return;
    const dx = THREE.MathUtils.clamp((e.clientX - joyDepart.x) / 45, -1, 1), dy = THREE.MathUtils.clamp((e.clientY - joyDepart.y) / 45, -1, 1);
    visite.avance = -dy; visite.lateral = dx;
    (joy.firstElementChild as HTMLElement).style.transform = `translate(${dx * 30}px, ${dy * 30}px)`;
  });
  joy.addEventListener('pointerup', () => { joyDepart = null; visite.avance = visite.lateral = 0; (joy.firstElementChild as HTMLElement).style.transform = ''; });

  // --- Éditeur 2D du modèle -------------------------------------------------------------
  const plan = $<HTMLCanvasElement>('#stPlan');
  const g2 = plan.getContext('2d')!;
  let v2 = { cx: 0, cy: 0, s: 40 };
  let outil: 'choisir' | 'mur' | TypeOuverture = 'choisir';
  let geste: { type: 'mur-nouveau'; a: P2; b: P2 } | { type: 'extremite'; mur: Mur; bout: 'a' | 'b' } | { type: 'glisser-ouv'; o: Ouverture3D } | { type: 'pan'; x: number; y: number; cx: number; cy: number } | null = null;
  const pointeurs = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; s: number } | null = null;
  const ecran = (x: number, y: number): [number, number] => [plan.clientWidth / 2 + (x - v2.cx) * v2.s, plan.clientHeight / 2 - (y - v2.cy) * v2.s];
  const monde = (sx: number, sy: number): P2 => [v2.cx + (sx - plan.clientWidth / 2) / v2.s, v2.cy - (sy - plan.clientHeight / 2) / v2.s];
  const snap = (v: number) => Math.round(v / 0.05) * 0.05;
  function ajuster2D() {
    const [x0, y0, x1, y1] = emprise(modele);
    const W = plan.clientWidth || innerWidth, H = (plan.clientHeight || innerHeight) * 0.62;
    v2 = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 - 1.2, s: Math.min(W / (x1 - x0 + 2), H / (y1 - y0 + 2), 120) || 40 };
  }
  function aimanter(p: P2, sauf?: Mur): P2 {
    for (const w of modele.murs) for (const q of [w.a, w.b]) if (w !== sauf && Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.2) return [q[0], q[1]];
    return [snap(p[0]), snap(p[1])];
  }
  function dessiner2D() {
    const dpr = Math.min(devicePixelRatio, 2), W = plan.clientWidth, H = plan.clientHeight;
    if (plan.width !== W * dpr || plan.height !== H * dpr) { plan.width = W * dpr; plan.height = H * dpr; }
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.fillStyle = '#f7f6f3'; g2.fillRect(0, 0, W, H);
    // grille
    const [gx0, gy1] = monde(0, 0), [gx1, gy0] = monde(W, H);
    g2.strokeStyle = '#e7e4de'; g2.lineWidth = 1; g2.beginPath();
    for (let x = Math.floor(gx0); x <= gx1; x++) { const [sx] = ecran(x, 0); g2.moveTo(sx, 0); g2.lineTo(sx, H); }
    for (let y = Math.floor(gy0); y <= gy1; y++) { const [, sy] = ecran(0, y); g2.moveTo(0, sy); g2.lineTo(W, sy); }
    g2.stroke();
    // pièces
    for (const p of modele.pieces) {
      g2.beginPath();
      p.contour.forEach(([x, y], i) => { const [sx, sy] = ecran(x, y); i ? g2.lineTo(sx, sy) : g2.moveTo(sx, sy); });
      g2.closePath();
      const sel = selection?.type === 'piece' && selection.id === p.id;
      g2.fillStyle = sel ? '#ffe39a' : '#' + PIECES[p.type].couleur.toString(16).padStart(6, '0');
      g2.fill();
      const [cx, cy] = ecran(...centreContour(p.contour));
      g2.fillStyle = '#333'; g2.font = '600 12px system-ui'; g2.textAlign = 'center';
      g2.fillText(nomPiece3D(p), cx, cy - 2);
      g2.font = '11px system-ui'; g2.fillText(`${aireContour(p.contour).toFixed(1)} m²`, cx, cy + 12);
    }
    // murs
    g2.lineCap = 'butt';
    for (const w of modele.murs) {
      const sel = selection?.type === 'mur' && selection.id === w.id;
      g2.strokeStyle = sel ? '#e0a400' : w.source === 'mesure' ? '#1b2a44' : '#2b2b2b';
      g2.lineWidth = Math.max(2, w.epaisseur * v2.s);
      g2.beginPath(); g2.moveTo(...ecran(...w.a)); g2.lineTo(...ecran(...w.b)); g2.stroke();
      if (sel) for (const q of [w.a, w.b]) { g2.fillStyle = '#e0a400'; g2.beginPath(); g2.arc(...ecran(...q), 9, 0, Math.PI * 2); g2.fill(); }
      if (sel || longueur(w) * v2.s > 70) {
        const m = pointSurMur(w, longueur(w) / 2);
        const [sx, sy] = ecran(...m);
        g2.fillStyle = '#555'; g2.font = '10px system-ui'; g2.textAlign = 'center';
        g2.fillText(`${longueur(w).toFixed(2)} m`, sx, sy - Math.max(8, w.epaisseur * v2.s));
      }
    }
    // ouvertures
    for (const o of modele.ouvertures) {
      const w = modele.murs.find((x) => x.id === o.mur);
      if (!w) continue;
      const a = pointSurMur(w, o.t - o.largeur / 2), b = pointSurMur(w, o.t + o.largeur / 2);
      const sel = selection?.type === 'ouverture' && selection.id === o.id;
      g2.strokeStyle = '#f7f6f3'; g2.lineWidth = Math.max(2, w.epaisseur * v2.s) + 1;
      g2.beginPath(); g2.moveTo(...ecran(...a)); g2.lineTo(...ecran(...b)); g2.stroke();
      g2.strokeStyle = sel ? '#e0a400' : o.type === 'porte' ? '#8a6a45' : o.type === 'baie' ? '#999' : '#2f8ae8';
      g2.lineWidth = o.type === 'porte' ? 2 : 4;
      g2.beginPath(); g2.moveTo(...ecran(...a)); g2.lineTo(...ecran(...b)); g2.stroke();
      if (o.type === 'porte') {
        const [sx, sy] = ecran(...a);
        g2.beginPath(); g2.arc(sx, sy, o.largeur * v2.s, 0, Math.PI * 2); g2.globalAlpha = 0; g2.stroke(); g2.globalAlpha = 1;
      }
    }
    if (geste?.type === 'mur-nouveau') {
      g2.strokeStyle = '#e0a400'; g2.lineWidth = 0.15 * v2.s; g2.setLineDash([8, 6]);
      g2.beginPath(); g2.moveTo(...ecran(...geste.a)); g2.lineTo(...ecran(...geste.b)); g2.stroke(); g2.setLineDash([]);
      const [sx, sy] = ecran(...geste.b);
      g2.fillStyle = '#111'; g2.font = '600 12px system-ui';
      g2.fillText(`${Math.hypot(geste.b[0] - geste.a[0], geste.b[1] - geste.a[1]).toFixed(2)} m`, sx + 10, sy - 10);
    }
    // boussole
    const az = modele.azimutBas;
    if (az !== undefined) {
      const [nx, ny] = directionPlan(az, 0);
      g2.save(); g2.translate(W - 32, 96); g2.rotate(Math.atan2(nx, ny));
      g2.fillStyle = '#c0392b'; g2.beginPath(); g2.moveTo(0, -16); g2.lineTo(6, 5); g2.lineTo(-6, 5); g2.fill();
      g2.fillStyle = '#333'; g2.font = '600 11px system-ui'; g2.textAlign = 'center'; g2.fillText('N', 0, -19);
      g2.restore();
    }
    g2.textAlign = 'left';
  }

  function trouver(p: P2): typeof selection {
    let best: { s: NonNullable<typeof selection>; d: number } | null = null;
    for (const o of modele.ouvertures) {
      const w = modele.murs.find((x) => x.id === o.mur);
      if (!w) continue;
      const c = pointSurMur(w, o.t);
      const d = Math.hypot(c[0] - p[0], c[1] - p[1]) - o.largeur / 2;
      if (d < 0.25 && (!best || d < best.d)) best = { s: { type: 'ouverture', id: o.id }, d };
    }
    if (best) return best.s;
    for (const w of modele.murs) {
      const { d } = projeter(w, p);
      if (d < Math.max(0.25, w.epaisseur) && (!best || d < best.d)) best = { s: { type: 'mur', id: w.id }, d };
    }
    if (best) return best.s;
    const piece = modele.pieces.find((x) => dansContour(x.contour, p));
    return piece ? { type: 'piece', id: piece.id } : null;
  }

  const local = (e: PointerEvent): P2 => { const r = plan.getBoundingClientRect(); return monde(e.clientX - r.left, e.clientY - r.top); };
  plan.addEventListener('pointerdown', (e) => {
    plan.setPointerCapture(e.pointerId);
    pointeurs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointeurs.size === 2) {
      const [a, b] = [...pointeurs.values()] as [{ x: number; y: number }, { x: number; y: number }];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: v2.s };
      geste = null;
      return;
    }
    const p = local(e);
    if (outil === 'mur') { const a = aimanter(p); geste = { type: 'mur-nouveau', a, b: a }; return; }
    if (outil !== 'choisir') { poserOuverture(p, outil); return; }
    // Poignées du mur sélectionné
    if (selection?.type === 'mur') {
      const w = modele.murs.find((x) => x.id === selection!.id);
      if (w) for (const bout of ['a', 'b'] as const) if (Math.hypot(w[bout][0] - p[0], w[bout][1] - p[1]) * v2.s < 22) { memo(); geste = { type: 'extremite', mur: w, bout }; return; }
    }
    const t = trouver(p);
    if (t?.type === 'ouverture' && selection?.type === 'ouverture' && selection.id === t.id) {
      memo();
      geste = { type: 'glisser-ouv', o: modele.ouvertures.find((o) => o.id === t.id)! };
      return;
    }
    selection = t;
    if (!t) geste = { type: 'pan', x: e.clientX, y: e.clientY, cx: v2.cx, cy: v2.cy };
    majProps();
    dessiner2D();
  });
  plan.addEventListener('pointermove', (e) => {
    if (!pointeurs.has(e.pointerId)) return;
    pointeurs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointeurs.size === 2) {
      const [a, b] = [...pointeurs.values()] as [{ x: number; y: number }, { x: number; y: number }];
      v2.s = THREE.MathUtils.clamp((pinch.s * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d, 8, 400);
      return dessiner2D();
    }
    const p = local(e);
    if (!geste) return;
    if (geste.type === 'mur-nouveau') {
      let b = aimanter(p);
      // Aimant orthogonal (à 8° près)
      const dx = b[0] - geste.a[0], dy = b[1] - geste.a[1];
      if (Math.abs(dy) < Math.abs(dx) * 0.14) b = [b[0], geste.a[1]];
      else if (Math.abs(dx) < Math.abs(dy) * 0.14) b = [geste.a[0], b[1]];
      geste.b = b;
    } else if (geste.type === 'extremite') {
      geste.mur[geste.bout] = aimanter(p, geste.mur);
    } else if (geste.type === 'glisser-ouv') {
      const o = geste.o, w = modele.murs.find((x) => x.id === o.mur)!;
      o.t = THREE.MathUtils.clamp(snap(projeter(w, p).t), o.largeur / 2, longueur(w) - o.largeur / 2);
      o.source = 'deduit';
    } else if (geste.type === 'pan') {
      v2.cx = geste.cx - (e.clientX - geste.x) / v2.s;
      v2.cy = geste.cy + (e.clientY - geste.y) / v2.s;
    }
    dessiner2D();
  });
  const fin = (e: PointerEvent) => {
    pointeurs.delete(e.pointerId);
    if (pointeurs.size < 2) pinch = null;
    if (geste?.type === 'mur-nouveau' && Math.hypot(geste.b[0] - geste.a[0], geste.b[1] - geste.a[1]) > 0.2) {
      memo();
      const w: Mur = { id: `m${Date.now().toString(36)}`, a: geste.a, b: geste.b, epaisseur: 0.1, hauteur: modele.hauteurSousPlafond, exterieur: false, source: 'deduit' };
      modele.murs.push(w);
      selection = { type: 'mur', id: w.id };
    }
    if (geste && geste.type !== 'pan') { sauver(); majProps(); }
    geste = null;
    dessiner2D();
  };
  plan.addEventListener('pointerup', fin);
  plan.addEventListener('pointercancel', fin);
  plan.addEventListener('wheel', (e) => { e.preventDefault(); v2.s = THREE.MathUtils.clamp(v2.s * (e.deltaY < 0 ? 1.1 : 0.9), 8, 400); dessiner2D(); }, { passive: false });

  function poserOuverture(p: P2, type: TypeOuverture) {
    const best = modele.murs.map((w) => ({ w, ...projeter(w, p) })).sort((a, b) => a.d - b.d)[0];
    if (!best || best.d > 0.4) return;
    const dims = type === 'porte' ? { largeur: 0.83, hauteur: 2.04, allege: 0 } : type === 'porte_fenetre' ? { largeur: 1.2, hauteur: 2.15, allege: 0 } : { largeur: 1.2, hauteur: 1.45, allege: 0.9 };
    const L = longueur(best.w);
    const largeur = Math.min(dims.largeur, L - 0.1);
    if (largeur < 0.4) return;
    memo();
    const o: Ouverture3D = { id: `o${Date.now().toString(36)}`, mur: best.w.id, t: THREE.MathUtils.clamp(snap(best.t), largeur / 2, L - largeur / 2), ...dims, largeur, type, source: 'deduit' };
    modele.ouvertures.push(o);
    if (type !== 'porte') best.w.exterieur = true;
    selection = { type: 'ouverture', id: o.id };
    sauver(); majProps(); dessiner2D();
  }

  // --- Panneau de propriétés (édition en profondeur) -------------------------------------
  const props = $('#stProps');
  function champ(label: string, valeur: number, min: number, max: number, pas: number, maj: (v: number) => void) {
    const l = document.createElement('label');
    l.innerHTML = `<span>${label}</span><input type="number" min="${min}" max="${max}" step="${pas}" value="${valeur.toFixed(2)}" />`;
    const i = l.querySelector('input')!;
    i.onchange = () => { const v = parseFloat(i.value.replace(',', '.')); if (Number.isFinite(v)) { memo(); maj(THREE.MathUtils.clamp(v, min, max)); sauver(); rafraichir(); } };
    return l;
  }
  function bouton(txt: string, f: () => void) { const b = document.createElement('button'); b.type = 'button'; b.className = 'pastille'; b.textContent = txt; b.onclick = () => { memo(); f(); sauver(); rafraichir(); }; return b; }
  function rafraichir() { if (vue === '2d') dessiner2D(); else construire(); majProps(); }

  function majProps() {
    props.innerHTML = '';
    props.hidden = vue !== '2d' || !selection;
    if (props.hidden || !selection) return;
    const ligne = document.createElement('div');
    ligne.className = 'ligne serre';
    if (selection.type === 'mur') {
      const w = modele.murs.find((x) => x.id === selection!.id);
      if (!w) return void (props.hidden = true);
      props.insertAdjacentHTML('beforeend', `<b>Mur</b> <span class="doux">${w.source === 'mesure' ? 'mesuré (scan)' : w.source === 'genere' ? 'généré' : 'saisi'} · glisse les ronds pour le déplacer</span>`);
      ligne.append(
        champ('Longueur', longueur(w), 0.1, 50, 0.01, (v) => { const [dx, dy] = direction(w); w.b = [w.a[0] + dx * v, w.a[1] + dy * v]; }),
        champ('Épaisseur', w.epaisseur, 0.05, 0.8, 0.01, (v) => (w.epaisseur = v)),
        champ('Hauteur', w.hauteur, 2, 6, 0.01, (v) => (w.hauteur = v)),
      );
      props.append(ligne);
      const l2 = document.createElement('div'); l2.className = 'ligne serre';
      l2.append(
        bouton(w.exterieur ? '✓ Mur extérieur' : 'Mur intérieur', () => { w.exterieur = !w.exterieur; if (w.exterieur) w.epaisseur = Math.max(w.epaisseur, 0.25); }),
        bouton('✂ Couper en deux', () => { const m = pointSurMur(w, longueur(w) / 2); const n: Mur = { ...w, id: `m${Date.now().toString(36)}`, a: m }; w.b = m; modele.murs.push(n); for (const o of modele.ouvertures.filter((x) => x.mur === w.id && x.t > longueur(w))) { o.mur = n.id; o.t -= longueur(w); } }),
        bouton('🗑 Supprimer', () => { modele.murs = modele.murs.filter((x) => x !== w); modele.ouvertures = modele.ouvertures.filter((o) => o.mur !== w.id); selection = null; }),
      );
      props.append(l2);
    } else if (selection.type === 'ouverture') {
      const o = modele.ouvertures.find((x) => x.id === selection!.id);
      const w = o && modele.murs.find((x) => x.id === o.mur);
      if (!o || !w) return void (props.hidden = true);
      const az = modele.azimutBas !== undefined && o.type !== 'porte' ? azimutPlan(modele.azimutBas, normaleExterieure(modele, w)) : null;
      props.insertAdjacentHTML('beforeend', `<b>${{ fenetre: 'Fenêtre', porte_fenetre: 'Porte-fenêtre', porte: 'Porte', baie: 'Baie libre' }[o.type]}</b> <span class="doux">${az !== null ? `orientée ${cardinal(az)} (${az.toFixed(0)}°) · ` : ''}touche-la encore et glisse pour la déplacer</span>`);
      ligne.append(
        champ('Largeur', o.largeur, 0.3, longueur(w), 0.01, (v) => { o.largeur = v; o.t = THREE.MathUtils.clamp(o.t, v / 2, longueur(w) - v / 2); }),
        champ('Hauteur', o.hauteur, 0.3, w.hauteur, 0.01, (v) => (o.hauteur = Math.min(v, w.hauteur - o.allege))),
        champ('Allège', o.allege, 0, 2, 0.01, (v) => (o.allege = Math.min(v, w.hauteur - o.hauteur))),
        champ('Depuis le coin', o.t - o.largeur / 2, 0, longueur(w), 0.01, (v) => (o.t = THREE.MathUtils.clamp(v + o.largeur / 2, o.largeur / 2, longueur(w) - o.largeur / 2))),
      );
      props.append(ligne);
      const sel = document.createElement('select');
      sel.className = 'pastille';
      sel.innerHTML = (['fenetre', 'porte_fenetre', 'porte', 'baie'] as const).map((t) => `<option value="${t}" ${t === o.type ? 'selected' : ''}>${{ fenetre: 'Fenêtre', porte_fenetre: 'Porte-fenêtre', porte: 'Porte', baie: 'Baie libre' }[t]}</option>`).join('');
      sel.onchange = () => { memo(); o.type = sel.value as TypeOuverture; sauver(); rafraichir(); };
      const l2 = document.createElement('div'); l2.className = 'ligne serre';
      l2.append(sel, bouton('🗑 Supprimer', () => { modele.ouvertures = modele.ouvertures.filter((x) => x !== o); selection = null; }));
      props.append(l2);
    } else {
      const p = modele.pieces.find((x) => x.id === selection!.id);
      if (!p) return void (props.hidden = true);
      props.insertAdjacentHTML('beforeend', `<b>${nomPiece3D(p)}</b> <span class="doux">${aireContour(p.contour).toFixed(1)} m²</span>`);
      const sel = document.createElement('select');
      sel.className = 'pastille';
      sel.innerHTML = Object.entries(PIECES).map(([k, v]) => `<option value="${k}" ${k === p.type ? 'selected' : ''}>${v.nom}</option>`).join('');
      sel.onchange = () => { memo(); p.type = sel.value as TypePiece; delete p.nom; sauver(); rafraichir(); };
      const nom = document.createElement('input');
      nom.placeholder = 'Nom (ex. Chambre parents)'; nom.value = p.nom ?? ''; nom.className = 'pastille';
      nom.onchange = () => { memo(); if (nom.value.trim()) p.nom = nom.value.trim(); else delete p.nom; sauver(); rafraichir(); };
      ligne.append(sel, nom, champ('Sous plafond (logement)', modele.hauteurSousPlafond, 2, 6, 0.01, (v) => { modele.hauteurSousPlafond = v; for (const w of modele.murs) w.hauteur = v; }));
      props.append(ligne);
    }
  }

  ui.querySelectorAll<HTMLButtonElement>('[data-outil]').forEach((b) => (b.onclick = () => {
    outil = b.dataset.outil as typeof outil;
    ui.querySelectorAll('[data-outil]').forEach((x) => x.classList.toggle('actif', x === b));
  }));
  $('#stAnnuler').onclick = () => { const s = historique.pop(); if (s) { modele = JSON.parse(s) as Modele; sauver(); rafraichir(); } };

  // --- Sources ------------------------------------------------------------------------
  function charger(m: Modele, message: string) {
    memo();
    modele = m;
    selection = null;
    scanGroupe.clear();
    sauver();
    $('#stMenu').hidden = true;
    majOrient();
    changerVue(vue === '2d' ? '2d' : 'maquette');
    majSoleil();
    info(message);
  }
  const info = (t: string) => { $('#stInfo').textContent = t; };
  function majInfo() {
    const e = erreursModele(modele);
    const surf = modele.pieces.reduce((s, p) => s + aireContour(p.contour), 0);
    const mes = modele.murs.filter((w) => w.source === 'mesure').length;
    $('#stInfo').innerHTML = `${modele.pieces.length} pièces · ${surf.toFixed(1)} m² · ${modele.murs.length} murs${mes ? ` (${mes} mesurés)` : ''} · ${modele.ouvertures.length} ouvertures`
      + (e.length ? ` · <span class="err">${e[0]}</span>` : '');
  }
  ui.querySelectorAll<HTMLButtonElement>('button[data-src]').forEach((b) => (b.onclick = () => {
    const s = b.dataset.src;
    if (s === 'plan') {
      const p = relire<Plan>('lumen:plan:courant');
      if (!p || !p.pieces.length) return info('Aucun plan 2D enregistré : ouvre l’éditeur de plan.');
      charger(depuisPlan(p), 'Plan 2D Lumen chargé.');
    } else if (s === 'editeur') { $('#stMenu').hidden = true; opts.ouvrirPlan2D(); }
    else if (s === 'demo') charger(depuisPlan(planModele('t3')), 'Démo T3.');
    else if (s === 'vide') charger(modeleVide(), 'Modèle vide : dessine tes murs en vue Plan 2D.');
  }));
  const lire = (f: File, mode: 'texte' | 'binaire') => new Promise<string | ArrayBuffer>((ok, ko) => {
    const r = new FileReader(); r.onload = () => ok(r.result!); r.onerror = () => ko(r.error);
    if (mode === 'texte') r.readAsText(f); else r.readAsArrayBuffer(f);
  });
  ui.querySelectorAll<HTMLInputElement>('input[data-src]').forEach((inp) => (inp.onchange = async () => {
    const f = inp.files?.[0];
    inp.value = '';
    if (!f) return;
    try {
      if (inp.dataset.src === 'roomplan') {
        const m = depuisRoomPlan(JSON.parse((await lire(f, 'texte')) as string) as CapturedRoomJSON);
        if (modele.azimutBas !== undefined) m.azimutBas = modele.azimutBas;
        charger(m, `Scan RoomPlan : ${m.murs.length} murs, ${m.ouvertures.length} ouvertures, ${m.objets.length} meubles (mesurés).`);
      } else if (inp.dataset.src === 'dxf') {
        const m = depuisDXF((await lire(f, 'texte')) as string);
        charger(m, `Plan DXF : ${m.murs.length} murs importés. Ajoute fenêtres et portes en vue Plan 2D.`);
      } else await chargerScan(f);
    } catch (e) {
      info(`Import impossible : ${(e as Error).message}`);
    }
  }));

  async function chargerScan(f: File) {
    const ext = f.name.split('.').pop()?.toLowerCase();
    const buf = (await lire(f, 'binaire')) as ArrayBuffer;
    let obj: THREE.Object3D;
    if (ext === 'glb' || ext === 'gltf') obj = (await new GLTFLoader().parseAsync(buf, '')).scene;
    else if (ext === 'obj') obj = new OBJLoader().parse(new TextDecoder().decode(buf));
    else if (ext === 'usdz') obj = new USDZLoader().parse(buf);
    else throw new Error('format non reconnu');
    const bb = new THREE.Box3().setFromObject(obj);
    if (bb.isEmpty()) throw new Error('fichier vide ou USDZ binaire non pris en charge (exporte en GLB)');
    const t = bb.getSize(new THREE.Vector3());
    if (Math.max(t.x, t.y, t.z) > 200) obj.scale.setScalar(0.01); // cm → m
    bb.setFromObject(obj);
    const [x0, y0, x1, y1] = emprise(modele);
    const c = bb.getCenter(new THREE.Vector3());
    obj.position.add(new THREE.Vector3((x0 + x1) / 2 - c.x, -bb.min.y, -(y0 + y1) / 2 - c.z));
    obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = o.receiveShadow = true; } });
    scanGroupe.clear();
    scanGroupe.add(obj);
    racine.visible = false;
    $('#stMenu').hidden = true;
    changerVue('maquette');
    info(`Scan 3D affiché (${t.x.toFixed(1)} × ${t.z.toFixed(1)} m, mesuré). Touche « Modèle » pour revenir au modèle éditable.`);
    afficherBasculeScan();
  }
  function afficherBasculeScan() {
    let b = ui.querySelector<HTMLButtonElement>('#stScan');
    if (!b) {
      b = document.createElement('button'); b.id = 'stScan'; b.className = 'pastille'; b.type = 'button';
      Array.from(ui.querySelectorAll('#stPied .ligne')).pop()!.append(b);
    }
    const maj = () => { b!.textContent = racine.visible ? 'Voir le scan' : 'Modèle'; };
    b.onclick = () => { racine.visible = !racine.visible; scanGroupe.visible = !racine.visible; maj(); };
    scanGroupe.visible = true;
    maj();
  }

  // --- Orientation, temps, qualité ---------------------------------------------------------
  const selOrient = $<HTMLSelectElement>('#stOrient');
  function majOrient() {
    selOrient.innerHTML = `<option value="">Orientation ?</option>` +
      ['Nord', 'Nord-Est', 'Est', 'Sud-Est', 'Sud', 'Sud-Ouest', 'Ouest', 'Nord-Ouest'].map((n, i) => `<option value="${i * 45}">↓ ${n}</option>`).join('');
    selOrient.value = modele.azimutBas !== undefined ? String((Math.round(modele.azimutBas / 45) * 45) % 360) : '';
  }
  selOrient.onchange = () => { if (selOrient.value === '') delete modele.azimutBas; else modele.azimutBas = +selOrient.value; sauver(); majSoleil(); if (vue === '2d') dessiner2D(); };
  $<HTMLInputElement>('#stHeure').oninput = majSoleil;
  ui.querySelectorAll<HTMLButtonElement>('[data-stdate]').forEach((b) => (b.onclick = () => { jour = `${new Date().getFullYear()}-${b.dataset.stdate}`; majSoleil(); }));
  $('#stQualite').onclick = () => { ultra = !ultra; majQualite(); };
  $('#stCoupe').onclick = () => { murCoupes = !murCoupes; $('#stCoupe').classList.toggle('actif', murCoupes); construire(); };
  $('#stCoupe').classList.toggle('actif', murCoupes);
  ui.querySelectorAll<HTMLButtonElement>('[data-vue]').forEach((b) => (b.onclick = () => changerVue(b.dataset.vue as Vue)));
  $('#stSources').onclick = () => ($('#stMenu').hidden = !$('#stMenu').hidden);
  $('#stFermer').onclick = () => { ui.hidden = true; document.body.classList.remove('studio'); renderer.setAnimationLoop(null); };

  function redim() {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    composer?.setSize(innerWidth, innerHeight);
    if (vue === '2d') dessiner2D();
  }
  addEventListener('resize', () => { if (!ui.hidden) redim(); });

  let avant = performance.now();
  function boucle(t: number) {
    const dt = Math.min(0.1, (t - avant) / 1000);
    avant = t;
    if (vue === '2d') return;
    if (vue === 'visite') {
      let av = visite.avance, lat = visite.lateral;
      if (touches.has('z') || touches.has('w') || touches.has('arrowup')) av = 1;
      if (touches.has('s') || touches.has('arrowdown')) av = -1;
      if (touches.has('q') || touches.has('a') || touches.has('arrowleft')) lat = -1;
      if (touches.has('d') || touches.has('arrowright')) lat = 1;
      const v = 1.4 * dt;
      visite.pos.x += (-Math.sin(visite.yaw) * av + Math.cos(visite.yaw) * lat) * v;
      visite.pos.z += (-Math.cos(visite.yaw) * av - Math.sin(visite.yaw) * lat) * v;
      camera.position.copy(visite.pos);
      camera.rotation.set(visite.pitch, visite.yaw, 0, 'YXZ');
    } else orbite.update();
    if (composer) composer.render(); else renderer.render(scene, camera);
  }

  function ouvrir(source?: Modele) {
    ui.hidden = false;
    document.body.classList.add('studio');
    if (source) { modele = source; sauver(); }
    majOrient();
    majQualite();
    redim();
    changerVue(vue);
    majSoleil();
    renderer.setAnimationLoop(boucle);
  }

  return {
    ouvrir,
    /** Ouvre le studio avec un plan 2D Lumen. */
    depuisPlan2D: (p: Plan) => ouvrir(depuisPlan(p)),
  };
}
