import { mkdirSync, writeFileSync } from "node:fs";
import { ConfigSchema } from "../packages/core/src/config.ts";

mkdirSync(new URL("../schema/", import.meta.url), { recursive: true });
writeFileSync(new URL("../schema/config.schema.json", import.meta.url), `${JSON.stringify(ConfigSchema, null, 2)}\n`);
