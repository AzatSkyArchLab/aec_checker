import { IfcAPI, IFCPRODUCT } from "web-ifc";
import { readFileSync } from "node:fs";

const api = new IfcAPI();
await api.Init();
const data = new Uint8Array(readFileSync(new URL("../samples/wall.ifc", import.meta.url)));
const modelID = api.OpenModel(data, { COORDINATE_TO_ORIGIN: true });

const ids = api.GetLineIDsWithType(modelID, IFCPRODUCT, true);
console.log("products:", Array.from({ length: ids.size() }, (_, i) => ids.get(i)));

const wallID = 33;
console.log("\n-- getItemProperties(33) keys --");
const item = await api.properties.getItemProperties(modelID, wallID, false);
console.log(Object.keys(item));

console.log("\n-- getPropertySets(33, true, true) --");
try {
  const psets = await api.properties.getPropertySets(modelID, wallID, true, true);
  console.log("count:", psets.length);
  console.log(JSON.stringify(psets, null, 2).slice(0, 1500));
} catch (e) {
  console.error("getPropertySets THREW:", e.message);
}

console.log("\n-- getPropertySets(33, true, false) --");
try {
  const psets = await api.properties.getPropertySets(modelID, wallID, true, false);
  console.log("count:", psets.length);
} catch (e) {
  console.error("THREW:", e.message);
}

api.CloseModel(modelID);
