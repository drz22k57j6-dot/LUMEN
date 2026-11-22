import proj4 from 'proj4';

/** Provenance de chaque donnée : on n'affiche jamais une donnée générée comme réelle. */
export type Source = 'mesure' | 'photo' | 'deduit' | 'genere';
export interface Donnee<T> {
  valeur: T;
  source: Source;
  origine: string;
  precision_m?: number;
}
export const donnee = <T>(valeur: T, source: Source, origine: string, precision_m?: number): Donnee<T> =>
  precision_m === undefined ? { valeur, source, origine } : { valeur, source, origine, precision_m };

export interface LonLat { lon: number; lat: number }
export interface XY { x: number; y: number }

export interface Adresse {
  label: string;
  position: LonLat;
  l93: XY;
  idBan: string;
}

export interface Batiment {
  id: string;
  /** Contour extérieur en Lambert-93 (m), sans point de fermeture dupliqué. */
  contour: XY[];
  hauteur: Donnee<number>;
  altitudeSol: Donnee<number>;
  /** Altitude de la gouttière (bas du toit), si connue. */
  altitudeToit?: Donnee<number>;
  nature?: string;
  usage?: string;
  nbLogements?: number;
  nbEtages?: number;
  idRnb?: string;
}

export interface Etage { numero: number; altitudePlancher: Donnee<number> }

export interface Ouverture {
  type: 'fenetre' | 'porte_fenetre' | 'velux';
  /** Centre de l'ouverture en Lambert-93 + altitude (m). */
  centre: XY & { z: number };
  /** Azimut de la normale sortante, en degrés depuis le nord, sens horaire. */
  azimut: Donnee<number>;
  largeur: Donnee<number>;
  hauteur: Donnee<number>;
}

// --- Projections ---------------------------------------------------------
proj4.defs(
  'EPSG:2154',
  '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
);
const conv = proj4('EPSG:4326', 'EPSG:2154');

export const versL93 = ({ lon, lat }: LonLat): XY => {
  const [x, y] = conv.forward([lon, lat]) as [number, number];
  return { x, y };
};
export const versWgs84 = ({ x, y }: XY): LonLat => {
  const [lon, lat] = conv.inverse([x, y]) as [number, number];
  return { lon, lat };
};

/**
 * Repère local de rendu : origine = point de référence, x = est, y = haut, z = sud
 * (convention Three.js : -z pointe vers le nord).
 */
export class RepereLocal {
  constructor(public readonly origine: XY, public readonly altitude0 = 0) {}
  versLocal(p: XY, z = this.altitude0): [number, number, number] {
    return [p.x - this.origine.x, z - this.altitude0, -(p.y - this.origine.y)];
  }
  versL93(x: number, y: number, z: number): XY & { z: number } {
    return { x: x + this.origine.x, y: -z + this.origine.y, z: y + this.altitude0 };
  }
}

/** Azimut (degrés depuis le nord, horaire) d'un vecteur Lambert-93 (dx est, dy nord). */
export const azimutDe = (dx: number, dy: number): number => ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;

// --- Heure de Paris -----------------------------------------------------
const fmtParis = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
/** Instant UTC (ms) correspondant à une heure murale à Paris. */
export function utcDepuisParis(annee: number, mois0: number, jour: number, minutes = 0): number {
  const naif = Date.UTC(annee, mois0, jour, 0, minutes);
  const p = fmtParis.formatToParts(new Date(naif)).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  const vu = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!);
  return naif - (vu - naif);
}
/** Début de la journée murale à Paris pour le n-ième jour (0 = 1er janvier). */
export const debutJourParis = (annee: number, jourAnnee: number) => utcDepuisParis(annee, 0, 1 + jourAnnee);
