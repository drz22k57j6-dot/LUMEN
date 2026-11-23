import { describe, expect, it } from 'vitest';
import { lampesAllumees, partFenetres } from '../apps/web/src/nuit';

describe('nuit — modèle d’occupation et allumage', () => {
  it('fenêtres : pic en soirée, creux vers 4 h, rien en plein jour', () => {
    expect(partFenetres(21, 2, -20)).toBeGreaterThan(0.4);
    expect(partFenetres(4, 2, -20)).toBeLessThan(0.05);
    expect(partFenetres(13, 2, 30)).toBe(0);
    expect(partFenetres(7.5, 2, -5)).toBeGreaterThan(partFenetres(10, 2, -5));
  });
  it('week-end : réveil plus tardif, soirée plus longue', () => {
    expect(partFenetres(7, 6, -10)).toBeLessThan(partFenetres(7, 2, -10));
    expect(partFenetres(23.5, 6, -20)).toBeGreaterThan(partFenetres(23.5, 2, -20));
  });
  it('lampadaires : allumés quand le soleil passe 2° sous l’horizon', () => {
    expect(lampesAllumees(0)).toBe(false);
    expect(lampesAllumees(-3)).toBe(true);
  });
});
