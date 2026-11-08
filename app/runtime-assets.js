// Sync packaged read-only assets into Seen Command's writable runtime home.
//
// The dashboard is application code as well as a state snapshot, so every app update must replace
// the prior runtime copy. Otherwise the newly installed server can keep serving an old UI/version
// until a board meeting happens to rebuild it. The state file is owner data and is seeded only once.

const fs = require('node:fs');
const path = require('node:path');

function seedRuntimeAssets({ userData, bundledDashboard, bundledState }) {
  const dataDir = path.join(userData, 'data');
  const publicDir = path.join(userData, 'public');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });

  const dashboardDest = path.join(publicDir, 'command-center.html');
  if (fs.existsSync(bundledDashboard)) fs.copyFileSync(bundledDashboard, dashboardDest);

  const stateDest = path.join(dataDir, 'state.json');
  if (fs.existsSync(bundledState) && !fs.existsSync(stateDest)) {
    fs.copyFileSync(bundledState, stateDest);
  }
}

module.exports = { seedRuntimeAssets };
