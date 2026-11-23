/**
 * Lecture automatique d'un plan d'appartement à partir d'une image (photo, capture, PDF converti).
 * 1. Murs : pixels sombres épais (seuil d'Otsu + ouverture morphologique : texte et traits fins éliminés).
 * 2. Pièces : zones libres fermées (portes refermées par une fermeture morphologique), hors extérieur.
 * 3. Texte (OCR Tesseract, français) : noms de pièces, surfaces « 12,5 m² », cotes « 3,45 ».
 * 4. Échelle : surfaces lues ÷ surfaces en pixels (médiane), sinon cotes lues ÷ longueur du mur voisin.
 * 5. Fenêtres : interruptions des murs épais sur les côtés extérieurs.
 * Tout reste modifiable ensuite dans l'éditeur.
 */
import type { TypePiece } from '@lumen/interior';

export interface PieceLue { type: TypePiece; nom?: string; x0: number; y0: number; x1: number; y1: number; surface?: number }
export interface FenetreLue { piece: number; cote: 'bas' | 'haut' | 'gauche' | 'droite'; debutPx: number; finPx: number }
export interface PlanLu { largeur: number; hauteur: number; mpp: number | null; methode: string; pieces: PieceLue[]; fenetres: FenetreLue[] }

// --- Morphologie binaire (filtres min/max séparables) -----------------------
function filtre(src: Uint8Array, w: number, h: number, r: number, max: boolean): Uint8Array {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const pass = (a: Uint8Array, b: Uint8Array, horiz: boolean) => {
    const n = horiz ? w : h, m = horiz ? h : w;
    for (let j = 0; j < m; j++) {
      let compte = 0; // nombre de 1 dans la fenêtre
      const at = (i: number) => (horiz ? a[j * w + i]! : a[i * w + j]!);
      for (let i = -r; i < n + r; i++) {
        const entre = i + r, sort = i - r - 1;
        if (entre < n && entre >= 0) compte += at(entre);
        if (sort >= 0 && sort < n) compte -= at(sort);
        if (i >= 0 && i < n) {
          const larg = Math.min(n - 1, i + r) - Math.max(0, i - r) + 1;
          const v = max ? (compte > 0 ? 1 : 0) : compte === larg ? 1 : 0;
          if (horiz) b[j * w + i] = v;
          else b[i * w + j] = v;
        }
      }
    }
  };
  pass(src, tmp, true);
  pass(tmp, out, false);
  return out;
}
const eroder = (m: Uint8Array, w: number, h: number, r: number) => filtre(m, w, h, r, false);
const dilater = (m: Uint8Array, w: number, h: number, r: number) => filtre(m, w, h, r, true);

function otsu(g: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of g) hist[v]!++;
  let somme = 0;
  for (let i = 0; i < 256; i++) somme += i * hist[i]!;
  let sB = 0, wB = 0, best = 0, seuil = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (!wB) continue;
    const wF = g.length - wB;
    if (!wF) break;
    sB += t * hist[t]!;
    const mB = sB / wB, mF = (somme - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) (best = v), (seuil = t);
  }
  return seuil;
}

const TYPES: [RegExp, TypePiece][] = [
  [/s[ée]jour|salon|living|pi[èe]ce\s*de\s*vie|s[ée]j/i, 'sejour'],
  [/cuis|kitchen/i, 'cuisine'],
  [/ch(ambre|\.)?\s*\d?|chbre|suite|bedroom/i, 'chambre'],
  [/s\.?\s?d\.?\s?b|s\.?\s?d\.?\s?e|bain|douche|salle\s*d.eau/i, 'salle_de_bain'],
  [/\bw\.?c\b|toilettes?/i, 'wc'],
  [/entr[ée]e|hall/i, 'entree'],
  [/d[ée]g|couloir|circulation|palier/i, 'couloir'],
  [/bureau/i, 'bureau'],
  [/cellier|dressing|placard|rangement|buanderie/i, 'cellier'],
];

export async function lirePlan(source: HTMLCanvasElement, progression?: (t: string) => void): Promise<PlanLu> {
  // --- Image de travail (max 1200 px)
  const k = Math.min(1, 1200 / Math.max(source.width, source.height));
  const w = Math.round(source.width * k), h = Math.round(source.height * k);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const gris = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gris[i] = (px[i * 4]! * 0.299 + px[i * 4 + 1]! * 0.587 + px[i * 4 + 2]! * 0.114) | 0;
  const seuil = Math.min(160, otsu(gris));
  const sombre: Uint8Array = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) sombre[i] = gris[i]! < seuil ? 1 : 0;

  // --- Murs épais : on cherche l'ouverture qui supprime le texte mais garde la structure
  progression?.('Détection des murs…');
  const total = sombre.reduce((s, v) => s + v, 0) || 1;
  let rMur = 1, murs: Uint8Array = sombre;
  for (let r = 1; r <= 6; r++) {
    const o = dilater(eroder(sombre, w, h, r), w, h, r);
    const part = o.reduce((s, v) => s + v, 0) / total;
    murs = o;
    rMur = r;
    if (part < 0.75) break; // le texte et les traits fins ont disparu
  }
  // Épaisseur typique des murs (médiane des longueurs de plages horizontales)
  const plages: number[] = [];
  for (let y = 0; y < h; y += 4) {
    let n = 0;
    for (let x = 0; x < w; x++) {
      if (murs[y * w + x]) n++;
      else if (n) (plages.push(n), (n = 0));
    }
  }
  plages.sort((a, b) => a - b);
  const ep = Math.max(2, plages[Math.floor(plages.length / 2)] ?? rMur * 2);

  // --- Pièces : fermeture des portes, puis composantes libres non reliées au bord
  const rPorte = Math.max(4, Math.round(Math.max(w, h) / 34));
  // Enveloppe : tous les traits (vitrages fins compris) ; le texte, isolé à l’intérieur des pièces, ne les coupe pas.
  const ferme = eroder(dilater(sombre, w, h, rPorte), w, h, rPorte);
  const etiquette = new Int32Array(w * h).fill(-1);
  const comps: { x0: number; y0: number; x1: number; y1: number; n: number; bord: boolean }[] = [];
  const pile: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (ferme[s] || etiquette[s] !== -1) continue;
    const id = comps.length;
    const c = { x0: w, y0: h, x1: 0, y1: 0, n: 0, bord: false };
    pile.push(s);
    etiquette[s] = id;
    while (pile.length) {
      const i = pile.pop()!, x = i % w, y = (i / w) | 0;
      c.n++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) c.bord = true;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= w * h || (j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
        if (!ferme[j] && etiquette[j] === -1) (etiquette[j] = id), pile.push(j);
      }
    }
    comps.push(c);
  }
  const minAire = w * h * 0.004;
  const rects = comps
    .filter((c) => !c.bord && c.n > minAire && c.n / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)) > 0.45)
    .map((c) => ({ x0: c.x0, y0: c.y0, x1: c.x1 + 1, y1: c.y1 + 1, nPx: c.n }));

  // --- Texte
  progression?.('Lecture des cotes et des noms de pièces…');
  type Mot = { t: string; x: number; y: number; w: number; h: number };
  let mots: Mot[] = [];
  try {
    const { createWorker } = await import('tesseract.js');
    const base = import.meta.env.BASE_URL + 'ocr/';
    const ocr = await createWorker('fra', 1, { workerPath: base + 'worker.min.js', corePath: base + 'core/', langPath: base + 'lang', workerBlobURL: false });
    const r = await ocr.recognize(cv);
    const donnees = r.data as unknown as { words?: { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }[] };
    mots = (donnees.words ?? []).map((l) => ({ t: l.text.trim(), x: (l.bbox.x0 + l.bbox.x1) / 2, y: (l.bbox.y0 + l.bbox.y1) / 2, w: l.bbox.x1 - l.bbox.x0, h: l.bbox.y1 - l.bbox.y0 }));
    await ocr.terminate();
  } catch {
    /* OCR indisponible (hors ligne) : on garde la géométrie */
  }

  const pieces: PieceLue[] = rects.map((r) => {
    const dedans = mots.filter((m) => m.x > r.x0 && m.x < r.x1 && m.y > r.y0 && m.y < r.y1).sort((a, b) => (Math.abs(a.y - b.y) < a.h * 0.6 ? a.x - b.x : a.y - b.y));
    const texte = dedans.map((m) => m.t).join(' ');
    const type = TYPES.find(([re]) => re.test(texte))?.[1] ?? 'chambre';
    const surf = texte.replace(/\s/g, '').match(/(\d{1,3}(?:[.,]\d{1,2})?)m[²2?]/i);
    const nom = dedans.find((m) => /[a-zé]{2,}/i.test(m.t) && !/^m[²2?]$/i.test(m.t))?.t.trim();
    const p: PieceLue = { type, x0: r.x0 - ep / 2, y0: r.y0 - ep / 2, x1: r.x1 + ep / 2, y1: r.y1 + ep / 2 };
    if (nom) p.nom = nom.slice(0, 24);
    if (surf) p.surface = parseFloat(surf[1]!.replace(',', '.'));
    return p;
  });

  // --- Échelle
  let mpp: number | null = null, methode = 'à régler (aucune cote lisible)';
  const echSurf = pieces
    .map((p, i) => { const r = rects[i]!; return p.surface && p.surface > 1 && p.surface < 120 ? Math.sqrt(p.surface / ((r.x1 - r.x0) * (r.y1 - r.y0))) : NaN; })
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (echSurf.length) {
    mpp = echSurf[echSurf.length >> 1]!;
    methode = `surfaces lues (${echSurf.length} pièce${echSurf.length > 1 ? 's' : ''})`;
  } else {
    const ech: number[] = [];
    for (const m of mots) {
      const v = m.t.replace(/\s/g, '').match(/^(\d{1,2}[.,]\d{1,2})m?$/);
      if (!v) continue;
      const val = parseFloat(v[1]!.replace(',', '.'));
      if (val < 0.6 || val > 20) continue;
      const horiz = m.w >= m.h;
      // côté de pièce parallèle le plus proche de l'étiquette
      let best: { d: number; L: number } | null = null;
      for (const p of pieces) {
        const L = horiz ? p.x1 - p.x0 : p.y1 - p.y0;
        const cx = horiz ? (p.x0 + p.x1) / 2 : m.x, cy = horiz ? m.y : (p.y0 + p.y1) / 2;
        const bordProche = horiz ? Math.min(Math.abs(m.y - p.y0), Math.abs(m.y - p.y1)) : Math.min(Math.abs(m.x - p.x0), Math.abs(m.x - p.x1));
        const d = Math.hypot(cx - m.x, cy - m.y) + bordProche;
        if ((!best || d < best.d) && d < Math.max(w, h) * 0.12) best = { d, L };
      }
      if (best && best.L > 10) ech.push(val / best.L);
    }
    ech.sort((a, b) => a - b);
    if (ech.length) {
      mpp = ech[ech.length >> 1]!;
      methode = `cotes lues (${ech.length})`;
    }
  }

  // --- Fenêtres : interruptions des murs épais sur les côtés extérieurs
  const env = pieces.reduce((e, p) => ({ x0: Math.min(e.x0, p.x0), y0: Math.min(e.y0, p.y0), x1: Math.max(e.x1, p.x1), y1: Math.max(e.y1, p.y1) }), { x0: w, y0: h, x1: 0, y1: 0 });
  const tol = ep * 2;
  const fenetres: FenetreLue[] = [];
  pieces.forEach((p, i) => {
    const cotes: [FenetreLue['cote'], boolean][] = [
      ['haut', p.y0 - env.y0 < tol], ['bas', env.y1 - p.y1 < tol], ['gauche', p.x0 - env.x0 < tol], ['droite', env.x1 - p.x1 < tol],
    ];
    for (const [cote, ext] of cotes) {
      if (!ext) continue;
      const horiz = cote === 'haut' || cote === 'bas';
      const fixe = cote === 'haut' ? p.y0 : cote === 'bas' ? p.y1 : cote === 'gauche' ? p.x0 : p.x1; // axe du mur
      const a = horiz ? p.x0 + ep : p.y0 + ep, b = horiz ? p.x1 - ep : p.y1 - ep;
      let debut = -1;
      for (let s = a; s <= b; s++) {
        const x = Math.round(horiz ? s : fixe), y = Math.round(horiz ? fixe : s);
        const plein = x >= 0 && y >= 0 && x < w && y < h && murs[y * w + x] === 1;
        if (!plein && debut < 0) debut = s;
        if ((plein || s === b) && debut >= 0) {
          if (s - debut > ep * 2.5) fenetres.push({ piece: i, cote, debutPx: debut - (horiz ? p.x0 : p.y0), finPx: s - (horiz ? p.x0 : p.y0) });
          debut = -1;
        }
      }
    }
  });

  // Retour aux pixels de l'image d'origine
  const inv = 1 / k;
  for (const p of pieces) (p.x0 *= inv), (p.y0 *= inv), (p.x1 *= inv), (p.y1 *= inv);
  for (const f of fenetres) (f.debutPx *= inv), (f.finPx *= inv);
  return { largeur: source.width, hauteur: source.height, mpp: mpp === null ? null : mpp * k, methode, pieces, fenetres };
}
