import { readFileSync } from 'node:fs'
import { catalogSnapshotSchema, SNAPSHOT_PATH } from './snapshot.js'

// Gate for the committed snapshot: it is the repository's only real output, and
// a malformed one breaks catalog ingestion everywhere downstream. CI runs this
// on every change, including changes made by hand.

const snapshot = catalogSnapshotSchema.parse(JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')))

const ids = new Set<string>()
for (const listing of snapshot.listings) {
  if (ids.has(listing.id)) throw new Error(`duplicate listing id: ${listing.id}`)
  ids.add(listing.id)
}

const installable = snapshot.listings.filter((listing) => listing.installable)
// Installability is a promise the desktop keeps by re-checking the hash before
// it installs. A listing that claims it without one cannot be verified, so it
// must never reach the catalog in the first place.
const unpinned = installable.filter((listing) => listing.integrity === null)
if (unpinned.length > 0) {
  throw new Error(`installable listings without integrity: ${unpinned.map((l) => l.id).join(', ')}`)
}

console.log(
  `catalog.json ok: ${String(snapshot.listings.length)} listings, `
  + `${String(installable.length)} installable, generated ${snapshot.generatedAt}`,
)
