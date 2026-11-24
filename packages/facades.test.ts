import { describe, expect, it } from 'vitest';
import { classer, composer, niveaux, verifier, type EntreeFacade } from './facades/src';

const hauss: EntreeFacade = { id: 'BATIMENT1:0', largeur: 17, hGout: 18.5, hHaut: 23, annee: 1880, nbEtages: 7, murs: '10', usage: 'Résidentiel' };

describe('façades — classification par la donnée', () => {
  it('haussmannien : 1880, pierre, mansarde', () => expect(classer(hauss).typologie).toBe('haussmannien'));
  it('faubourien : avant 1850', () => expect(classer({ id: 'a', largeur: 8, hGout: 13, annee: 1800 }).typologie).toBe('faubourien'));
  it('brique : 1930 + murs brique', () => expect(classer({ id: 'a', largeur: 20, hGout: 20, annee: 1930, murs: '40' }).typologie).toBe('brique'));
  it('moderne : 1965', () => expect(classer({ id: 'a', largeur: 30, hGout: 25, annee: 1965 }).typologie).toBe('moderne'));
  it('tour : > 32 m', () => expect(classer({ id: 'a', largeur: 30, hGout: 90, annee: 1975 }).typologie).toBe('tour'));
  it('contemporain : 2005', () => expect(classer({ id: 'a', largeur: 12, hGout: 18, annee: 2005, usage: 'Résidentiel' }).typologie).toBe('contemporain'));
  it('sans année : mansarde ⇒ haussmannien', () => expect(classer({ id: 'a', largeur: 15, hGout: 17, hHaut: 22 }).typologie).toBe('haussmannien'));
  it('jamais au hasard : même entrée, même résultat, ids différents ⇒ même typologie', () => {
    const t = new Set(Array.from({ length: 50 }, (_, i) => classer({ ...hauss, id: `X${i}` }).typologie));
    expect([...t]).toEqual(['haussmannien']);
  });
});

describe('façades — niveaux', () => {
  it('étages BD TOPO respectés (7 − 1 comble = 6 niveaux de façade)', () => {
    const { niveaux: n, source } = niveaux(hauss, 'haussmannien');
    expect(n.length).toBe(6);
    expect(source).toBe('mesure');
    expect(n.find((x) => x.role === 'noble')?.i).toBe(2);
    expect(n.filter((x) => x.balconFilant).map((x) => x.i)).toEqual([2, 5]);
  });
  it('BD TOPO incohérent ⇒ déduit de la hauteur', () => {
    const { niveaux: n, source } = niveaux({ ...hauss, nbEtages: 1 }, 'haussmannien');
    expect(source).toBe('deduit');
    expect(n.length).toBeGreaterThan(4);
  });
  it('les niveaux tiennent sous la gouttière mesurée', () => {
    const s = composer(hauss);
    expect(s.niveaux.reduce((a, n) => a + n.h, 0)).toBeLessThanOrEqual(hauss.hGout);
  });
});

describe('façades — invariants sur 2 000 façades', () => {
  it('aucune violation', () => {
    let k = 1;
    const R = () => ((k = (k * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2000; i++) {
      const e: EntreeFacade = {
        id: `B${i}:${i % 4}`, largeur: 2 + R() * 40, hGout: 3 + R() * 60, hHaut: R() < 0.7 ? undefined : 3 + R() * 70,
        annee: R() < 0.4 ? undefined : Math.round(1700 + R() * 320), nbEtages: R() < 0.3 ? undefined : Math.round(R() * 20),
        murs: R() < 0.5 ? undefined : String(Math.floor(R() * 5)) + '0', socle: R() * 2,
      };
      if (e.hHaut != null && e.hHaut < e.hGout) e.hHaut = e.hGout;
      const s = composer(e);
      expect(verifier(s), JSON.stringify(e)).toEqual([]);
    }
  });
  it('travées : nombre d’après la largeur (haussmannien 17 m ⇒ 5)', () => expect(composer(hauss).nbTravees).toBe(5));
});
