declare module 'clipper-lib' {
  interface IntPoint { X: number; Y: number }
  type Path = IntPoint[];
  const ClipperLib: {
    Clipper: new () => {
      AddPaths(p: Path[], t: number, closed: boolean): boolean;
      Execute(ct: number, tree: unknown, sf: number, cf: number): boolean;
    };
    PolyTree: new () => unknown;
    ClipType: { ctIntersection: number; ctUnion: number; ctDifference: number };
    PolyType: { ptSubject: number; ptClip: number };
    PolyFillType: { pftNonZero: number };
    JS: { PolyTreeToExPolygons(t: unknown): { outer: Path; holes: Path[] }[] };
  };
  export default ClipperLib;
}
