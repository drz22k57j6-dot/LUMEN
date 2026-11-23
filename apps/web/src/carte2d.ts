/**
 * Carte 2D d'accueil (façon Uber Eats) : fond IGN vectoriel restylé, empreinte de chaque bâtiment,
 * monuments et grands commerces. On tape une adresse → on propose le bâtiment → l'agent confirme.
 */
import maplibregl, { type StyleSpecification, type LayerSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Adresse, Batiment } from '@lumen/core';
import { versL93 as versL93Local, versWgs84 } from '@lumen/core';
import { batimentsAutour, contient } from '@lumen/urban';

const STYLE_IGN = 'https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/standard.json';

// Palette sobre (fond clair, bâtiments gris chaud, verdure et eau douces)
const C = {
  fond: '#f4f3f0', eau: '#cfe2f2', vert: '#dcebd3', bati: '#e4e1db', batiTrait: '#cfcac1', route: '#ffffff', routeBord: '#e2dfd8',
  texte: '#4a4a4a', halo: '#ffffff', accent: '#06c167',
};

function restyler(st: StyleSpecification): StyleSpecification {
  const garder = (l: LayerSpecification) => {
    const sl = (l as { 'source-layer'?: string })['source-layer'] ?? '';
    if (/^(oro_|limite_lin|toponyme_limite|toponyme_oro|routier_ponc|toponyme_routier_borne|toponyme_routier_numero|ferre_sou|routier_chemin_sou|routier_route_sou|hydro_reseau_sou|bati_lin|toponyme_parcellaire)/.test(sl)) return false;
    return true;
  };
  const layers = st.layers.filter(garder).map((l) => {
    const sl = (l as { 'source-layer'?: string })['source-layer'] ?? '';
    const p = ((l as { paint?: Record<string, unknown> }).paint ??= {});
    if (l.type === 'background') p['background-color'] = C.fond;
    else if (l.type === 'fill') {
      if (sl === 'fond_opaque') p['fill-color'] = C.fond;
      else if (sl.startsWith('hydro')) p['fill-color'] = C.eau;
      else if (sl.startsWith('ocs_vegetation')) (p['fill-color'] = C.vert), (p['fill-opacity'] = 1);
      else if (sl.startsWith('ocs_nature')) p['fill-color'] = C.fond;
      else if (sl === 'bati_surf') (p['fill-color'] = C.bati), (p['fill-outline-color'] = C.batiTrait), (p['fill-opacity'] = 1);
      else if (sl.startsWith('bati')) (p['fill-color'] = C.bati), (p['fill-opacity'] = 0.6);
      else if (sl === 'routier_surf') p['fill-color'] = C.route;
    } else if (l.type === 'line') {
      if (sl.startsWith('hydro')) p['line-color'] = C.eau;
      else if (sl === 'bati_surf') (p['line-color'] = C.batiTrait), (p['line-width'] = 0.6);
      else if (sl.startsWith('routier')) p['line-color'] = /bord|casing|contour/i.test(l.id) ? C.routeBord : C.route;
      else if (sl.startsWith('ferre')) p['line-color'] = '#d6d3cc';
    } else if (l.type === 'symbol') {
      p['text-color'] = sl.startsWith('toponyme_hydro') ? '#5b8fb9' : C.texte;
      p['text-halo-color'] = C.halo;
      p['text-halo-width'] = 1.4;
    }
    return l;
  });
  return { ...st, layers };
}

export interface Carte {
  aller(a: Adresse): Promise<void>;
  montrer(v: boolean): void;
  batiment: () => Batiment | null;
}

export function initCarte(opts: { surSelection: (b: Batiment | null, a: Adresse) => void }): Carte {
  const div = document.createElement('div');
  div.id = 'carte2d';
  document.body.prepend(div);
  const map = new maplibregl.Map({
    container: div,
    center: [2.3488, 48.8534],
    zoom: 12.3,
    attributionControl: { compact: true, customAttribution: '© IGN — Plan IGN, BD TOPO · © OpenStreetMap' },
    pitchWithRotate: false,
    dragRotate: false,
    style: { version: 8, sources: {}, layers: [{ id: 'fond', type: 'background', paint: { 'background-color': C.fond } }] },
  });
  map.touchZoomRotate.disableRotation();
  fetch(STYLE_IGN)
    .then((r) => r.json())
    .then((st: StyleSpecification) => map.setStyle(restyler(st)))
    .catch(() => {});

  let adresse: Adresse | null = null;
  let candidats: Batiment[] = [];
  let choisi: Batiment | null = null;
  const geo = (bs: Batiment[]) => ({
    type: 'FeatureCollection' as const,
    features: bs.map((b) => ({
      type: 'Feature' as const,
      properties: { id: b.id },
      geometry: { type: 'Polygon' as const, coordinates: [[...b.contour, b.contour[0]!].map((p) => { const w = versWgs84(p); return [w.lon, w.lat]; })] },
    })),
  });

  const pret = () =>
    new Promise<void>((res) => (map.isStyleLoaded() ? res() : map.once('idle', () => res())));

  async function couches() {
    await pret();
    if (map.getSource('sel')) return;
    map.addSource('sel', { type: 'geojson', data: geo([]) });
    map.addLayer({ id: 'sel-fill', type: 'fill', source: 'sel', paint: { 'fill-color': C.accent, 'fill-opacity': 0.35 } });
    map.addLayer({ id: 'sel-line', type: 'line', source: 'sel', paint: { 'line-color': '#0a8f4f', 'line-width': 3 } });
    map.addSource('pois', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'pois', type: 'circle', source: 'pois', minzoom: 14,
      paint: { 'circle-radius': 6, 'circle-color': ['match', ['get', 'k'], 'monument', '#7a5af8', '#111111'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
    });
    map.addLayer({
      id: 'pois-txt', type: 'symbol', source: 'pois', minzoom: 15,
      layout: { 'text-field': ['get', 'nom'], 'text-font': ['Source Sans Pro Regular'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
    });
  }

  function marquer(b: Batiment | null) {
    choisi = b;
    (map.getSource('sel') as maplibregl.GeoJSONSource | undefined)?.setData(geo(b ? [b] : []));
    if (adresse) opts.surSelection(b, adresse);
  }

  // Toucher un bâtiment pour corriger la proposition
  map.on('click', (e) => {
    if (!adresse || !candidats.length) return;
    const p = { lon: e.lngLat.lng, lat: e.lngLat.lat };
    const l93 = versL93Local(p);
    const b = candidats.find((c) => contient(c.contour, l93));
    if (b) marquer(b);
  });

  // Grands commerces et monuments (OpenStreetMap, quand on zoome)
  let dernier = '';
  map.on('moveend', async () => {
    if (map.getZoom() < 15) return;
    const bb = map.getBounds();
    const cle = [bb.getSouth(), bb.getWest(), bb.getNorth(), bb.getEast()].map((v) => v.toFixed(3)).join(',');
    if (cle === dernier) return;
    dernier = cle;
    const q = `[out:json][timeout:10];(nwr["shop"~"supermarket|department_store|mall|hypermarket"](${cle});nwr["tourism"~"museum|attraction"](${cle});nwr["historic"="monument"](${cle});nwr["amenity"="place_of_worship"]["name"](${cle}););out center 120;`;
    try {
      const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) });
      const j = (await r.json()) as { elements: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] };
      const features = j.elements
        .map((el) => {
          const c = el.center ?? (el.lat !== undefined ? { lat: el.lat, lon: el.lon! } : null);
          if (!c || !el.tags?.name) return null;
          const k = el.tags.shop ? 'commerce' : 'monument';
          return { type: 'Feature' as const, properties: { nom: el.tags.name, k }, geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] } };
        })
        .filter(Boolean);
      await couches();
      (map.getSource('pois') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features } as GeoJSON.FeatureCollection);
    } catch {
      /* Overpass indisponible : on garde la carte sans points d'intérêt */
    }
  });

  return {
    async aller(a) {
      adresse = a;
      await couches();
      map.flyTo({ center: [a.position.lon, a.position.lat], zoom: 18, duration: 1600, essential: true, padding: { top: 80, bottom: Math.round(innerHeight * 0.42), left: 0, right: 0 } });
      candidats = await batimentsAutour(a.position, 60).catch(() => []);
      // Proposition : le bâtiment qui contient l'adresse, sinon le plus proche.
      let b = candidats.find((c) => contient(c.contour, a.l93)) ?? null;
      if (!b) {
        let dmin = 25;
        for (const c of candidats)
          for (const p of c.contour) {
            const d = Math.hypot(p.x - a.l93.x, p.y - a.l93.y);
            if (d < dmin) (dmin = d), (b = c);
          }
      }
      marquer(b);
    },
    montrer(v) {
      div.hidden = !v;
      if (v) map.resize();
    },
    batiment: () => choisi,
  };
}

