import { IfcAPI } from "web-ifc";
import { readFileSync } from "node:fs";
import { computeFootprint, getGeoReference, footprintToGeo } from "../src/core/geo.ts";

const api = new IfcAPI();
await api.Init();
const fixture = process.argv[2] ?? "georef.ifc";
const data = new Uint8Array(
  readFileSync(new URL(`../samples/${fixture}`, import.meta.url)),
);
console.log("fixture:", fixture);
const modelID = api.OpenModel(data); // без COORDINATE_TO_ORIGIN, как в парсере

const meshes: any[] = [];
let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
api.StreamAllMeshes(modelID, (mesh) => {
  const placed = mesh.geometries;
  for (let i = 0; i < placed.size(); i++) {
    const pg = placed.get(i);
    const geom = api.GetGeometry(modelID, pg.geometryExpressID);
    const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
    const indices = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
    const m = pg.flatTransformation;
    const vc = verts.length / 6;
    const positions = new Float32Array(vc * 3);
    const normals = new Float32Array(vc * 3);
    for (let v = 0; v < vc; v++) {
      const lx = verts[v * 6], ly = verts[v * 6 + 1], lz = verts[v * 6 + 2];
      const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
      const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
      const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
      positions[v * 3] = wx; positions[v * 3 + 1] = wy; positions[v * 3 + 2] = wz;
      minX = Math.min(minX, wx); minY = Math.min(minY, wy); minZ = Math.min(minZ, wz);
      maxX = Math.max(maxX, wx); maxY = Math.max(maxY, wy); maxZ = Math.max(maxZ, wz);
    }
    meshes.push({ expressID: mesh.expressID, positions, normals, indices: new Uint32Array(indices), color: { r: 1, g: 1, b: 1, a: 1 } });
  }
});
const offset = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
for (const mm of meshes)
  for (let i = 0; i < mm.positions.length; i += 3) {
    mm.positions[i] -= offset.x; mm.positions[i + 1] -= offset.y; mm.positions[i + 2] -= offset.z;
  }

console.log("offset:", offset, "| meshes:", meshes.length);
const fp = computeFootprint(meshes, offset);
console.log("rings:", fp.rings.length, "| lines:", fp.lines.length);
console.log("ring0 (мировые XY IFC):", JSON.stringify(fp.rings[0]));
const ref = await getGeoReference(api, modelID);
console.log("georef:", JSON.stringify(ref));
if (ref.ok) {
  const geo = footprintToGeo(fp, ref.ref);
  console.log("anchor:", geo.anchor);
  console.log("geo ring0:", JSON.stringify(geo.rings[0]));
}
api.CloseModel(modelID);
