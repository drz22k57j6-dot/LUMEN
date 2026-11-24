/**
 * Moteur de façades Lumen — partie « cerveau » (TypeScript pur, déterministe, sans DOM ni Three.js).
 *
 *   données du bâtiment (BD TOPO + LiDAR)  →  classer()  →  Typologie (+ confiance, raisons)
 *                                          →  composer() →  FacadeSpec (niveaux, travées, ouvertures, balcons…)
 *
 * Règles d'or (voir docs/prompts/moteur-facades.md) :
 *  - la typologie vient de la DONNÉE (année, étages, matériaux, toit LiDAR, usage), jamais d'un tirage au hasard ;
 *    le hasard (déterministe, graine = id) ne sert qu'aux variations À L'INTÉRIEUR d'une typologie ;
 *  - nombre d'étages = BD TOPO si cohérent avec la gouttière LiDAR, sinon déduit de la hauteur ;
 *  - travées alignées verticalement sur tous les étages, symétriques, centrées ;
 *  - aucune ouverture sous le pied de façade (v ≥ 0) ni au-dessus de la corniche.
 *
 * Repère d'une façade : u ∈ [0, largeur] le long du mur (de a vers b), v = hauteur au-dessus du pied (m),
 * d = profondeur (positive vers la rue). Le pied (v = 0) est le point HAUT du trottoir ; le socle descend dessous.
 */

export type Typologie =
  | 'haussmannien'
  | 'post-haussmannien'
  | 'faubourien'
  | 'brique'
  | 'moderne'
  | 'tour'
  | 'contemporain'
  | 'bureaux'
  | 'equipement'
  | 'annexe';

export type Materiau = 'pierre' | 'enduit' | 'brique' | 'beton' | 'meuliere' | 'verre';
export type Provenance = 'mesure' | 'deduit' | 'genere';

export interface EntreeFacade {
  id: string;
  /** Largeur du mur sur rue (m). */
  largeur: number;
  /** Hauteur de gouttière/corniche mesurée au LiDAR, depuis le pied (m). */
  hGout: number;
  /** Hauteur du haut du toit (LiDAR) depuis le pied (m), si connue : mansarde ⇔ hHaut − hGout ≥ 2. */
  hHaut?: number;
  socle?: number;
  annee?: number;
  /** BD TOPO nombre_d_etages (rez-de-chaussée compris, combles compris). */
  nbEtages?: number;
  /** Codes matériaux BD TOPO (« 10 » = pierre + indéterminé…). */
  murs?: string;
  usage?: string;
  nature?: string;
  /** Hauteur totale du bâtiment BD TOPO (m). */
  hauteurBat?: number;
  /** Rez-de-chaussée commercial connu (données commerces) ; sinon déduit. */
  commerce?: boolean;
}

export interface Classement {
  typologie: Typologie;
  confiance: number;
  source: Provenance;
  raisons: string[];
}

export type TypeOuverture = 'fenetre' | 'porte-fenetre' | 'porte-cochere' | 'porte' | 'vitrine' | 'baie' | 'mur-rideau';

export interface Ouverture {
  niveau: number;
  travee: number;
  type: TypeOuverture;
  /** Coin bas-gauche (u, v), largeur l, hauteur h (m). */
  u: number;
  v: number;
  l: number;
  h: number;
  /** Profondeur du tableau (m). */
  prof: number;
  /** Garde-corps individuel (balconnet) devant l'ouverture. */
  gardeCorps: boolean;
  /** 0 aucun, 1 chambranle simple, 2 chambranle + corniche de fenêtre (étage noble). */
  encadrement: 0 | 1 | 2;
  volets: boolean;
  /** Vantaux et imposte : 2 vantaux + imposte pour les fenêtres parisiennes. */
  vantaux: number;
  imposte: boolean;
}

export interface Niveau {
  i: number;
  role: 'rdc' | 'entresol' | 'noble' | 'courant' | 'dernier';
  v: number;
  h: number;
  balconFilant: boolean;
}

export interface Bande {
  v: number;
  h: number;
  saillie: number;
}

export interface Balcon {
  v: number;
  u0: number;
  u1: number;
  saillie: number;
  /** Positions u des consoles sous la dalle. */
  consoles: number[];
}

export interface FacadeSpec {
  id: string;
  classement: Classement;
  largeur: number;
  hauteur: number;
  socle: number;
  materiau: Materiau;
  /** Rez-de-chaussée à refends (bossages horizontaux) */
  refends: boolean;
  /** Teinte du mur, des menuiseries, des volets/portes (RGB 0–1). */
  teinte: [number, number, number];
  teinteMenuiserie: [number, number, number];
  teinteAccent: [number, number, number];
  niveaux: Niveau[];
  /** Origine du nombre d'étages. */
  sourceEtages: Provenance;
  nbTravees: number;
  ouvertures: Ouverture[];
  balcons: Balcon[];
  bandeaux: Bande[];
  corniche: Bande | null;
  /** Enseignes au-dessus des vitrines. */
  enseignes: { u: number; v: number; l: number; h: number }[];
}

// ---------------------------------------------------------------------------
// Aléa déterministe (variations internes à une typologie)
// ---------------------------------------------------------------------------
export function hachage(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function alea(s: string) {
  let x = (hachage(s) % 2147483646) + 1;
  return () => (x = (x * 16807) % 2147483647) / 2147483647;
}
const choisir = <T>(R: () => number, l: readonly T[]): T => l[Math.floor(R() * l.length) % l.length]!;
const hex = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
const aMateriau = (murs: string | undefined, code: string) => !!murs && murs.includes(code);

export function classer(e: EntreeFacade): Classement {
  const r: string[] = [];
  const an = e.annee;
  const mansarde = e.hHaut != null ? e.hHaut - e.hGout >= 2 : undefined;
  const plat = e.hHaut != null ? e.hHaut - e.hGout < 1.2 : undefined;
  const h = e.hGout;
  const usage = (e.usage ?? '').toLowerCase();
  const nature = (e.nature ?? '').toLowerCase();
  const pierre = aMateriau(e.murs, '1'), brique = aMateriau(e.murs, '4'), beton = aMateriau(e.murs, '3'), meuliere = aMateriau(e.murs, '2');
  const res = (typologie: Typologie, confiance: number, source: Provenance): Classement => ({ typologie, confiance, source, raisons: r });

  if (/monument|église|eglise|chapelle|château|chateau|tour, donjon|fort/.test(nature)) return r.push(`nature IGN « ${e.nature} »`), res('equipement', 0.8, 'deduit');
  if (h < 4.5 || /annexe|agricole|industriel/.test(usage) || /industriel|serre|silo/.test(nature)) return r.push(`bâtiment bas / annexe (h ${h.toFixed(1)} m, usage ${e.usage ?? '?'})`), res('annexe', 0.6, 'deduit');
  if (h > 32) {
    r.push(`grande hauteur (${h.toFixed(0)} m)`);
    if (an != null && an >= 1990 && /commercial|service/.test(usage)) return r.push(`${an}, ${e.usage}`), res('bureaux', 0.7, 'deduit');
    return res('tour', 0.75, 'deduit');
  }
  // Année connue : critère principal. Les années rondes (1800, 1850, 1900) sont des approximations.
  if (an != null) {
    r.push(`année ${an}${an % 50 === 0 ? ' (arrondie)' : ''}`);
    if (an >= 1990) {
      if (/commercial|service/.test(usage) && h > 14) return r.push(`usage ${e.usage}`), res('bureaux', 0.7, 'deduit');
      return res('contemporain', 0.75, 'deduit');
    }
    if (an >= 1946) return brique ? (r.push('murs brique'), res('brique', 0.65, 'deduit')) : res('moderne', 0.75, 'deduit');
    if (an >= 1915) {
      if (brique) return r.push('murs brique'), res('brique', 0.8, 'deduit');
      if (pierre || mansarde) return r.push(pierre ? 'murs pierre' : 'toit mansardé'), res('post-haussmannien', 0.65, 'deduit');
      return res('brique', 0.5, 'deduit');
    }
    if (an >= 1852) {
      if (brique && !pierre) return r.push('murs brique'), res('brique', 0.6, 'deduit');
      if (meuliere && h < 12) return r.push('meulière, bas'), res('faubourien', 0.6, 'deduit');
      if (h >= 12 || pierre || mansarde) {
        r.push([pierre && 'murs pierre', mansarde && 'mansarde LiDAR', h >= 12 && `h ${h.toFixed(0)} m`].filter(Boolean).join(', '));
        return an >= 1890 && an % 50 !== 0 ? res('post-haussmannien', 0.8, 'deduit') : res('haussmannien', 0.85, 'deduit');
      }
      return res('faubourien', 0.6, 'deduit');
    }
    // Avant Haussmann
    return res('faubourien', 0.7, 'deduit');
  }
  // Année inconnue : matériaux, toit, hauteur.
  r.push('année inconnue');
  if (brique) return r.push('murs brique'), res('brique', 0.6, 'deduit');
  if (beton) return r.push('murs béton'), res(h > 20 ? 'tour' : 'moderne', 0.6, 'deduit');
  if (mansarde && h >= 11 && h <= 25) return r.push('mansarde LiDAR', `h ${h.toFixed(0)} m`), res('haussmannien', 0.65, 'deduit');
  if (plat && h >= 12) return r.push('toit plat LiDAR'), res('moderne', 0.55, 'deduit');
  if (h < 11) return r.push(`h ${h.toFixed(0)} m`), res('faubourien', 0.5, 'deduit');
  if (pierre) return r.push('murs pierre'), res('haussmannien', 0.6, 'deduit');
  return r.push('défaut parisien'), res('haussmannien', 0.4, 'genere');
}

// ---------------------------------------------------------------------------
// Grammaires
// ---------------------------------------------------------------------------
interface Grammaire {
  materiau: Materiau;
  hRdc: number;
  hEntresol: number;
  hNoble: number;
  hCourant: number;
  hDernier: number;
  /** Largeur d'axe en axe d'une travée (m). */
  travee: number;
  /** Fenêtre : largeur, allège (depuis le plancher), linteau (sous le plafond). */
  lFen: number;
  allege: number;
  linteau: number;
  prof: number;
  portesFenetres: boolean;
  corniche: { h: number; saillie: number } | null;
  bandeaux: boolean;
  refends: boolean;
  balconsFilants: boolean;
  encadrement: 0 | 1 | 2;
  volets: number;
  vantaux: number;
  imposte: boolean;
  combles: number;
  teintes: number[];
  menuiseries: number[];
  accents: number[];
  pCommerce: number;
}

const PIERRE = [0xdccdb0, 0xe2d4b8, 0xd6c6a8, 0xe0d3bb, 0xd2c2a4, 0xd9cdb8]; // calcaire lutétien, patiné
const G: Record<Typologie, Grammaire> = {
  haussmannien: {
    materiau: 'pierre', hRdc: 4.4, hEntresol: 2.5, hNoble: 3.35, hCourant: 3.0, hDernier: 2.75, travee: 3.4,
    lFen: 1.25, allege: 0.05, linteau: 0.6, prof: 0.3, portesFenetres: true, corniche: { h: 0.75, saillie: 0.5 },
    bandeaux: true, refends: true, balconsFilants: true, encadrement: 1, volets: 0, vantaux: 2, imposte: true, combles: 1,
    teintes: PIERRE, menuiseries: [0xf2efe8, 0xeae6dc, 0xf6f4ee], accents: [0x22382c, 0x1f2a36, 0x3a1f1f, 0x2b2b2b], pCommerce: 0.6,
  },
  'post-haussmannien': {
    materiau: 'pierre', hRdc: 4.2, hEntresol: 2.4, hNoble: 3.2, hCourant: 2.95, hDernier: 2.7, travee: 3.3,
    lFen: 1.3, allege: 0.05, linteau: 0.55, prof: 0.3, portesFenetres: true, corniche: { h: 0.6, saillie: 0.45 },
    bandeaux: true, refends: true, balconsFilants: true, encadrement: 2, volets: 0, vantaux: 2, imposte: true, combles: 1,
    teintes: [0xe0d4bc, 0xdccfb4, 0xe5dac6, 0xd6c8ac], menuiseries: [0xf2efe8, 0xe8e4da], accents: [0x22382c, 0x2b2b2b, 0x4a2e22], pCommerce: 0.5,
  },
  faubourien: {
    materiau: 'enduit', hRdc: 3.4, hEntresol: 2.3, hNoble: 2.75, hCourant: 2.7, hDernier: 2.5, travee: 2.7,
    lFen: 1.0, allege: 0.85, linteau: 0.45, prof: 0.22, portesFenetres: false, corniche: { h: 0.35, saillie: 0.25 },
    bandeaux: true, refends: false, balconsFilants: false, encadrement: 1, volets: 0.35, vantaux: 2, imposte: false, combles: 1,
    teintes: [0xeee5d2, 0xe9d8b4, 0xe6d3b8, 0xdcd6cb, 0xefe6d6, 0xe3c9a2, 0xd9cfc0],
    menuiseries: [0xf1eee8, 0xe7e2d8], accents: [0x5a6b4a, 0x6b7c8c, 0x7a5c3e, 0x4f5a52, 0x8a8f87], pCommerce: 0.7,
  },
  brique: {
    materiau: 'brique', hRdc: 3.3, hEntresol: 2.3, hNoble: 2.8, hCourant: 2.75, hDernier: 2.7, travee: 3.0,
    lFen: 1.35, allege: 0.9, linteau: 0.4, prof: 0.2, portesFenetres: false, corniche: { h: 0.4, saillie: 0.3 },
    bandeaux: true, refends: false, balconsFilants: false, encadrement: 1, volets: 0, vantaux: 2, imposte: true, combles: 0,
    teintes: [0xb5613f, 0xa95a3c, 0xc0704b, 0x9e5236, 0xc58a5a], menuiseries: [0xf0ede6, 0xe6e1d6], accents: [0x2f3a40, 0x3d4a3a], pCommerce: 0.3,
  },
  moderne: {
    materiau: 'beton', hRdc: 3.2, hEntresol: 2.5, hNoble: 2.65, hCourant: 2.65, hDernier: 2.65, travee: 3.0,
    lFen: 2.0, allege: 0.95, linteau: 0.3, prof: 0.15, portesFenetres: false, corniche: { h: 0.3, saillie: 0.1 },
    bandeaux: true, refends: false, balconsFilants: false, encadrement: 0, volets: 0, vantaux: 2, imposte: false, combles: 0,
    teintes: [0xd8d4cb, 0xe3ded3, 0xcfcac0, 0xdcd8d0, 0xe8e2d4], menuiseries: [0x9aa0a6, 0xd9d9d6, 0x6d7278], accents: [0x5d6670, 0x7a6f62], pCommerce: 0.35,
  },
  tour: {
    materiau: 'beton', hRdc: 3.6, hEntresol: 2.5, hNoble: 2.65, hCourant: 2.65, hDernier: 2.65, travee: 2.7,
    lFen: 1.8, allege: 0.9, linteau: 0.3, prof: 0.12, portesFenetres: false, corniche: { h: 0.4, saillie: 0.08 },
    bandeaux: true, refends: false, balconsFilants: false, encadrement: 0, volets: 0, vantaux: 2, imposte: false, combles: 0,
    teintes: [0xd6d3cc, 0xcac6bd, 0xe0dcd3], menuiseries: [0x8c9298, 0xbfc3c6], accents: [0x5d6670], pCommerce: 0.2,
  },
  contemporain: {
    materiau: 'enduit', hRdc: 3.8, hEntresol: 2.5, hNoble: 2.9, hCourant: 2.9, hDernier: 2.9, travee: 3.2,
    lFen: 1.6, allege: 0.1, linteau: 0.5, prof: 0.2, portesFenetres: true, corniche: { h: 0.25, saillie: 0.05 },
    bandeaux: false, refends: false, balconsFilants: false, encadrement: 0, volets: 0, vantaux: 2, imposte: false, combles: 0,
    teintes: [0xf1efea, 0xe9e6df, 0xdedad2, 0xc9c4ba], menuiseries: [0x3a3d40, 0x55595d, 0x8b8f93], accents: [0x3a3d40], pCommerce: 0.4,
  },
  bureaux: {
    materiau: 'verre', hRdc: 4.5, hEntresol: 3.0, hNoble: 3.5, hCourant: 3.5, hDernier: 3.5, travee: 1.5,
    lFen: 1.38, allege: 0.12, linteau: 0.18, prof: 0.06, portesFenetres: false, corniche: { h: 0.6, saillie: 0.05 },
    bandeaux: false, refends: false, balconsFilants: false, encadrement: 0, volets: 0, vantaux: 1, imposte: false, combles: 0,
    teintes: [0x9aa3a8, 0x8d969c, 0xa7adb0], menuiseries: [0x5a6066, 0x7c8288], accents: [0x30353a], pCommerce: 0,
  },
  equipement: {
    materiau: 'pierre', hRdc: 4.6, hEntresol: 3.0, hNoble: 4.2, hCourant: 4.0, hDernier: 3.8, travee: 4.6,
    lFen: 1.6, allege: 0.9, linteau: 0.8, prof: 0.35, portesFenetres: false, corniche: { h: 0.9, saillie: 0.55 },
    bandeaux: true, refends: true, balconsFilants: false, encadrement: 2, volets: 0, vantaux: 2, imposte: true, combles: 0,
    teintes: PIERRE, menuiseries: [0xece8de], accents: [0x2b2b2b], pCommerce: 0,
  },
  annexe: {
    materiau: 'enduit', hRdc: 3.2, hEntresol: 2.5, hNoble: 3.0, hCourant: 3.0, hDernier: 3.0, travee: 6,
    lFen: 1.1, allege: 1.2, linteau: 0.5, prof: 0.15, portesFenetres: false, corniche: { h: 0.2, saillie: 0.1 },
    bandeaux: false, refends: false, balconsFilants: false, encadrement: 0, volets: 0, vantaux: 1, imposte: false, combles: 0,
    teintes: [0xd7d2c8, 0xcfc8ba, 0xe0d9cb], menuiseries: [0x8b8f93], accents: [0x55595d], pCommerce: 0,
  },
};

export const grammaire = (t: Typologie): Readonly<Grammaire> => G[t];

/** Nombre de combles (niveaux sous le toit, au-dessus de la gouttière) d'après le LiDAR, sinon la typologie. */
function nbCombles(e: EntreeFacade, g: Grammaire): number {
  if (e.hHaut == null) return g.combles;
  const d = e.hHaut - e.hGout;
  return d >= 5 ? 2 : d >= 2 ? 1 : 0;
}

/** Niveaux de façade (sous la corniche) : nombre, rôles et hauteurs, calés EXACTEMENT sur la gouttière mesurée. */
export function niveaux(e: EntreeFacade, t: Typologie): { niveaux: Niveau[]; source: Provenance } {
  const g = G[t];
  const corn = g.corniche ? g.corniche.h * 0.5 : 0.2;
  const dispo = Math.max(2.4, e.hGout - corn);
  const estime = Math.max(1, 1 + Math.round((dispo - g.hRdc) / g.hCourant));
  let n = estime, source: Provenance = 'deduit';
  if (e.nbEtages != null && e.nbEtages > 0) {
    const nb = e.nbEtages - nbCombles(e, g);
    // cohérence : hauteur moyenne d'étage plausible (2,4–4,6 m) avec un RDC plus haut
    const moy = nb > 1 ? (dispo - g.hRdc) / (nb - 1) : dispo;
    if (nb >= 1 && moy >= 2.35 && moy <= 4.6) (n = nb), (source = 'mesure');
  }
  if (t === 'annexe') n = Math.max(1, Math.min(n, Math.round(dispo / 3)));
  const entresol = (t === 'haussmannien' || t === 'post-haussmannien') && n >= 7;
  const roles: Niveau['role'][] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) roles.push('rdc');
    else if (i === 1 && entresol) roles.push('entresol');
    else if (i === n - 1 && n >= 4) roles.push('dernier');
    else roles.push('courant');
  }
  // étage noble = « 2e étage » parisien (1er au-dessus de l'entresol + 1)
  const iNoble = entresol ? 3 : 2;
  if ((t === 'haussmannien' || t === 'post-haussmannien' || t === 'equipement') && n > iNoble && roles[iNoble] === 'courant') roles[iNoble] = 'noble';
  const hDef = roles.map((r) => (r === 'rdc' ? g.hRdc : r === 'entresol' ? g.hEntresol : r === 'noble' ? g.hNoble : r === 'dernier' ? g.hDernier : g.hCourant));
  // mise à l'échelle : RDC protégé (≥ 3 m), les étages absorbent l'écart
  const somme = hDef.reduce((a, b) => a + b, 0);
  let k = dispo / somme;
  const hs = hDef.map((h) => h * k);
  if (n > 1 && hs[0]! < 3) {
    const reste = dispo - 3;
    k = reste / (somme - hDef[0]!);
    hs[0] = 3;
    for (let i = 1; i < n; i++) hs[i] = hDef[i]! * k;
  }
  if (n === 1) hs[0] = dispo;
  let v = 0;
  const balconsFilants = g.balconsFilants;
  const out: Niveau[] = roles.map((role, i) => {
    const nv: Niveau = { i, role, v, h: hs[i]!, balconFilant: balconsFilants && (role === 'noble' || (role === 'dernier' && n >= 5)) };
    v += hs[i]!;
    return nv;
  });
  return { niveaux: out, source };
}

/** Compose la façade complète. Déterministe : même entrée ⇒ même FacadeSpec. */
export function composer(e: EntreeFacade, c: Classement = classer(e)): FacadeSpec {
  const t = c.typologie, g = G[t], R = alea(e.id.split(':')[0] + ':' + t); // variations par BÂTIMENT (toutes ses façades identiques)
  const W = e.largeur;
  const { niveaux: nv, source } = niveaux(e, t);
  const teinte = hex(choisir(R, g.teintes)), menu = hex(choisir(R, g.menuiseries)), accent = hex(choisir(R, g.accents));
  const ouvertures: Ouverture[] = [];
  const balcons: Balcon[] = [];
  const bandeaux: Bande[] = [];
  const enseignes: FacadeSpec['enseignes'] = [];
  // Travées : nombre d'après la largeur réelle, axes équidistants et centrés
  const nT = W < g.lFen + 0.8 ? 0 : Math.max(1, Math.round(W / g.travee));
  const pas = nT ? W / nT : W;
  const lFen = Math.min(g.lFen, pas - 0.5);
  const axes = Array.from({ length: nT }, (_, j) => pas * (j + 0.5));
  const commerce = e.commerce ?? (g.pCommerce > 0 && R() < g.pCommerce && W >= 4);
  const iPorte = nT >= 3 ? Math.floor(nT / 2) - (nT % 2 === 0 && R() < 0.5 ? 1 : 0) : nT === 2 ? (R() < 0.5 ? 0 : 1) : 0;
  const volets = g.volets > 0 && R() < g.volets;

  for (const n of nv) {
    if (n.role === 'rdc') {
      if (!nT) continue;
      if (t === 'bureaux') {
        for (let j = 0; j < nT; j++) ouvertures.push(ouv(n, j, 'mur-rideau', axes[j]! - lFen / 2, 0.1, lFen, n.h - 0.5, 0.06, g, menu));
        continue;
      }
      for (let j = 0; j < nT; j++) {
        const ax = axes[j]!;
        if (j === iPorte && nT >= 1 && t !== 'annexe') {
          const cochere = (t === 'haussmannien' || t === 'post-haussmannien' || t === 'equipement') && pas >= 2.6;
          const l = cochere ? Math.min(2.6, pas - 0.6) : Math.min(1.2, pas - 0.6);
          const h = cochere ? Math.min(n.h - 0.5, 4.0) : Math.min(n.h - 0.5, 2.5);
          ouvertures.push(ouv(n, j, cochere ? 'porte-cochere' : 'porte', ax - l / 2, 0, l, h, g.prof + 0.1, g, menu));
        } else if (commerce) {
          const l = pas - 0.6, h = Math.min(n.h - 1.0, 3.2);
          ouvertures.push(ouv(n, j, 'vitrine', ax - l / 2, 0, l, h, 0.25, g, menu));
          enseignes.push({ u: ax - l / 2, v: h + 0.1, l, h: Math.min(0.55, n.h - h - 0.25) });
        } else {
          const all = t === 'contemporain' ? 0.1 : 1.0;
          const h = Math.min(n.h - all - 0.6, 2.6);
          if (h > 0.8) ouvertures.push({ ...ouv(n, j, 'fenetre', ax - lFen / 2, all, lFen, h, g.prof, g, menu), gardeCorps: false, encadrement: 0 });
        }
      }
      continue;
    }
    if (!nT) continue;
    const entresol = n.role === 'entresol';
    const allege = entresol ? 0.35 : g.allege;
    const linteau = entresol ? 0.35 : g.linteau;
    const h = n.h - allege - linteau;
    if (h < 0.6) continue;
    const pf = g.portesFenetres && !entresol;
    const enc: 0 | 1 | 2 = n.role === 'noble' ? (g.encadrement > 0 ? 2 : 0) : g.encadrement;
    for (let j = 0; j < nT; j++) {
      const o = ouv(n, j, t === 'bureaux' ? 'mur-rideau' : pf ? 'porte-fenetre' : 'fenetre', axes[j]! - lFen / 2, n.v + allege, lFen, h, g.prof, g, menu);
      o.gardeCorps = pf && !n.balconFilant;
      o.encadrement = entresol ? Math.min(1, enc) as 0 | 1 : enc;
      o.volets = volets && !pf;
      ouvertures.push(o);
    }
    if (n.balconFilant) {
      const u0 = Math.max(0.15, axes[0]! - lFen / 2 - 0.45), u1 = Math.min(W - 0.15, axes[nT - 1]! + lFen / 2 + 0.45);
      const consoles: number[] = [];
      for (let j = 0; j <= nT; j++) {
        const u = j === 0 ? u0 + 0.25 : j === nT ? u1 - 0.25 : pas * j;
        consoles.push(u);
      }
      balcons.push({ v: n.v, u0, u1, saillie: n.role === 'noble' ? 0.85 : 0.7, consoles });
    }
  }
  // Bandeaux (cordons) aux planchers
  if (g.bandeaux) for (const n of nv) if (n.i > 0 && !n.balconFilant) bandeaux.push({ v: n.v - 0.1, h: n.role === 'entresol' || n.i === 1 ? 0.28 : 0.16, saillie: t === 'moderne' || t === 'tour' ? 0.03 : 0.07 });
  const haut = e.hGout;
  const corniche = g.corniche ? { v: haut - g.corniche.h, h: g.corniche.h, saillie: g.corniche.saillie } : null;
  return {
    id: e.id, classement: c, largeur: W, hauteur: haut, socle: Math.max(0, e.socle ?? 0), materiau: g.materiau, refends: g.refends,
    teinte, teinteMenuiserie: menu, teinteAccent: accent, niveaux: nv, sourceEtages: source, nbTravees: nT, ouvertures, balcons, bandeaux, corniche, enseignes,
  };
}

function ouv(n: Niveau, j: number, type: TypeOuverture, u: number, v: number, l: number, h: number, prof: number, g: Grammaire, _m: unknown): Ouverture {
  const vv = n.role === 'rdc' ? v : v;
  return { niveau: n.i, travee: j, type, u, v: vv, l, h, prof, gardeCorps: false, encadrement: 0, volets: false, vantaux: type === 'vitrine' ? 3 : g.vantaux, imposte: g.imposte && (type === 'fenetre' || type === 'porte-fenetre') };
}

/** Vérifie les invariants d'une FacadeSpec ; renvoie la liste des violations (vide = valide). */
export function verifier(s: FacadeSpec): string[] {
  const err: string[] = [];
  const fin = (x: number) => Number.isFinite(x);
  for (const o of s.ouvertures) {
    if (![o.u, o.v, o.l, o.h].every(fin)) err.push(`NaN ouverture ${o.niveau}/${o.travee}`);
    if (o.v < -1e-6) err.push(`ouverture sous le pied ${o.niveau}/${o.travee}`);
    if (o.v + o.h > s.hauteur + 1e-6) err.push(`ouverture au-dessus de la gouttière ${o.niveau}/${o.travee}`);
    if (o.u < -1e-6 || o.u + o.l > s.largeur + 1e-6) err.push(`ouverture hors façade ${o.niveau}/${o.travee}`);
    const nv = s.niveaux[o.niveau]!;
    if (o.v < nv.v - 1e-6 || o.v + o.h > nv.v + nv.h + 1e-6) err.push(`ouverture hors de son niveau ${o.niveau}/${o.travee}`);
  }
  const somme = s.niveaux.reduce((a, n) => a + n.h, 0);
  if (somme > s.hauteur + 1e-6) err.push('niveaux plus hauts que la gouttière');
  // alignement vertical des travées (hors RDC)
  const axes = new Map<number, number>();
  for (const o of s.ouvertures) {
    if (o.niveau === 0) continue;
    const c = o.u + o.l / 2, a = axes.get(o.travee);
    if (a == null) axes.set(o.travee, c);
    else if (Math.abs(a - c) > 1e-6) err.push(`travée ${o.travee} désalignée`);
  }
  return err;
}
