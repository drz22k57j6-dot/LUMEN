/**
 * Étape 1 — plan 2D du logement (sans 3D, sans adresse) :
 * importer son plan (photo/capture) + échelle, ou partir d'un modèle, ou dessiner ;
 * indiquer vers où regardent les fenêtres du côté bas → orientation de chaque fenêtre.
 * La 3D (placement dans le vrai bâtiment) est l'étape 2.
 */
import {
  aligner, cardinal, erreursPlan, longueurCote, nomPiece, nouvelId, orientationsOuvertures, ouvertureParDefaut,
  PIECES, planModele, planVide, segmentCote, surface, surfaceTotale,
  type Cote, type OuverturePlan, type PiecePlan, type Plan, type TypePiece,
} from '@lumen/interior';

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = '') => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.innerHTML = html;
  return e;
};
const stocker = (cle: string, v: unknown) => { try { localStorage.setItem(cle, JSON.stringify(v)); } catch { /* stockage indisponible */ } };
const relire = <T>(cle: string): T | null => { try { const s = localStorage.getItem(cle); return s ? (JSON.parse(s) as T) : null; } catch { return null; } };

export function initPlan2D(opts: { voir3D?: (plan: Plan) => void } = {}) {
  // --- Éditeur 2D ----------------------------------------------------------
  const ed = el('div', { id: 'editeur', hidden: '' });
  ed.innerHTML = `
    <div class="barre-ed">
      <label class="bouton">📄 Importer mon plan<input id="edImport" type="file" accept="image/*" hidden /></label>
      <button data-outil="echelle" type="button">📏 Échelle</button>
      <label>Fenêtres du bas vers
        <select id="edOrient"><option value="">?</option>${['Nord', 'Nord-Est', 'Est', 'Sud-Est', 'Sud', 'Sud-Ouest', 'Ouest', 'Nord-Ouest'].map((n, i) => `<option value="${i * 45}">${n}</option>`).join('')}</select>
      </label>
    </div>
    <div class="barre-ed">
      <button data-modele="studio" type="button">Studio</button>
      <button data-modele="t2" type="button">T2</button>
      <button data-modele="t3" type="button">T3</button>
      <button id="edVider" type="button">Vider</button>
      <button id="edAnnuler" type="button">↶</button>
      <button id="edFermer" type="button">✕</button>
    </div>
    <div class="barre-ed">
      <button data-outil="piece" type="button" class="actif">▭ Pièce</button>
      <button data-outil="fenetre" type="button">⊟ Fenêtre</button>
      <button data-outil="gomme" type="button">⌫ Effacer</button>
      <select id="edType">${Object.entries(PIECES).map(([k, v]) => `<option value="${k}">${v.nom}</option>`).join('')}</select>
      <select id="edOuv" hidden><option value="fenetre">Fenêtre</option><option value="porte_fenetre">Porte-fenêtre</option></select>
    </div>
    <canvas id="edCanvas"></canvas>
    <div class="pied-ed">
      <div id="edEchelle" class="ligne" hidden>Longueur réelle entre les 2 points : <input type="number" inputmode="decimal" min="0.1" step="0.01" placeholder="m" /> m <button type="button">OK</button></div>
      <div id="edAide"></div>
      <div class="ligne">
        <label>Sous plafond <input id="edHsp" type="number" min="2.2" max="4.5" step="0.05" value="2.7" /> m</label>
        <button id="edEnregistrer" type="button">✓ Enregistrer le plan</button>
        <button id="edVoir3D" type="button">🧊 Voir en 3D</button>
      </div>
    </div>`;
  document.body.append(ed);
  const q = <T extends HTMLElement>(s: string) => ed.querySelector(s) as T;
  const cv = q<HTMLCanvasElement>('#edCanvas');
  const g2 = cv.getContext('2d')!;
  const aide = q<HTMLDivElement>('#edAide');
  const selType = q<HTMLSelectElement>('#edType');
  const selOuv = q<HTMLSelectElement>('#edOuv');

  let plan: Plan = planVide();
  let historique: string[] = [];
  let outil: 'piece' | 'fenetre' | 'gomme' | 'echelle' = 'piece';
  // Plan importé (image) en fond : coin haut-gauche en coordonnées plan + mètres par pixel.
  let fond: { img: HTMLImageElement; src: string; x: number; y: number; mpp: number } | null = null;
  let mesure: [number, number][] = [];
  const selOrient = q<HTMLSelectElement>('#edOrient');
  let vue = { cx: 0, cy: 5, s: 30 };
  let trace: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let message = '';
  let cle = '';

  const memo = () => { historique.push(JSON.stringify(plan)); if (historique.length > 50) historique.shift(); };
  const ajuster = () => {
    const P = plan.pieces;
    const x0 = Math.min(-6, ...P.map((p) => p.x)) - 1, x1 = Math.max(6, ...P.map((p) => p.x + p.l)) + 1;
    const y1 = Math.max(10, ...P.map((p) => p.y + p.p)) + 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    vue = { cx: (x0 + x1) / 2, cy: y1 / 2 - 0.5, s: Math.min(W / (x1 - x0), (H - 30) / (y1 + 1.5)) };
  };
  const versEcran = (x: number, y: number): [number, number] => [cv.clientWidth / 2 + (x - vue.cx) * vue.s, cv.clientHeight / 2 - (y - vue.cy) * vue.s];
  const versPlan = (sx: number, sy: number): [number, number] => [vue.cx + (sx - cv.clientWidth / 2) / vue.s, vue.cy - (sy - cv.clientHeight / 2) / vue.s];

  function dessiner() {
    const dpr = Math.min(devicePixelRatio, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.clearRect(0, 0, W, H);
    if (fond) {
      const [fx, fy] = versEcran(fond.x, fond.y);
      g2.globalAlpha = 0.55;
      g2.drawImage(fond.img, fx, fy, fond.img.width * fond.mpp * vue.s, fond.img.height * fond.mpp * vue.s);
      g2.globalAlpha = 1;
    }
    // Grille 1 m
    const [gx0, gy1] = versPlan(0, 0), [gx1, gy0] = versPlan(W, H);
    g2.strokeStyle = '#e6e6e6'; g2.lineWidth = 1; g2.beginPath();
    for (let x = Math.floor(gx0); x <= gx1; x++) { const [sx] = versEcran(x, 0); g2.moveTo(sx, 0); g2.lineTo(sx, H); }
    for (let y = Math.floor(gy0); y <= gy1; y++) { const [, sy] = versEcran(0, y); g2.moveTo(0, sy); g2.lineTo(W, sy); }
    g2.stroke();
    // Rue + façade
    const [, sy0] = versEcran(0, 0);
    g2.fillStyle = '#f3efe6'; g2.fillRect(0, sy0, W, H - sy0);
    g2.strokeStyle = '#e8a400'; g2.lineWidth = 3; g2.beginPath(); g2.moveTo(0, sy0); g2.lineTo(W, sy0); g2.stroke();
    g2.fillStyle = '#8a6a00'; g2.font = '12px system-ui';
    const azBas = plan.azimutBas;
    g2.fillText(`Côté bas${azBas !== undefined ? ` : fenêtres vers le ${cardinal(azBas)}` : ' : choisis son orientation'}`, 8, sy0 + 16);
    if (azBas !== undefined) {
      // Boussole : flèche du nord
      const a = ((180 - azBas) * Math.PI) / 180, bx = W - 30, by = 34;
      g2.save(); g2.translate(bx, by); g2.rotate(a);
      g2.fillStyle = '#c0392b'; g2.beginPath(); g2.moveTo(0, -18); g2.lineTo(6, 4); g2.lineTo(-6, 4); g2.fill();
      g2.fillStyle = '#333'; g2.font = '600 12px system-ui'; g2.textAlign = 'center'; g2.fillText('N', 0, -21);
      g2.restore(); g2.textAlign = 'left';
    }
    const [ox] = versEcran(0, 0);
    g2.beginPath(); g2.arc(ox, sy0, 5, 0, Math.PI * 2); g2.fill();
    // Pièces
    for (const p of plan.pieces) {
      const [ax, ay] = versEcran(p.x, p.y + p.p);
      g2.fillStyle = '#' + PIECES[p.type].couleur.toString(16).padStart(6, '0');
      g2.fillRect(ax, ay, p.l * vue.s, p.p * vue.s);
      g2.strokeStyle = '#333'; g2.lineWidth = 3; g2.strokeRect(ax, ay, p.l * vue.s, p.p * vue.s);
      g2.fillStyle = '#222'; g2.font = '600 13px system-ui'; g2.textAlign = 'center';
      const [mx, my] = versEcran(p.x + p.l / 2, p.y + p.p / 2);
      g2.fillText(nomPiece(p), mx, my - 2);
      g2.font = '12px system-ui'; g2.fillText(`${surface(p).valeur.toFixed(1)} m²`, mx, my + 13);
      g2.textAlign = 'left';
    }
    // Ouvertures
    for (const o of plan.ouvertures) {
      const p = plan.pieces.find((x) => x.id === o.piece);
      if (!p) continue;
      const [x1, y1, x2, y2] = segmentCote(p, o.cote);
      const L = longueurCote(p, o.cote);
      const a = versEcran(x1 + ((x2 - x1) * (o.position - o.largeur / 2)) / L, y1 + ((y2 - y1) * (o.position - o.largeur / 2)) / L);
      const b = versEcran(x1 + ((x2 - x1) * (o.position + o.largeur / 2)) / L, y1 + ((y2 - y1) * (o.position + o.largeur / 2)) / L);
      g2.strokeStyle = o.type === 'porte_fenetre' ? '#1e6fd9' : '#4fa3ff'; g2.lineWidth = 7;
      g2.beginPath(); g2.moveTo(...a); g2.lineTo(...b); g2.stroke();
    }
    for (const [mx, my] of mesure) {
      const [sx, sy] = versEcran(mx, my);
      g2.fillStyle = '#c0392b'; g2.beginPath(); g2.arc(sx, sy, 6, 0, Math.PI * 2); g2.fill();
    }
    if (trace) {
      const [ax, ay] = versEcran(Math.min(trace.x0, trace.x1), Math.max(trace.y0, trace.y1));
      const l = Math.abs(trace.x1 - trace.x0), pp = Math.abs(trace.y1 - trace.y0);
      g2.setLineDash([6, 4]); g2.strokeStyle = '#111'; g2.lineWidth = 2;
      g2.strokeRect(ax, ay, l * vue.s, pp * vue.s); g2.setLineDash([]);
      g2.fillStyle = '#111'; g2.font = '600 13px system-ui';
      g2.fillText(`${l.toFixed(2)} × ${pp.toFixed(2)} m`, ax + 4, ay - 6);
    }
    const err = erreursPlan(plan);
    const astuces = {
      piece: 'Glisse pour dessiner une pièce (grille 25 cm). Touche une pièce pour lui donner le type choisi.',
      fenetre: 'Touche un mur extérieur pour y poser une fenêtre (1,20 m).',
      gomme: 'Touche une fenêtre ou une pièce pour l’effacer.',
      echelle: fond ? 'Touche les deux extrémités d’une cote connue du plan importé.' : 'Importe d’abord ton plan (photo ou capture).',
    };
    const orient = orientationsOuvertures(plan);
    aide.innerHTML =
      (message ? `<b>${message}</b><br>` : '') +
      `${astuces[outil]}<br><span class="prov">${plan.pieces.length} pièces · ${surfaceTotale(plan).toFixed(1)} m² (axes des murs) · ${plan.ouvertures.length} ouvertures</span>` +
      (orient.length ? `<div class="prov">${orient.map((o) => `${nomPiece(o.piece)} : ${o.ouverture.type === 'porte_fenetre' ? 'porte-fenêtre' : 'fenêtre'} ${o.cardinal} (${o.azimut}°)`).join(' · ')}</div>` : '') +
      (plan.ouvertures.length && azBas === undefined ? `<div class="err">Indique vers où regardent les fenêtres du bas.</div>` : '') +
      (err.length ? `<div class="err">${err.join('<br>')}</div>` : '');
    q<HTMLButtonElement>('#edEnregistrer').disabled = err.length > 0 || plan.pieces.length === 0;
    q<HTMLButtonElement>('#edVoir3D').disabled = err.length > 0 || plan.pieces.length === 0;
  }

  const pointeur = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); return versPlan(e.clientX - r.left, e.clientY - r.top); };
  const pieceSous = (x: number, y: number) => plan.pieces.find((p) => x >= p.x && x <= p.x + p.l && y >= p.y && y <= p.y + p.p);

  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    message = '';
    const [x, y] = pointeur(e);
    if (outil === 'piece') trace = { x0: aligner(x), y0: Math.max(0, aligner(y)), x1: aligner(x), y1: Math.max(0, aligner(y)) };
    dessiner();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!trace) return;
    const [x, y] = pointeur(e);
    trace.x1 = aligner(x); trace.y1 = Math.max(0, aligner(y));
    dessiner();
  });
  cv.addEventListener('pointerup', (e) => {
    const [x, y] = pointeur(e);
    if (outil === 'piece' && trace) {
      const l = Math.abs(trace.x1 - trace.x0), p = Math.abs(trace.y1 - trace.y0);
      if (l < 0.5 && p < 0.5) {
        const cible = pieceSous(x, y);
        if (cible) { memo(); cible.type = selType.value as TypePiece; cible.source = 'deduit'; }
      } else if (l >= 0.75 && p >= 0.75) {
        memo();
        plan.pieces.push({ id: nouvelId('p'), type: selType.value as TypePiece, x: Math.min(trace.x0, trace.x1), y: Math.min(trace.y0, trace.y1), l, p, source: 'deduit' });
      } else message = 'Pièce trop petite (75 cm minimum).';
      trace = null;
    } else if (outil === 'fenetre') poserFenetre(x, y);
    else if (outil === 'gomme') effacer(x, y);
    else if (outil === 'echelle' && fond) calibrer(x, y);
    dessiner();
  });

  function calibrer(x: number, y: number) {
    mesure.push([x, y]);
    if (mesure.length < 2 || !fond) return;
    const [[x1, y1], [x2, y2]] = mesure as [[number, number], [number, number]];
    const d = Math.hypot(x2 - x1, y2 - y1);
    // Saisie intégrée (les fenêtres prompt() sont bloquées sur certains hébergements).
    const boite = q<HTMLDivElement>('#edEchelle');
    const champ = boite.querySelector('input')!;
    boite.hidden = false;
    champ.value = '';
    champ.focus();
    const valider = () => {
      boite.hidden = true;
      mesure = [];
      const reel = parseFloat(champ.value.replace(',', '.'));
      if (!fond || !(reel > 0) || d < 1e-6) { message = 'Échelle annulée.'; return dessiner(); }
      const k = reel / d;
      fond.mpp *= k;
      fond.x = x1 + (fond.x - x1) * k;
      fond.y = fond.img.height * fond.mpp; // bas de l'image posé sur la ligne de façade
      message = `Échelle réglée : ${reel} m. Trace maintenant les pièces par-dessus.`;
      stockerFond();
      ajusterFond();
      dessiner();
    };
    boite.querySelector<HTMLButtonElement>('button')!.onclick = valider;
    champ.onkeydown = (e) => { if (e.key === 'Enter') valider(); };
  }
  const stockerFond = () => stocker('lumen:plan:fond', fond && { src: fond.src, x: fond.x, y: fond.y, mpp: fond.mpp });
  const ajusterFond = () => {
    ajuster();
    if (!fond) return;
    const l = fond.img.width * fond.mpp, hh = fond.img.height * fond.mpp;
    const W = cv.clientWidth, H = cv.clientHeight;
    vue = { cx: fond.x + l / 2, cy: hh / 2, s: Math.min(W / (l + 2), (H - 30) / (hh + 2)) };
  };
  function chargerImage(src: string, place?: { x: number; y: number; mpp: number }) {
    const img = new Image();
    img.onload = () => {
      const mpp = place?.mpp ?? 12 / img.width; // par défaut : 12 m de large, à calibrer
      fond = { img, src, mpp, x: place?.x ?? -6, y: place?.y ?? img.height * mpp };
      if (!place) { message = 'Plan importé. Règle l’échelle avec 📏 sur une cote connue.'; stockerFond(); }
      ajusterFond();
      dessiner();
    };
    img.src = src;
  }
  q<HTMLInputElement>('#edImport').onchange = (e) => {
    const fichier = (e.target as HTMLInputElement).files?.[0];
    if (!fichier) return;
    // Réduit l'image (max 1600 px) pour la garder légère dans le navigateur.
    const lecteur = new FileReader();
    lecteur.onload = () => {
      const img = new Image();
      img.onload = () => {
        const r = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        chargerImage(c.toDataURL('image/jpeg', 0.8));
      };
      img.src = lecteur.result as string;
    };
    lecteur.readAsDataURL(fichier);
  };
  selOrient.onchange = () => {
    if (selOrient.value === '') delete plan.azimutBas; else plan.azimutBas = +selOrient.value;
    stocker(cle, plan);
    dessiner();
  };

  function coteProche(x: number, y: number): { p: PiecePlan; cote: Cote; t: number; d: number } | null {
    let best: { p: PiecePlan; cote: Cote; t: number; d: number } | null = null;
    for (const p of plan.pieces)
      for (const cote of ['bas', 'haut', 'gauche', 'droite'] as Cote[]) {
        const [x1, y1, x2, y2] = segmentCote(p, cote);
        const L = longueurCote(p, cote);
        const t = clamp(((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / (L * L), 0, 1);
        const d = Math.hypot(x - (x1 + (x2 - x1) * t), y - (y1 + (y2 - y1) * t));
        if (!best || d < best.d) best = { p, cote, t: t * L, d };
      }
    return best && best.d < 0.6 ? best : null;
  }

  function poserFenetre(x: number, y: number) {
    const c = coteProche(x, y);
    if (!c) return void (message = 'Touche plus près d’un mur.');
    const type = selOuv.value as OuverturePlan['type'];
    const dims = ouvertureParDefaut(type);
    const L = longueurCote(c.p, c.cote);
    const largeur = Math.min(dims.largeur, aligner(L - 0.3));
    if (largeur < 0.5) return void (message = 'Mur trop court pour une fenêtre.');
    const position = clamp(aligner(c.t), largeur / 2 + 0.15, L - largeur / 2 - 0.15);
    const avant = erreursPlan(plan).length;
    memo();
    plan.ouvertures.push({ id: nouvelId('o'), piece: c.p.id, cote: c.cote, position, ...dims, largeur, type, source: 'deduit' });
    if (erreursPlan(plan).length > avant) {
      plan = JSON.parse(historique.pop()!) as Plan;
      message = 'Impossible ici : ce mur est une cloison intérieure (ou la fenêtre chevauche une autre).';
    }
  }

  function effacer(x: number, y: number) {
    let cible: OuverturePlan | null = null, dmin = 0.7;
    for (const o of plan.ouvertures) {
      const p = plan.pieces.find((z) => z.id === o.piece);
      if (!p) continue;
      const [x1, y1, x2, y2] = segmentCote(p, o.cote);
      const t = o.position / longueurCote(p, o.cote);
      const d = Math.hypot(x - (x1 + (x2 - x1) * t), y - (y1 + (y2 - y1) * t));
      if (d < dmin) { dmin = d; cible = o; }
    }
    memo();
    if (cible) return void (plan.ouvertures = plan.ouvertures.filter((o) => o !== cible));
    const p = pieceSous(x, y);
    if (!p) return void historique.pop();
    plan.pieces = plan.pieces.filter((z) => z !== p);
    plan.ouvertures = plan.ouvertures.filter((o) => o.piece !== p.id);
  }

  ed.querySelectorAll<HTMLButtonElement>('[data-outil]').forEach((b) => (b.onclick = () => {
    outil = b.dataset.outil as typeof outil;
    ed.querySelectorAll('[data-outil]').forEach((x) => x.classList.toggle('actif', x === b));
    selType.hidden = outil !== 'piece';
    selOuv.hidden = outil !== 'fenetre';
    mesure = [];
    message = '';
    dessiner();
  }));
  ed.querySelectorAll<HTMLButtonElement>('[data-modele]').forEach((b) => (b.onclick = () => {
    memo();
    const az = plan.azimutBas;
    plan = planModele(b.dataset.modele as 'studio' | 't2' | 't3', plan.hauteurSousPlafond);
    if (az !== undefined) plan.azimutBas = az;
    message = 'Modèle chargé : ajuste les pièces et les fenêtres à ton logement.';
    ajuster(); dessiner();
  }));
  q<HTMLButtonElement>('#edVider').onclick = () => {
    memo();
    const az = plan.azimutBas;
    plan = planVide(plan.hauteurSousPlafond);
    if (az !== undefined) plan.azimutBas = az;
    fond = null; stockerFond();
    dessiner();
  };
  q<HTMLButtonElement>('#edAnnuler').onclick = () => { const s = historique.pop(); if (s) plan = JSON.parse(s) as Plan; dessiner(); };
  q<HTMLButtonElement>('#edFermer').onclick = () => { ed.hidden = true; stocker(cle, plan); };
  q<HTMLButtonElement>('#edVoir3D').onclick = () => {
    if (!opts.voir3D || erreursPlan(plan).length || !plan.pieces.length) return;
    stocker(cle, plan);
    ed.hidden = true;
    opts.voir3D(plan);
  };
  q<HTMLButtonElement>('#edEnregistrer').onclick = () => {
    stocker(cle, plan);
    message = 'Plan enregistré. Étape 2 (bientôt) : le placer en 3D dans le vrai bâtiment.';
    dessiner();
  };
  q<HTMLInputElement>('#edHsp').oninput = (e) => { plan.hauteurSousPlafond = +(e.target as HTMLInputElement).value || 2.7; dessiner(); };
  addEventListener('resize', () => { if (!ed.hidden) dessiner(); });

  function ouvrir() {
    cle = 'lumen:plan:courant';
    const max = 4.5;
    plan = relire<Plan>(cle) ?? planVide(Math.min(2.7, max));
    selOrient.value = plan.azimutBas !== undefined ? String(Math.round(plan.azimutBas / 45) * 45 % 360) : '';
    if (!fond) {
      const f = relire<{ src: string; x: number; y: number; mpp: number }>('lumen:plan:fond');
      if (f) chargerImage(f.src, f);
    }
    q<HTMLInputElement>('#edHsp').max = String(max);
    q<HTMLInputElement>('#edHsp').value = String(plan.hauteurSousPlafond);
    historique = [];
    ed.hidden = false;
    requestAnimationFrame(() => { ajusterFond(); dessiner(); });
  }

  return { ouvrir };
}
