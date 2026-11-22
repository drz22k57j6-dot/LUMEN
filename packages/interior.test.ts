import { describe, expect, it } from 'vitest';
import {
  azimutCote, cardinal, erreursPlan, orientationsOuvertures, fenetresMonde, genererVolumes, planModele, planVersLocal, planVide,
  portesInterieures, segmentsMurs, type Ancrage, type Plan,
} from './interior/src';
import { ensoleillementJour, ensoleillementPieceJour } from './analysis/src';

const PANTHEON = { lon: 2.346631, lat: 48.845364 };

const deuxPieces = (): Plan => {
  const p = planVide();
  p.pieces.push(
    { id: 'a', type: 'sejour', x: 0, y: 0, l: 4, p: 4, source: 'deduit' },
    { id: 'b', type: 'chambre', x: 4, y: 0, l: 3, p: 4, source: 'deduit' },
  );
  p.ouvertures.push({ id: 'f', piece: 'a', cote: 'bas', position: 2, largeur: 1.2, hauteur: 1.45, allege: 0.9, type: 'fenetre', source: 'deduit' });
  return p;
};

describe('interior — plan', () => {
  it('murs : une cloison partagée, le reste extérieur', () => {
    const s = segmentsMurs(deuxPieces());
    const cloisons = s.filter((x) => !x.exterieur);
    expect(cloisons).toHaveLength(1);
    expect(cloisons[0]).toMatchObject({ x1: 4, y1: 0, x2: 4, y2: 4, pieces: ['a', 'b'] });
    const longueurExt = s.filter((x) => x.exterieur).reduce((t, x) => t + Math.hypot(x.x2 - x.x1, x.y2 - x.y1), 0);
    expect(longueurExt).toBeCloseTo(2 * 7 + 2 * 4);
  });
  it('détecte chevauchement et fenêtre sur cloison', () => {
    const p = deuxPieces();
    expect(erreursPlan(p)).toEqual([]);
    p.ouvertures.push({ id: 'g', piece: 'a', cote: 'droite', position: 2, largeur: 1, hauteur: 1.4, allege: 0.9, type: 'fenetre', source: 'deduit' });
    p.pieces.push({ id: 'c', type: 'wc', x: 6, y: 3, l: 2, p: 2, source: 'deduit' });
    const e = erreursPlan(p).join(' | ');
    expect(e).toMatch(/cloison/);
    expect(e).toMatch(/chevauchent/);
  });
  it('les modèles Studio / T2 / T3 sont valides', () => {
    for (const m of ['studio', 't2', 't3'] as const) expect(erreursPlan(planModele(m))).toEqual([]);
  });
  it('volumes : trou de fenêtre (allège + linteau + vitre) et porte intérieure', () => {
    const p = deuxPieces();
    const v = genererVolumes(p);
    expect(v.filter((b) => b.type === 'vitre')).toHaveLength(1);
    expect(v.filter((b) => b.type === 'sol')).toHaveLength(2);
    expect(portesInterieures(p)).toHaveLength(1);
    // Surface de mur extérieur bas de la pièce a = (4 + 0,3) × 2,7 − fenêtre 1,2 × 1,45
    const bas = v.filter((b) => b.type === 'mur' && Math.abs(b.centre[1]) < 1e-6 && b.centre[0] < 4);
    const aire = bas.reduce((t, b) => t + b.taille[0] * b.taille[2], 0);
    expect(aire).toBeCloseTo((4 + 0.3) * 2.7 - 1.2 * 1.45, 5);
  });
});

describe('interior — ancrage', () => {
  // Façade orientée nord : normale sortante (0, -1) en (x, z) local.
  const a: Ancrage = { origine: [10, 6, 20], normale: [0, -1], azimutFacade: 0, epaisseurMurExt: 0.3 };
  it('le plan part vers l’intérieur (sud) et x va vers l’ouest', () => {
    const [x, y, z] = planVersLocal(a, 2, 3, 1);
    expect(x).toBeCloseTo(8);
    expect(y).toBeCloseTo(7);
    expect(z).toBeCloseTo(20 + 3.15);
  });
  it('azimuts des côtés', () => {
    expect(azimutCote(0, 'bas')).toBe(0);
    expect(azimutCote(0, 'haut')).toBe(180);
    expect(azimutCote(0, 'gauche')).toBe(90);
    expect(azimutCote(0, 'droite')).toBe(270);
  });
  it('les points de la fenêtre sont devant la façade', () => {
    const [f] = fenetresMonde(deuxPieces(), a);
    expect(f!.points).toHaveLength(3);
    for (const p of f!.points) expect(p[2]).toBeLessThan(20); // au nord de la façade
    expect(f!.azimut).toBe(0);
  });
});

describe('analysis — pièce', () => {
  it('une fenêtre, un point, sans obstacle = même résultat que la fenêtre seule', () => {
    const jour = new Date(Date.UTC(2026, 2, 21, 12));
    const seul = ensoleillementJour({ lieu: PANTHEON, point: [0, 0, 0], azimutFacade: 180, annee: 2026, obstacle: () => false }, jour);
    const piece = ensoleillementPieceJour({ lieu: PANTHEON, fenetres: [{ points: [[0, 0, 0]], azimut: 180 }], annee: 2026, obstacle: () => false }, jour);
    expect(piece.minutes).toBe(seul.minutes);
  });
  it('fenêtres est + ouest ≥ chacune', () => {
    const jour = new Date(Date.UTC(2026, 5, 21, 12));
    const base = { lieu: PANTHEON, annee: 2026, obstacle: () => false };
    const est = ensoleillementPieceJour({ ...base, fenetres: [{ points: [[0, 0, 0]], azimut: 90 }] }, jour).minutes;
    const deux = ensoleillementPieceJour({ ...base, fenetres: [{ points: [[0, 0, 0]], azimut: 90 }, { points: [[0, 0, 0]], azimut: 270 }] }, jour).minutes;
    expect(deux).toBeGreaterThan(est);
  });
});

describe('interior — orientation sans 3D', () => {
  it('fenêtres orientées à partir du côté bas', () => {
    const p = deuxPieces();
    expect(orientationsOuvertures(p)).toEqual([]);
    p.azimutBas = 180;
    p.ouvertures.push({ id: 'g', piece: 'b', cote: 'droite', position: 2, largeur: 1, hauteur: 1.4, allege: 0.9, type: 'fenetre', source: 'deduit' });
    const o = orientationsOuvertures(p);
    expect(o.map((x) => x.cardinal)).toEqual(['Sud', 'Est']);
    expect(cardinal(359)).toBe('Nord');
  });
});
