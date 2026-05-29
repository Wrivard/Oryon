// Bump déterministe vers une pré-version X.Y.Z-dev.N (canal 'dev' pour electron-updater/electron-builder).
// Si déjà -dev.N → N+1 ; sinon patch+1 puis -dev.1. N'écrit QUE package.json (electron-builder lit la version).
import { readFileSync, writeFileSync } from 'node:fs'

const path = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(path, 'utf8'))
const m = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/.exec(pkg.version)
if (!m) {
  console.error('Version inattendue:', pkg.version)
  process.exit(1)
}
const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
const next = m[4] !== undefined ? `${maj}.${min}.${pat}-dev.${Number(m[4]) + 1}` : `${maj}.${min}.${pat + 1}-dev.1`
pkg.version = next
writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
console.log('version ->', next)
