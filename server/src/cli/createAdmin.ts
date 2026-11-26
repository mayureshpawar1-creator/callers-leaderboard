// Usage: npm run create-admin -- <username> "<Display Name>" <password>
import path from "node:path";
import { openDatabase } from "../db/index.js";
import { createUser, validateNewPassword } from "../auth/auth.js";

const [username, displayName, password] = process.argv.slice(2);
if (!username || !displayName || !password) {
  console.error('Usage: npm run create-admin -- <username> "<Display Name>" <password>');
  process.exit(1);
}
const pwErr = validateNewPassword(password);
if (pwErr) {
  console.error(pwErr);
  process.exit(1);
}
const dataDir = path.resolve(process.env.CIM_DATA_DIR ?? path.join(process.cwd(), "data"));
const db = openDatabase(path.join(dataDir, "cim.sqlite"));
const id = createUser(db, username, displayName, password);
console.log(`Created admin "${username}" (id ${id}).`);
