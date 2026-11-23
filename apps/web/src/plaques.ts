/**
 * Plaques de rue et numéros d'immeubles, au modèle parisien (émail bleu, cadre vert, lettres blanches).
 *
 * Données :
 *  - numéros : Base Adresse Nationale (BAN, positions fournies par la Ville de Paris), via la Géoplateforme IGN ;
 *  - noms de rue et arrondissement : BD TOPO (nom BAN de chaque tronçon, code INSEE).
 * Placement :
 *  - numéro : sur la façade de l'immeuble, là où la ligne adresse → rue la plus proche de même nom
 *    traverse la façade côté rue, à 2,6 m du sol ;
 *  - plaque de rue : à chaque carrefour, sur l'immeuble d'angle de chaque côté de la rue, à 3,6 m du sol,
 *    à 1,2 m de l'angle (comme à Paris).
 */
import * as THREE from 'three';
import type { XY } from '@lumen/core';
import type { Troncon } from '@lumen/urban';

const GEOPF = 'https://data.geopf.fr';

export interface AdresseBan { numero: string; rep: string; voie: string; p: XY }

/** Adresses BAN dans un carré de ± rayon mètres (Lambert-93 fourni par la BAN). */
export async function adressesAutour(lon: number, lat: number, rayon: number): Promise<AdresseBan[]> {
  const dLat = rayon / 111_320, dLon = rayon / (111_320 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].join(',');
  const out: AdresseBan[] = [];
  for (let debut = 0; debut < 20_000; debut += 2000) {
    const url = `${GEOPF}/wfs/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=BAN.DATA.GOUV:ban&outputFormat=application/json&srsName=EPSG:4326&count=2000&startIndex=${debut}&bbox=${bbox},urn:ogc:def:crs:EPSG::4326`;
    const r = await fetch(url);
    if (!r.ok) break;
    const j = (await r.json()) as { features: { properties: { numero: string; rep: string; nom_voie: string; x: string; y: string } }[] };
    for (const f of j.features) {
      const p = f.properties;
      if (!p.numero || p.numero === '99999') continue; // lieux-dits sans numéro
      out.push({ numero: p.numero, rep: (p.rep ?? '').toLowerCase(), voie: p.nom_voie, p: { x: +p.x, y: +p.y } });
    }
    if (j.features.length < 2000) break;
  }
  return out;
}

/** Un pan de façade visible : segment (Lambert-93), normale sortante, altitude du sol. */
export interface PanFacade { a: XY; b: XY; n: XY; sol: number }

// --- Textures émaillées -------------------------------------------------------------------------
const BLEU = '#173a73', VERT = '#2f6b45', BLANC = '#f4f6f2';
const POLICE = '"Helvetica Neue", "Arial Narrow", Arial, sans-serif';

function cadre(ctx: CanvasRenderingContext2D, w: number, h: number, r: number) {
  const rr = (x: number, y: number, W: number, H: number, R: number) => {
    ctx.beginPath();
    ctx.moveTo(x + R, y);
    ctx.arcTo(x + W, y, x + W, y + H, R);
    ctx.arcTo(x + W, y + H, x, y + H, R);
    ctx.arcTo(x, y + H, x, y, R);
    ctx.arcTo(x, y, x + W, y, R);
    ctx.closePath();
  };
  const e = h * 0.07;
  ctx.fillStyle = VERT; // cadre vert
  rr(0, 0, w, h, r);
  ctx.fill();
  ctx.fillStyle = BLANC; // filet blanc
  rr(e, e, w - 2 * e, h - 2 * e, r * 0.7);
  ctx.fill();
  ctx.fillStyle = BLEU; // émail bleu
  rr(e * 1.45, e * 1.45, w - 2.9 * e, h - 2.9 * e, r * 0.6);
  ctx.fill();
  // léger reflet de l'émail bombé
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(255,255,255,0.10)');
  g.addColorStop(0.5, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = g;
  rr(e * 1.45, e * 1.45, w - 2.9 * e, h - 2.9 * e, r * 0.6);
  ctx.fill();
}

/** Texte blanc centré, comprimé horizontalement si besoin (lettres étroites des plaques parisiennes). */
function texte(ctx: CanvasRenderingContext2D, t: string, cx: number, cy: number, taille: number, largeurMax: number, gras = true) {
  ctx.font = `${gras ? 'bold ' : ''}${taille}px ${POLICE}`;
  const l = ctx.measureText(t).width;
  const k = Math.min(0.86, largeurMax / Math.max(1, l)); // lettres toujours un peu condensées
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(k, 1);
  ctx.fillStyle = BLANC;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(t, 0, 0);
  ctx.restore();
}

const cacheTex = new Map<string, { tex: THREE.CanvasTexture; w: number; h: number }>();

function texturePlaque(nom: string, arrt: string, aniso: number) {
  const cle = `rue|${nom}|${arrt}`;
  if (cacheTex.has(cle)) return cacheTex.get(cle)!;
  const N = nom.toUpperCase();
  // coupure en deux lignes au-delà de ~16 caractères
  let lignes = [N];
  if (N.length > 16) {
    const mots = N.split(' ');
    let best = 1, ecart = Infinity;
    for (let i = 1; i < mots.length; i++) {
      const d = Math.abs(mots.slice(0, i).join(' ').length - mots.slice(i).join(' ').length);
      if (d < ecart) (ecart = d), (best = i);
    }
    lignes = [mots.slice(0, best).join(' '), mots.slice(best).join(' ')];
  }
  const longMax = Math.max(...lignes.map((l) => l.length));
  const hM = lignes.length === 1 ? 0.25 : 0.34; // hauteur réelle (m)
  const wM = Math.min(1.1, Math.max(0.5, 0.15 + longMax * 0.045));
  const px = 420;
  const cv = document.createElement('canvas');
  cv.width = Math.round(wM * px);
  cv.height = Math.round(hM * px);
  const ctx = cv.getContext('2d')!;
  cadre(ctx, cv.width, cv.height, cv.height * 0.12);
  const H = cv.height, W = cv.width, m = W * 0.08;
  texte(ctx, arrt, W / 2, H * (lignes.length === 1 ? 0.27 : 0.2), H * (lignes.length === 1 ? 0.16 : 0.12), W - 2 * m, false);
  if (lignes.length === 1) texte(ctx, lignes[0]!, W / 2, H * 0.62, H * 0.36, W - 2 * m);
  else lignes.forEach((l, i) => texte(ctx, l, W / 2, H * (0.46 + i * 0.3), H * 0.25, W - 2 * m));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  const r = { tex, w: wM, h: hM };
  cacheTex.set(cle, r);
  return r;
}

function textureNumero(num: string, rep: string, aniso: number) {
  const cle = `num|${num}|${rep}`;
  if (cacheTex.has(cle)) return cacheTex.get(cle)!;
  const wM = num.length >= 3 || rep ? 0.24 : 0.2, hM = 0.16, px = 600;
  const cv = document.createElement('canvas');
  cv.width = Math.round(wM * px);
  cv.height = Math.round(hM * px);
  const ctx = cv.getContext('2d')!;
  cadre(ctx, cv.width, cv.height, cv.height * 0.14);
  const W = cv.width, H = cv.height;
  if (rep) {
    texte(ctx, num, W * 0.42, H * 0.55, H * 0.6, W * 0.58);
    texte(ctx, rep, W * 0.8, H * 0.6, H * 0.26, W * 0.2, false);
  } else texte(ctx, num, W / 2, H * 0.55, H * 0.62, W * 0.78);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  const r = { tex, w: wM, h: hM };
  cacheTex.set(cle, r);
  return r;
}

// --- Géométrie -------------------------------------------------------------------------------------
const sub = (a: XY, b: XY) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: XY, b: XY) => a.x * b.x + a.y * b.y;
const norm = (a: XY) => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; };

function projSeg(p: XY, s: PanFacade) {
  const d = sub(s.b, s.a), l2 = dot(d, d) || 1;
  const t = Math.max(0, Math.min(1, dot(sub(p, s.a), d) / l2));
  const q = { x: s.a.x + d.x * t, y: s.a.y + d.y * t };
  return { q, t, d: Math.hypot(q.x - p.x, q.y - p.y) };
}

/** Intersection de la demi-droite o + u·k (k ∈ [0, L]) avec le segment s. */
function inter(o: XY, u: XY, L: number, s: PanFacade): number | null {
  const d = sub(s.b, s.a), den = u.x * d.y - u.y * d.x;
  if (Math.abs(den) < 1e-9) return null;
  const w = sub(s.a, o);
  const k = (w.x * d.y - w.y * d.x) / den, t = (w.x * u.y - w.y * u.x) / den;
  return k >= 0 && k <= L && t >= 0 && t <= 1 ? k : null;
}

const simplifier = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export interface ParamsPlaques {
  adresses: AdresseBan[];
  troncons: Troncon[];
  pans: PanFacade[];
  /** L93 + altitude → repère de la scène */
  local: (p: XY, z: number) => THREE.Vector3;
  centre: XY;
  rayon: number;
  aniso: number;
}

export function creerPlaques(P: ParamsPlaques): THREE.Group {
  const g = new THREE.Group();
  g.name = 'plaques';
  const poses = new Map<string, { tex: ReturnType<typeof textureNumero>; m: THREE.Matrix4[] }>();
  const poser = (t: ReturnType<typeof textureNumero>, cle: string, p: XY, n: XY, z: number) => {
    const pos = P.local({ x: p.x + n.x * 0.025, y: p.y + n.y * 0.025 }, z);
    const dir = new THREE.Vector3(n.x, 0, -n.y);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 1, 0));
    // lookAt oriente -Z vers la cible : on retourne pour que la face avant (+Z) regarde la rue
    m.multiply(new THREE.Matrix4().makeRotationY(Math.PI));
    m.setPosition(pos);
    if (!poses.has(cle)) poses.set(cle, { tex: t, m: [] });
    poses.get(cle)!.m.push(m);
  };
  const dansZone = (p: XY) => Math.hypot(p.x - P.centre.x, p.y - P.centre.y) < P.rayon;
  const pans = P.pans.filter((s) => dansZone(s.a) || dansZone(s.b));
  const proches = (p: XY, r: number) => pans.filter((s) => projSeg(p, s).d < r);

  // Index des tronçons par nom
  const parNom = new Map<string, Troncon[]>();
  for (const t of P.troncons) if (t.nom) {
    const k = simplifier(t.nom);
    if (!parNom.has(k)) parNom.set(k, []);
    parNom.get(k)!.push(t);
  }

  // --- Numéros
  for (const a of P.adresses) {
    if (!dansZone(a.p)) continue;
    const rues = parNom.get(simplifier(a.voie));
    if (!rues) continue;
    // point le plus proche de l'axe de la rue
    let Q: XY | null = null, dQ = Infinity;
    for (const t of rues)
      for (let i = 0; i < t.axe.length - 1; i++) {
        const r = projSeg(a.p, { a: t.axe[i]!, b: t.axe[i + 1]!, n: { x: 0, y: 0 }, sol: 0 });
        if (r.d < dQ) (dQ = r.d), (Q = r.q);
      }
    if (!Q || dQ > 60) continue;
    const u = norm(sub(Q, a.p));
    // façade côté rue : dernière traversée de la ligne adresse → rue, normale tournée vers la rue
    let best: { k: number; s: PanFacade } | null = null;
    for (const s of proches(a.p, dQ + 5)) {
      if (dot(s.n, u) < 0.3) continue;
      const k = inter(a.p, u, dQ, s);
      if (k !== null && (!best || k > best.k)) best = { k, s };
    }
    if (!best) continue;
    const p = { x: a.p.x + u.x * best.k, y: a.p.y + u.y * best.k };
    const t = textureNumero(a.numero, a.rep, P.aniso);
    poser(t, `num|${a.numero}|${a.rep}`, p, best.s.n, best.s.sol + 2.6);
  }

  // --- Plaques de rue aux carrefours
  const extremites: { p: XY; d: XY; t: Troncon }[] = [];
  for (const t of P.troncons) {
    if (!t.nom || t.axe.length < 2) continue;
    const A = t.axe[0]!, B = t.axe[t.axe.length - 1]!;
    extremites.push({ p: A, d: norm(sub(t.axe[1]!, A)), t }, { p: B, d: norm(sub(t.axe[t.axe.length - 2]!, B)), t });
  }
  const faites = new Set<string>();
  for (const e of extremites) {
    if (!dansZone(e.p)) continue;
    // carrefour : une autre voie (nom différent) se raccorde ici
    const carrefour = extremites.some((f) => f.t !== e.t && f.t.nom !== e.t.nom && Math.hypot(f.p.x - e.p.x, f.p.y - e.p.y) < 1.5);
    if (!carrefour) continue;
    const arrt = e.t.insee?.startsWith('751') ? ((n) => (n === 1 ? '1er Arrt' : `${n}e Arrt`))(+e.t.insee.slice(3)) : '';
    for (const cote of [1, -1]) {
      const m = { x: -e.d.y * cote, y: e.d.x * cote }; // côté de la rue
      let choix: { s: PanFacade; along: number } | null = null;
      for (const s of proches(e.p, 30)) {
        const sd = norm(sub(s.b, s.a));
        if (Math.abs(dot(sd, e.d)) < 0.85 || dot(s.n, m) > -0.5) continue; // parallèle à la rue, tourné vers elle
        const ra = sub(s.a, e.p), rb = sub(s.b, e.p);
        const lat = (dot(ra, m) + dot(rb, m)) / 2;
        if (lat < 1.5 || lat > 25) continue;
        const along = Math.min(dot(ra, e.d), dot(rb, e.d));
        if (Math.max(dot(ra, e.d), dot(rb, e.d)) < 2 || along > 25) continue;
        if (!choix || along < choix.along) choix = { s, along };
      }
      if (!choix) continue;
      const s = choix.s;
      const cle = `${e.t.nom}|${s.a.x.toFixed(1)},${s.a.y.toFixed(1)}`;
      if (faites.has(cle)) continue;
      faites.add(cle);
      // à 1,2 m de l'angle le plus proche du carrefour
      const coin = dot(sub(s.a, e.p), e.d) < dot(sub(s.b, e.p), e.d) ? s.a : s.b, autre = coin === s.a ? s.b : s.a;
      const v = norm(sub(autre, coin));
      const L = Math.hypot(autre.x - coin.x, autre.y - coin.y);
      const tx = texturePlaque(e.t.nom!, arrt, P.aniso);
      const p = { x: coin.x + v.x * Math.min(1.2 + tx.w / 2, L / 2), y: coin.y + v.y * Math.min(1.2 + tx.w / 2, L / 2) };
      poser(tx, `rue|${e.t.nom}|${arrt}`, p, s.n, s.sol + 3.6);
    }
  }

  // --- Maillages instanciés (un par plaque différente)
  for (const { tex, m } of poses.values()) {
    const mat = new THREE.MeshStandardMaterial({ map: tex.tex, roughness: 0.22, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(tex.w, tex.h), mat, m.length);
    m.forEach((x, i) => im.setMatrixAt(i, x));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.receiveShadow = true;
    g.add(im);
  }
  return g;
}
