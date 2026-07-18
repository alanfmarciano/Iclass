import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { computeSourceHash } = require('../../backend/utils/buildIntegrity.js')
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const meta = {
  sourceHash: computeSourceHash(),
  builtAt: new Date().toISOString(),
  node: process.version,
}
fs.writeFileSync(path.join(webRoot, 'dist', 'build-meta.json'), JSON.stringify(meta, null, 2) + '\n')
