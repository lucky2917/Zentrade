/**
 * Exports every contract as a JSON-Schema file into dist/schemas/.
 * Consumers outside the TS world (tooling, docs, other languages) read these.
 * Run: npm run schemas -w packages/contracts   (builds first)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import * as contracts from "../dist/index.js";

const outDir = new URL("../dist/schemas/", import.meta.url);
await mkdir(outDir, { recursive: true });

let count = 0;
for (const [name, value] of Object.entries(contracts)) {
    if (!(value instanceof z.ZodType)) continue;
    const schema = z.toJSONSchema(value, { io: "output" });
    await writeFile(new URL(`${name}.schema.json`, outDir), JSON.stringify(schema, null, 2) + "\n");
    count++;
}
console.log(`exported ${count} JSON schemas to dist/schemas/`);
