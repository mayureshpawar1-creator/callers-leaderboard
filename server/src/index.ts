import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db/index.js";
import { createApp } from "./app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.cwd();
const dataDir = path.resolve(process.env.CIM_DATA_DIR ?? path.join(projectRoot, "data"));
const port = Number(process.env.PORT ?? 4300);
const host = process.env.HOST ?? "127.0.0.1"; // local-only by default

const db = openDatabase(path.join(dataDir, "cim.sqlite"));
const app = createApp(db, {
  uploadDir: path.join(dataDir, "uploads"),
  // Compiled server lives in dist/server/server/src; the client build is dist/client.
  clientDir: path.resolve(here, "../../../client"),
});

app.listen(port, host, () => {
  console.log(`Caller Performance & Incentive Manager API on http://${host}:${port} (data: ${dataDir})`);
});
