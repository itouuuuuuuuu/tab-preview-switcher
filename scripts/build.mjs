import { context, build } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'

const outdir = 'dist'
const watch = process.argv.includes('--watch')
const minify = process.env.NODE_ENV === 'production'

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  target: 'chrome112',
  minify,
  sourcemap: minify ? false : 'inline',
  logLevel: 'info',
}

const bundles = [
  { entryPoints: ['src/background.ts'], outfile: `${outdir}/background.js`, format: 'esm' },
  { entryPoints: ['src/content.ts'], outfile: `${outdir}/content.js`, format: 'iife' },
  { entryPoints: ['src/overlay/overlay.ts'], outfile: `${outdir}/overlay.js`, format: 'iife' },
]

const statics = [
  ['manifest.json', `${outdir}/manifest.json`],
  ['src/overlay/overlay.html', `${outdir}/overlay.html`],
  ['src/overlay/overlay.css', `${outdir}/overlay.css`],
]

async function copyStatics() {
  await Promise.all(statics.map(([from, to]) => cp(from, to)))
}

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

if (watch) {
  const contexts = await Promise.all(bundles.map((b) => context({ ...common, ...b })))
  await Promise.all(contexts.map((c) => c.watch()))
  await copyStatics()
  console.log(`watching… (re-run to pick up changes to static files)`)
} else {
  await Promise.all(bundles.map((b) => build({ ...common, ...b })))
  await copyStatics()
  console.log(`built -> ${outdir}/`)
}
