// Executable entry (bin). All CLI wiring lives in ./cli.ts so it can be
// imported (tests, other entries) without parsing process.argv.
import { main } from "./cli.js";

void main();
