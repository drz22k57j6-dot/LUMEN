import { donnee, versL93, type Adresse, type Batiment, type LonLat, type XY } from '@lumen/core';

const GEOPF = 'https://data.geopf.fr';

/** Géocodage d'une adresse française (Géoplateforme IGN / BAN). */
export async function geocoder(q: string, limite = 5): Promise<Adresse[]> {
  const url = `${GEOPF}/geocodage/search?q=${encodeURIComponent(q)}&limit=${limite}&index=address`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Géocodage indisponible (${r.status})`);
  const j = (await r.json()) as {
    features: { geometry: { coordinates: [number, number] }; properties: { label: string; id: string } }[];
  };
  return j.features.map((f) => {
    const position: LonLat = { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
    return { label: f.properties.label, position, l93: versL93(position), idBan: f.properties.id };
  });
}

interface ProprietesBdTopo {
  hauteur: number | null;
  altitude_minimale_sol: number | null;
  altitude_minimale_toit: number | null;
  precision_altimetrique: number | null;
  cleabs?: string;
  nature: string | null;
  usage_1: string | null;
  nombre_de_logements: number | null;
  nombre_d_etages: number | null;
  identifiants_rnb: string | null;
  date_d_apparition?: string | null;
  materiaux_des_murs?: string | null;
  materiaux_de_la_toiture?: string | null;
}
interface EntiteBdTopo {
  id: string;
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] } | null;
  properties: ProprietesBdTopo;
}

const HAUTEUR_DEFAUT = 9;

/** Convertit une entité BD TOPO en bâtiment Lumen (contour extérieur du plus grand polygone). */
export function versBatiment(e: EntiteBdTopo): Batiment | null {
  if (!e.geometry) return null;
  const polys = (e.geometry.type === 'Polygon' ? [e.geometry.coordinates] : e.geometry.coordinates) as number[][][][];
  const poly = [...polys].sort((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0))[0];
  const anneau = poly?.[0];
  if (!poly || !anneau || anneau.length < 4) return null;
  const contour: XY[] = anneau.slice(0, -1).map(([lon, lat]) => versL93({ lon: lon!, lat: lat! }));
  const p = e.properties;
  const prec = p.precision_altimetrique ?? undefined;
  const hauteur =
    p.hauteur && p.hauteur > 0
      ? donnee(p.hauteur, 'mesure', 'IGN BD TOPO', prec)
      : donnee(HAUTEUR_DEFAUT, 'genere', 'Lumen (hauteur par défaut)');
  const sol =
    p.altitude_minimale_sol != null
      ? donnee(p.altitude_minimale_sol, 'mesure', 'IGN BD TOPO', prec)
      : donnee(0, 'genere', 'Lumen (altitude inconnue)');
  // identifiant IGN stable (cleabs « BATIMENT… ») : l'id WFS est un numéro interne qui change d'une livraison à l'autre
  const b: Batiment = { id: p.cleabs ?? e.id, contour, hauteur, altitudeSol: sol };
  const trous = poly.slice(1).filter((r) => r.length >= 4).map((r) => r.slice(0, -1).map(([lon, lat]) => versL93({ lon: lon!, lat: lat! })));
  if (trous.length) b.trous = trous;
  if (p.nature) b.nature = p.nature;
  if (p.usage_1) b.usage = p.usage_1;
  if (p.nombre_de_logements != null) b.nbLogements = p.nombre_de_logements;
  if (p.nombre_d_etages != null) b.nbEtages = p.nombre_d_etages;
  if (p.identifiants_rnb) b.idRnb = p.identifiants_rnb;
  const an = p.date_d_apparition ? parseInt(p.date_d_apparition.slice(0, 4), 10) : NaN;
  if (an > 1000 && an < 2100) b.annee = an;
  if (p.materiaux_des_murs) b.murs = p.materiaux_des_murs;
  if (p.materiaux_de_la_toiture) b.toiture = p.materiaux_de_la_toiture;
  return b;
}

/** Bâtiments BD TOPO dans un carré de ± rayon mètres autour d'un point. */
export async function batimentsAutour(centre: LonLat, rayon = 300): Promise<Batiment[]> {
  const dLat = rayon / 111_320;
  const dLon = rayon / (111_320 * Math.cos((centre.lat * Math.PI) / 180));
  const bbox = [centre.lat - dLat, centre.lon - dLon, centre.lat + dLat, centre.lon + dLon].join(',');
  const out: Batiment[] = [];
  const parPage = 1000;
  for (let debut = 0; debut < 10_000; debut += parPage) {
    const url =
      `${GEOPF}/wfs/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=BDTOPO_V3:batiment` +
      `&outputFormat=application/json&srsName=EPSG:4326&count=${parPage}&startIndex=${debut}` +
      `&bbox=${bbox},urn:ogc:def:crs:EPSG::4326`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`BD TOPO indisponible (${r.status})`);
    const j = (await r.json()) as { features: EntiteBdTopo[] };
    for (const f of j.features) {
      const b = versBatiment(f);
      if (b) out.push(b);
    }
    if (j.features.length < parPage) break;
  }
  return out;
}

/** Test point dans polygone (Lambert-93). */
export function contient(contour: XY[], p: XY): boolean {
  let dedans = false;
  for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
    const a = contour[i]!, b = contour[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) dedans = !dedans;
  }
  return dedans;
}

// --- Rasters LiDAR HD / orthophotos (WMS-R Géoplateforme) ---------------
export const COUCHES = {
  mns: 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93',
  mnt: 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93',
  ortho: 'HR.ORTHOIMAGERY.ORTHOPHOTOS',
} as const;

/** URL WMS-R en Lambert-93 pour une emprise [xmin, ymin, xmax, ymax]. */
export function urlWms(couche: string, bbox: [number, number, number, number], w: number, h: number, format: string): string {
  return (
    `${GEOPF}/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${couche}&STYLES=` +
    `&CRS=EPSG:2154&BBOX=${bbox.join(',')}&WIDTH=${w}&HEIGHT=${h}&FORMAT=${encodeURIComponent(format)}`
  );
}
export * from './voirie';
