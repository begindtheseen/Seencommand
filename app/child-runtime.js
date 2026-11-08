const fs = require('node:fs');

const SYSTEM_NODE_CANDIDATES = ['/opt/homebrew/bin/node', '/usr/local/bin/node'];

function selectChildRuntime(embeddedExecutable, { existsSync = fs.existsSync, candidates = SYSTEM_NODE_CANDIDATES } = {}) {
  const systemNode = candidates.find((candidate) => existsSync(candidate));
  return systemNode
    ? { executable: systemNode, usesEmbeddedElectron: false }
    : { executable: embeddedExecutable, usesEmbeddedElectron: true };
}

function buildChildEnv({ baseEnv, runtime, userData, port, nodeOptions, compilerToolDir }) {
  const env = {
    ...baseEnv,
    SEEN_HOME: userData,
    PORT: String(port),
    SEEN_NO_OPEN: '1',
    NODE_OPTIONS: nodeOptions,
    VSC_TOOL_DIR: compilerToolDir,
  };
  if (runtime.usesEmbeddedElectron) env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

module.exports = { selectChildRuntime, buildChildEnv };
