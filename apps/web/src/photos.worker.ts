// Cuisson des façades photographiques hors du fil principal (l'interface reste fluide sur iPhone).
import { facadesPhotos, type Bati, type PhotoRue, type TachePhoto } from './photofacades';

self.onmessage = async (e: MessageEvent<{ taches: TachePhoto[]; batis: Bati[]; photos: PhotoRue[]; mobile: boolean }>) => {
  const { taches, batis, photos, mobile } = e.data;
  try {
    const r = await facadesPhotos(taches, batis, photos, mobile, (f) => self.postMessage({ type: 'progres', f }));
    const atlas = r.atlas.map((a) => ({ data: a.img.data, cote: a.img.width, pos: a.pos, uv: a.uv }));
    self.postMessage({ type: 'fini', atlas, couverture: r.couverture, auteurs: r.auteurs }, { transfer: atlas.flatMap((a) => [a.data.buffer, a.pos.buffer, a.uv.buffer]) });
  } catch (err) {
    self.postMessage({ type: 'erreur', message: String(err) });
  }
};
