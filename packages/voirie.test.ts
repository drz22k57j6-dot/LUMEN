import { describe, expect, it } from 'vitest';
import { donnee, type Batiment, type XY } from './core/src';
import { construireVoirie, type Troncon } from './urban/src';

// Quartier type : deux rues qui se croisent en (0,0), façades à 8 m de l'axe (rue de 16 m).
const rue = (id: string, a: XY, b: XY): Troncon => ({
  id, axe: [a, b], nature: 'Route à 1 chaussée', importance: 5,
  largeur: donnee(5, 'deduit', 'test'), voies: 2, sens: 'double', pieton: false,
});
const ilot = (id: string, x0: number, y0: number, x1: number, y1: number): Batiment => ({
  id, contour: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
  hauteur: donnee(18, 'mesure', 'test'), altitudeSol: donnee(0, 'mesure', 'test'),
});
const troncons = [
  rue('ouest', { x: -150, y: 0 }, { x: 0, y: 0 }), rue('est', { x: 0, y: 0 }, { x: 150, y: 0 }),
  rue('sud', { x: 0, y: -150 }, { x: 0, y: 0 }), rue('nord', { x: 0, y: 0 }, { x: 0, y: 150 }),
];
const batiments = [ilot('a', 8, 8, 140, 140), ilot('b', -140, 8, -8, 140), ilot('c', -140, -140, -8, -8), ilot('d', 8, -140, 140, -8)];
const v = construireVoirie(troncons, batiments, { emprise: [-150, -150, 150, 150] });

const aire = (r: XY[]) => Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]!; return s + p.x * q.y - q.x * p.y; }, 0)) / 2;

describe("urban — voirie", () => {
  it('largeur de chaussée déduite de l’espace entre façades (16 m → ~9,6 m)', () => {
    const w = v.largeurs.get('est')!;
    expect(w.source).toBe('deduit');
    expect(w.valeur).toBeGreaterThan(8.5);
    expect(w.valeur).toBeLessThan(9.6);
  });
  it('une seule chaussée continue au carrefour', () => {
    expect(v.chaussee).toHaveLength(1);
  });
  it('angles de rue arrondis (bordure courbe aux 4 coins)', () => {
    const coin = v.chaussee[0]![0]!.filter((p) => Math.abs(p.x) > 4.85 && Math.abs(p.x) < 8.5 && Math.abs(p.y) > 4.85 && Math.abs(p.y) < 8.5);
    expect(coin.length).toBeGreaterThanOrEqual(8);
  });
  it('trottoirs entre chaussée et façades, sans empiéter sur les bâtiments', () => {
    expect(v.trottoirs).toHaveLength(4);
    for (const t of v.trottoirs) {
      for (const p of t[0]!.filter((q) => Math.max(Math.abs(q.x), Math.abs(q.y)) < 139)) expect(Math.min(Math.abs(p.x), Math.abs(p.y))).toBeLessThanOrEqual(8.01);
      expect(aire(t[0]!)).toBeGreaterThan(300);
    }
  });
  it('bordures le long de chaque trottoir', () => {
    expect(v.bordures.length).toBeGreaterThanOrEqual(4);
  });
  it('un passage piéton à chaque branche du carrefour, bandes de 50 cm', () => {
    const branches = new Set(v.passages.map((q) => (Math.abs(q[0].x) > Math.abs(q[0].y) ? Math.sign(q[0].x) * 2 : Math.sign(q[0].y))));
    expect(branches.size).toBe(4);
    const q = v.passages[0]!;
    const larg = Math.min(Math.hypot(q[1].x - q[2].x, q[1].y - q[2].y), Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y));
    expect(larg).toBeCloseTo(0.5, 2);
  });
  it('marquages hors du carrefour et provenance « généré »', () => {
    for (const q of v.marquages) for (const p of q) expect(Math.max(Math.abs(p.x), Math.abs(p.y))).toBeGreaterThan(5);
    expect(v.provenance.marquages!.source).toBe('genere');
  });
  it('déterministe', () => {
    const w = construireVoirie(troncons, batiments, { emprise: [-150, -150, 150, 150] });
    expect(JSON.stringify(w.marquages)).toBe(JSON.stringify(v.marquages));
  });
});
