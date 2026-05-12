const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const local = path.join(root, ".env.local");
const real = path.join(root, ".env");

if (!fs.existsSync(local)) {
  console.error("[env:init] .env.local not found; nothing to seed from");
  process.exit(1);
}
else if (fs.existsSync(real) === false) {
  fs.copyFileSync(local, real);
}
