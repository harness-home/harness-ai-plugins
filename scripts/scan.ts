import { writeFileSync } from 'node:fs'
import { scanRegistry, KEYWORD, REGISTRY_URL } from './registry.js'
import { catalogSnapshotSchema, SNAPSHOT_PATH, type CatalogSnapshot } from './snapshot.js'

// Produce catalog.json. Run by the refresh workflow, and by hand when you want
// to see what the registry currently offers.
//
// The snapshot is validated before it is written: a file that does not satisfy
// the contract is a file the server will reject at ingestion, and finding that
// out here costs seconds instead of a deploy cycle.

const result = await scanRegistry()

const snapshot: CatalogSnapshot = {
  version: 1,
  // Ordered fields, stable sort, and a generation stamp that is the only thing
  // guaranteed to change between runs — so `git diff` shows catalog movement
  // rather than noise.
  generatedAt: new Date().toISOString(),
  source: { registry: REGISTRY_URL, keyword: KEYWORD },
  scan: { scanned: result.scanned, skipped: result.skipped },
  listings: result.listings,
}

catalogSnapshotSchema.parse(snapshot)
writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

const skipped = Object.entries(result.skipped)
  .sort(([, a], [, b]) => b - a)
  .map(([reason, count]) => `${reason}=${String(count)}`)
  .join(' ')
const installable = result.listings.filter((listing) => listing.installable).length
console.log(
  `scan: ${String(result.listings.length)} listings (${String(installable)} installable) `
  + `of ${String(result.scanned)} scanned${skipped === '' ? '' : ` | skipped: ${skipped}`}`,
)
