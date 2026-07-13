import * as os from "node:os";
import * as path from "node:path";

process.env.BACKBURNER_ROOT = path.join(os.tmpdir(), `backburner-test-root-${process.pid}`);
