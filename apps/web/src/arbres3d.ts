/**
 * Arbres 3D procéduraux par espèce, à la hauteur et à la couronne mesurées, feuillage selon la date :
 * débourrement, vert tendre, floraison, été, coloration d'automne (palette propre à l'espèce), chute, branches nues.
 * Rendu instancié (un modèle par espèce et par niveau de détail), ombres portées avec les trous du feuillage.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ESPECES, feuillage, jourAnnee, type Arbre, type Espece } from '@lumen/vegetation';

const H0 = 10; // hauteur du modèle de référence (m)

// --- Textures de feuilles (dessinées une fois, sans fichier) ---------------------
type Feuille = 'large' | 'ovale' | 'fine' | 'aiguille';
const FEUILLE: Record<string, Feuille> = {
  platane: 'large', erable: 'large', marronnier: 'large', paulownia: 'large', liquidambar: 'large', chene: 'ovale', tilleul: 'ovale',
  sophora: 'fine', robinier: 'fine', frene: 'fine', ailante: 'fine', saule: 'fine', pin: 'aiguille', conifere: 'aiguille',
};
const texCache = new Map<string, THREE.Texture>();
function texFeuilles(type: Feuille | 'fleurs'): THREE.Texture {
  const k = type;
  let t = texCache.get(k);
  if (t) return t;
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  let s = 7;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const n = type === 'aiguille' ? 140 : type === 'fine' ? 70 : type === 'fleurs' ? 120 : 34;
  for (let i = 0; i < n; i++) {
    const x = S * (0.12 + r() * 0.76), y = S * (0.12 + r() * 0.76), a = r() * Math.PI * 2, l = 0.55 + r() * 0.45;
    // Luminance seule : la couleur vient de la saison (uniform), la texture donne la matière et l'ombre interne.
    g.fillStyle = `rgb(${Math.round(255 * l)},${Math.round(255 * l)},${Math.round(255 * l)})`;
    g.save(); g.translate(x, y); g.rotate(a);
    g.beginPath();
    if (type === 'large') { for (let k2 = 0; k2 < 5; k2++) { const b = (k2 / 5) * Math.PI * 2; g.ellipse(Math.cos(b) * 7, Math.sin(b) * 7, 13, 6, b, 0, Math.PI * 2); } }
    else if (type === 'ovale') g.ellipse(0, 0, 16, 10, 0, 0, Math.PI * 2);
    else if (type === 'fine') g.ellipse(0, 0, 11, 4, 0, 0, Math.PI * 2);
    else if (type === 'aiguille') { g.rect(-16, -1.5, 32, 3); g.rect(-1.5, -16, 3, 32); g.rect(-11, -11, 3, 22); g.rect(-11, -11, 22, 3); }
    else { for (let k2 = 0; k2 < 5; k2++) { const b = (k2 / 5) * Math.PI * 2; g.moveTo(Math.cos(b) * 7 + 6.5, Math.sin(b) * 7); g.arc(Math.cos(b) * 7, Math.sin(b) * 7, 6.5, 0, Math.PI * 2); } }
    g.fill();
    g.restore();
  }
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(k, t);
  return t;
}

// --- Squelette procédural ----------------------------------------------------------
interface Branche { a: THREE.Vector3; b: THREE.Vector3; r0: number; r1: number; niveau: number }
function rng(seed: number) { let x = seed % 2147483646 || 1; return () => ((x = (x * 16807) % 2147483647) / 2147483647); }

function squelette(e: Espece, detail: boolean, seed: number): { branches: Branche[]; bouts: THREE.Vector3[] } {
  const R = rng(seed);
  const H = H0, fut = H * e.fut, rc = H * e.rayonSurHauteur;
  const cy = fut + (H - fut) * 0.5, ry = (H - fut) * 0.5;
  const branches: Branche[] = [], bouts: THREE.Vector3[] = [];
  const rTronc = H * 0.028;
  const tronc = new THREE.Vector3(0, e.forme === 'conique' || e.forme === 'colonne' ? H * 0.92 : fut + (H - fut) * 0.25, 0);
  branches.push({ a: new THREE.Vector3(), b: tronc.clone(), r0: rTronc, r1: rTronc * 0.62, niveau: 0 });
  const dansCouronne = (p: THREE.Vector3) => {
    if (e.forme === 'conique') { const t = (p.y - fut) / (H - fut); return p.y > fut && p.y < H && Math.hypot(p.x, p.z) < rc * (1 - t) * 1.1; }
    if (e.forme === 'parasol') return p.y > H * 0.7 && Math.hypot(p.x, p.z) < rc && p.y < H;
    const dy = (p.y - cy) / ry;
    return Math.hypot(p.x / rc, dy, p.z / rc) < 1;
  };
  const cible = (): THREE.Vector3 => {
    for (let k = 0; k < 30; k++) {
      const p = new THREE.Vector3((R() * 2 - 1) * rc, fut + R() * (H - fut), (R() * 2 - 1) * rc);
      if (e.forme === 'pleureur') p.y = fut + (H - fut) * (0.6 + R() * 0.4);
      if (dansCouronne(p)) return p;
    }
    return new THREE.Vector3(0, cy, 0);
  };
  const nMain = e.forme === 'conique' ? 9 : e.forme === 'colonne' ? 6 : 5;
  for (let i = 0; i < nMain; i++) {
    const depart = e.forme === 'conique'
      ? new THREE.Vector3(0, fut + ((H * 0.9 - fut) * i) / nMain, 0)
      : tronc.clone().lerp(new THREE.Vector3(0, fut, 0), R() * 0.6);
    let fin = cible();
    if (e.forme === 'conique') { const a = i * 2.4; const t = (depart.y - fut) / (H - fut); fin = new THREE.Vector3(Math.cos(a) * rc * (1 - t), depart.y + 0.6, Math.sin(a) * rc * (1 - t)); }
    if (e.forme === 'colonne') fin.set(fin.x * 0.6, Math.max(fin.y, cy), fin.z * 0.6);
    if (e.forme === 'parasol') { const a = (i / nMain) * Math.PI * 2 + R(); fin = new THREE.Vector3(Math.cos(a) * rc * 0.8, H * 0.88, Math.sin(a) * rc * 0.8); }
    const r0 = rTronc * 0.55;
    branches.push({ a: depart, b: fin, r0, r1: r0 * 0.35, niveau: 1 });
    const nSub = detail ? 4 : 2;
    for (let j = 0; j < nSub; j++) {
      const a2 = depart.clone().lerp(fin, 0.35 + R() * 0.6);
      let b2 = a2.clone().add(new THREE.Vector3((R() * 2 - 1) * rc * 0.45, (R() * 0.8 - 0.2) * ry * 0.6, (R() * 2 - 1) * rc * 0.45));
      if (e.forme === 'pleureur') b2 = a2.clone().add(new THREE.Vector3((R() * 2 - 1) * rc * 0.4, -ry * (0.5 + R() * 0.7), (R() * 2 - 1) * rc * 0.4));
      if (!dansCouronne(b2) && e.forme !== 'pleureur') b2.lerp(new THREE.Vector3(0, cy, 0), 0.3);
      branches.push({ a: a2, b: b2, r0: r0 * 0.3, r1: r0 * 0.08, niveau: 2 });
      const nT = detail ? 3 : 1;
      for (let k = 0; k < nT; k++) {
        const a3 = a2.clone().lerp(b2, 0.4 + R() * 0.6);
        const b3 = a3.clone().add(new THREE.Vector3((R() * 2 - 1) * 1.2, (R() * 2 - 0.6) * 0.9, (R() * 2 - 1) * 1.2));
        if (detail) branches.push({ a: a3, b: b3, r0: r0 * 0.07, r1: r0 * 0.02, niveau: 3 });
        bouts.push(b3);
      }
      bouts.push(b2);
    }
    bouts.push(fin);
  }
  return { branches, bouts };
}

function geoBois(branches: Branche[], detail: boolean): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (const b of branches) {
    if (!detail && b.niveau > 2) continue;
    const L = b.a.distanceTo(b.b);
    if (L < 0.05) continue;
    const g = new THREE.CylinderGeometry(b.r1, b.r0, L, b.niveau === 0 ? 8 : b.niveau === 1 ? 6 : 4, 1, b.niveau > 0);
    const dir = b.b.clone().sub(b.a).normalize();
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir));
    g.translate((b.a.x + b.b.x) / 2, (b.a.y + b.b.y) / 2, (b.a.z + b.b.z) / 2);
    g.deleteAttribute('uv');
    geos.push(g);
  }
  const m = mergeGeometries(geos, false)!;
  geos.forEach((g) => g.dispose());
  return m;
}

/** Cartes de feuillage autour des extrémités des rameaux. Attributs : aRand (ordre de chute), aAut (teinte d'automne). */
function geoCartes(bouts: THREE.Vector3[], nb: number, taille: number, seed: number, haut = false): THREE.BufferGeometry {
  const R = rng(seed);
  const pos: number[] = [], uv: number[] = [], nor: number[] = [], rnd: number[] = [], aut: number[] = [], idx: number[] = [];
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  for (let i = 0; i < nb; i++) {
    const b = bouts[Math.floor(R() * bouts.length)]!;
    const c = b.clone().add(new THREE.Vector3((R() * 2 - 1) * 1.1, (R() * 2 - 1) * 0.8, (R() * 2 - 1) * 1.1));
    if (haut) c.y += 0.4;
    q.setFromEuler(e.set(R() * Math.PI, R() * Math.PI * 2, R() * Math.PI));
    const s = taille * (0.7 + R() * 0.6);
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    // normales tournées vers l'extérieur de la couronne : éclairage « volumique » du feuillage
    const ext = c.clone().setY(c.y * 0.3).normalize();
    const nn = n.dot(ext) < 0 ? n.negate() : n;
    nn.lerp(ext, 0.6).normalize();
    const r1 = R(), r2 = R(), base = pos.length / 3;
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
      const p = new THREE.Vector3((u - 0.5) * s, (v - 0.5) * s, 0).applyQuaternion(q).add(c);
      pos.push(p.x, p.y, p.z); uv.push(u, v); nor.push(nn.x, nn.y, nn.z); rnd.push(r1); aut.push(r2);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aRand', new THREE.Float32BufferAttribute(rnd, 1));
  g.setAttribute('aAut', new THREE.Float32BufferAttribute(aut, 1));
  g.setIndex(idx);
  return g;
}

// --- Matériaux saisonniers ------------------------------------------------------------
interface Saison { uPart: { value: number }; uPente: { value: number }; uCouleur: { value: THREE.Color }; uAutomne: { value: number }; uPenteAut: { value: number }; uPalette: { value: THREE.Color[] } }

function patch(m: THREE.Material, u: Saison, couleur: boolean) {
  // une variante de shader par usage (sinon three.js réutilise le premier programme compilé)
  m.customProgramCacheKey = () => `arbre-${couleur ? 'feuilles' : 'neutre'}`;
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aRand; attribute float aAut; attribute float aDec;\nvarying float vRand; varying float vAut; varying float vDec;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRand = aRand; vAut = aAut; vDec = aDec;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uPart, uPente, uAutomne, uPenteAut; uniform vec3 uCouleur; uniform vec3 uPalette[4];\nvarying float vRand; varying float vAut; varying float vDec;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        // Chaque arbre a son propre calendrier (vDec, en jours) : les feuilles tombent dans un ordre aléatoire (vRand).
        if (vRand > uPart - vDec * uPente) discard;
        ${couleur ? `float aut = clamp(uAutomne - vDec * uPenteAut, 0.0, 1.0);
        vec3 pal = uPalette[int(clamp(vAut * 4.0, 0.0, 3.0))];
        // l'automne gagne feuille par feuille, pas en fondu uniforme
        vec3 c = mix(uCouleur, pal, smoothstep(vAut * 0.7, vAut * 0.7 + 0.3, aut));
        diffuseColor.rgb *= c;` : ''}`);
  };
}

interface Modele { bois: THREE.BufferGeometry; feuilles: THREE.BufferGeometry; fleurs?: THREE.BufferGeometry }
const modeles = new Map<string, Modele>();
function modele(e: Espece, detail: boolean): Modele {
  const k = `${e.id}|${detail}`;
  let m = modeles.get(k);
  if (m) return m;
  const seed = [...e.id].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) % 100000;
  const sq = squelette(e, detail, seed);
  const taille = e.persistant ? 1.3 : FEUILLE[e.id] === 'fine' ? 1.1 : 1.4;
  m = {
    bois: geoBois(sq.branches, detail),
    feuilles: geoCartes(sq.bouts, Math.round((detail ? 320 * e.densite + 90 : 60) * (e.persistant ? 1.8 : 1)), detail ? taille : taille * 2.2, seed + 1),
    fleurs: e.fleurs ? geoCartes(sq.bouts, detail ? 320 : 60, detail ? 1.3 : 2.4, seed + 2, true) : undefined,
  };
  modeles.set(k, m);
  return m;
}

// --- Forêt instanciée -------------------------------------------------------------------
export interface Foret {
  groupe: THREE.Group;
  majSaison: (d: Date) => void;
  liberer: () => void;
  nombre: number;
}

export function creerForet(arbres: Arbre[], placer: (a: Arbre) => THREE.Vector3, distance: (a: Arbre) => number, rayonDetail: number): Foret {
  const groupe = new THREE.Group();
  groupe.name = 'arbres';
  const parEspece = new Map<string, Arbre[]>();
  for (const a of arbres) { const l = parEspece.get(a.espece); if (l) l.push(a); else parEspece.set(a.espece, [a]); }
  const saisons: { e: Espece; feuilles: Saison; fleurs?: Saison }[] = [];
  const mats: THREE.Material[] = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

  const saison = (e: Espece): Saison => ({
    uPart: { value: 1 }, uPente: { value: 0 }, uCouleur: { value: new THREE.Color(e.ete) }, uAutomne: { value: 0 }, uPenteAut: { value: 0 },
    uPalette: { value: [0, 1, 2, 3].map((i) => new THREE.Color(e.automne[i % e.automne.length]!)) },
  });

  for (const [id, liste] of parEspece) {
    const e = ESPECES[id] ?? ESPECES.feuillu!;
    const sF = saison(e), sFl = e.fleurs ? saison(e) : undefined;
    if (sFl) sFl.uCouleur.value.set(e.fleurs!.couleur);
    saisons.push({ e, feuilles: sF, fleurs: sFl });
    for (const detail of [true, false]) {
      const sel = liste.filter((a) => (distance(a) < rayonDetail) === detail);
      if (!sel.length) continue;
      const mod = modele(e, detail);
      const ecorce = new THREE.MeshStandardMaterial({ color: e.ecorce, roughness: 0.95 });
      const feuilleMat = new THREE.MeshStandardMaterial({ map: texFeuilles(FEUILLE[e.id] ?? 'ovale'), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.75 });
      patch(feuilleMat, sF, true);
      const prof = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: feuilleMat.map, alphaTest: 0.5 });
      patch(prof, sF, false);
      mats.push(ecorce, feuilleMat, prof);
      const dec = new Float32Array(sel.length);
      const meshes: THREE.InstancedMesh[] = [];
      const bois = new THREE.InstancedMesh(mod.bois, ecorce, sel.length);
      const feu = new THREE.InstancedMesh(mod.feuilles.clone(), feuilleMat, sel.length);
      feu.customDepthMaterial = prof;
      meshes.push(bois, feu);
      if (mod.fleurs && sFl) {
        const fm = new THREE.MeshStandardMaterial({ map: texFeuilles('fleurs'), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6, color: e.fleurs!.couleur });
        patch(fm, sFl, false);
        const fl = new THREE.InstancedMesh(mod.fleurs.clone(), fm, sel.length);
        mats.push(fm);
        meshes.push(fl);
      }
      const jitter = new THREE.Color();
      sel.forEach((a, i) => {
        const h = a.hauteur.valeur, r = a.rayonCouronne.valeur;
        const sy = h / H0, sxz = r / (H0 * e.rayonSurHauteur);
        q.setFromAxisAngle(up, ((a.decalage * 977) % 360) * (Math.PI / 180));
        s.set(sxz, sy, sxz);
        m4.compose(placer(a), q, s);
        dec[i] = a.decalage;
        for (const me of meshes) me.setMatrixAt(i, m4);
        const v = 0.88 + ((Math.abs(a.decalage) * 37) % 1) * 0.24;
        feu.setColorAt(i, jitter.setRGB(v, v, v * 0.96));
      });
      for (const me of meshes) {
        if (me !== bois) me.geometry.setAttribute('aDec', new THREE.InstancedBufferAttribute(dec, 1));
        me.castShadow = true;
        me.receiveShadow = true;
        me.frustumCulled = false;
        groupe.add(me);
      }
    }
  }

  function majSaison(d: Date) {
    const j = jourAnnee(d);
    for (const { e, feuilles: sF, fleurs: sFl } of saisons) {
      const a = feuillage(e, j), b = feuillage(e, j + 1);
      sF.uPart.value = a.feuilles;
      sF.uPente.value = b.feuilles - a.feuilles;
      sF.uCouleur.value.set(a.couleur);
      sF.uAutomne.value = a.automne;
      sF.uPenteAut.value = b.automne - a.automne;
      if (sFl) {
        sFl.uPart.value = a.fleurs;
        sFl.uPente.value = b.fleurs - a.fleurs;
      }
    }
  }

  return {
    groupe,
    majSaison,
    nombre: arbres.length,
    liberer: () => {
      groupe.traverse((o) => { const m = o as THREE.InstancedMesh; if (m.isInstancedMesh && !([...modeles.values()].some((x) => x.bois === m.geometry))) m.geometry.dispose(); });
      mats.forEach((m) => m.dispose());
      groupe.clear();
    },
  };
}
