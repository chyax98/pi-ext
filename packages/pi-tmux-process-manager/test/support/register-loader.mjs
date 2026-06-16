// Register .js → .ts loader for test files
import { register } from "node:module";
register(new URL("./ts-loader.mjs", import.meta.url));
