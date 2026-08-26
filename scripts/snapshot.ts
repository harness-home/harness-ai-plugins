import { marketListingSchema } from '@harness-ai/contracts'
import { z } from 'zod'

// The shape of catalog.json, derived from the published listing contract so
// the two ends cannot drift: this repository produces it, harness-ai-server
// validates it on ingestion with the same derivation.
//
// Three fields are removed rather than filled in, because a scanner has no
// business asserting them:
//   - `preset`      belongs to listings that ship with the desktop.
//   - `reviewStatus` is a moderation decision the server owns and ingestion
//                    must never overwrite.
//   - `updatedAt`   is the database row's own timestamp.

export const snapshotListingSchema = marketListingSchema.omit({
  preset: true,
  reviewStatus: true,
  updatedAt: true,
})
export type SnapshotListing = z.infer<typeof snapshotListingSchema>

export const catalogSnapshotSchema = z.object({
  /** Snapshot format; bumped when a consumer would have to change to read it. */
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  source: z.object({
    registry: z.string().url(),
    keyword: z.string().min(1),
  }),
  /** How many candidates the scan saw, and why entries were left out. */
  scan: z.object({
    scanned: z.number().int().nonnegative(),
    skipped: z.record(z.string(), z.number().int().nonnegative()),
  }),
  listings: z.array(snapshotListingSchema),
})
export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>

/** Where the snapshot lives in this repository. */
export const SNAPSHOT_PATH = 'catalog.json'
