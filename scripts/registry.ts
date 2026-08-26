import type { MarketCategory, MarketRiskFlag } from '@harness-ai/contracts'
import type { SnapshotListing } from './snapshot.js'

// Catalog scanning: read the public registry for community dsh plugins, verify
// each candidate against its own package manifest, and normalize the survivors.
//
// This used to run inside harness-ai-server, on a schedule. It does not belong
// there: one pass fetches a manifest per candidate — roughly 1500 requests —
// and a Cloudflare Worker is capped far below that per invocation, so the
// server's ingestion silently reached about 3% of the registry and reported
// success. Here it runs on a normal machine with no such ceiling, and the
// server reads the one file this produces.
//
// What "installable" means is narrow and honest (ledger #21/#22): the manifest
// declares `dsh.bundle.patch`, so the package is a real profile layer the
// install path can add. It is NOT a security review — a listing carries the
// registry's own metadata and nothing more. Packages without that field are
// still listed (people search for them) but marked non-installable, and the
// desktop refuses to install those.

/** The only registry host scanning may talk to. */
export const REGISTRY_URL = 'https://registry.npmjs.org'

/** Registry keyword the community publishes plugins under. */
export const KEYWORD = 'dsh-plugin'

/** Hard bounds so one run cannot hang or flood the catalog. */
const PAGE_SIZE = 250
const MAX_CANDIDATES = 1500
const REQUEST_TIMEOUT_MS = 20_000
const MANIFEST_CONCURRENCY = 8

/** Packages that must never enter the catalog (our own, and known non-plugins). */
const BLOCKLIST = new Set(['dshmarket'])

export interface SearchObject {
  package: {
    name: string
    version: string
    description?: string
    keywords?: string[]
    date?: string
    links?: { homepage?: string; repository?: string; npm?: string }
    publisher?: { username?: string }
  }
  downloads?: { weekly?: number }
}

interface PackumentVersion {
  name: string
  version: string
  description?: string
  keywords?: string[]
  license?: string | { type?: string }
  homepage?: string
  repository?: string | { url?: string }
  author?: string | { name?: string }
  deprecated?: string
  scripts?: Record<string, string>
  gypfile?: boolean
  dist?: { integrity?: string; shasum?: string; attestations?: { url?: string } }
  dsh?: { bundle?: { patch?: string } }
}

interface Packument {
  'dist-tags'?: { latest?: string }
  versions?: Record<string, PackumentVersion>
  time?: Record<string, string>
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${url} returned ${String(response.status)}`)
  return (await response.json()) as T
}

/** Map registry keywords onto our category vocabulary; unknown lands in `other`. */
export function categoryFor(keywords: readonly string[], description: string): MarketCategory {
  const haystack = `${keywords.join(' ')} ${description}`.toLowerCase()
  const rules: [MarketCategory, RegExp][] = [
    ['agent', /\bagent|subagent|persona|team\b/],
    ['ui', /\bui|theme|sidebar|render|widget|frontend\b/],
    ['model', /\bmodel|llm|provider|openai|anthropic|gemini|claude\b/],
    ['integration', /\bintegration|sync|github|gitlab|slack|notion|jira|mcp\b/],
    ['tool', /\btool|command|shell|search|memory|file|test|lint\b/],
  ]
  for (const [category, pattern] of rules) {
    if (pattern.test(haystack)) return category
  }
  return 'other'
}

/**
 * Lifecycle scripts that actually run when a registry tarball is installed.
 * `prepare`/`prepublishOnly` are deliberately absent: they run for git and
 * publish flows, not for a published tarball, so flagging them would cry wolf
 * over every TypeScript package.
 */
const INSTALL_SCRIPT_HOOKS = ['preinstall', 'install', 'postinstall'] as const

/** Below this many weekly downloads a package has had little community exposure. */
const LOW_ADOPTION_DOWNLOADS = 50

/** Younger than this and there is no track record to speak of. */
const NEW_PACKAGE_DAYS = 30

/** Registry-derived observations about one version. Never a verdict. */
export function riskFlagsFor(input: {
  scripts?: Record<string, string>
  gypfile?: boolean
  hasAttestation: boolean
  license: string | null
  downloads: number | null
  publishedAt: Date | null
  now?: Date
}): MarketRiskFlag[] {
  const flags: MarketRiskFlag[] = []
  const scripts = input.scripts ?? {}
  if (INSTALL_SCRIPT_HOOKS.some((hook) => typeof scripts[hook] === 'string')) flags.push('install-scripts')
  if (input.gypfile === true || typeof scripts['rebuild'] === 'string') flags.push('native-build')
  if (!input.hasAttestation) flags.push('no-provenance')
  if (input.license === null) flags.push('no-license')
  if (input.downloads !== null && input.downloads < LOW_ADOPTION_DOWNLOADS) flags.push('low-adoption')
  if (input.publishedAt !== null) {
    const ageDays = ((input.now ?? new Date()).getTime() - input.publishedAt.getTime()) / 86_400_000
    if (ageDays < NEW_PACKAGE_DAYS) flags.push('new-package')
  }
  return flags
}

function firstString(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/** Only https links are stored; a git+ssh repository URL is normalized or dropped. */
function normalizeHomepage(manifest: PackumentVersion, packageName: string): string {
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  const candidate = firstString(manifest.homepage, repository)
  if (candidate !== null) {
    const cleaned = candidate.replace(/^git\+/, '').replace(/\.git$/, '')
    if (cleaned.startsWith('https://')) return cleaned
  }
  return `https://www.npmjs.com/package/${packageName}`
}

function authorOf(manifest: PackumentVersion, fallback: string | undefined): string | null {
  const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name
  return firstString(author, fallback)
}

function licenseOf(manifest: PackumentVersion): string | null {
  return firstString(typeof manifest.license === 'string' ? manifest.license : manifest.license?.type)
}

/** Run `worker` over `items` with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await worker(items[index] as T)
    }
  })
  await Promise.all(runners)
  return results
}

/** Scan the registry search index for candidate packages. */
export async function scanCandidates(): Promise<SearchObject[]> {
  const candidates: SearchObject[] = []
  for (let from = 0; from < MAX_CANDIDATES; from += PAGE_SIZE) {
    const url = `${REGISTRY_URL}/-/v1/search?text=${encodeURIComponent(`keywords:${KEYWORD}`)}`
      + `&size=${String(PAGE_SIZE)}&from=${String(from)}`
    const page = await fetchJson<{ objects?: SearchObject[]; total?: number }>(url)
    const objects = page.objects ?? []
    candidates.push(...objects)
    if (objects.length < PAGE_SIZE || candidates.length >= (page.total ?? 0)) break
  }
  return candidates
}

/** Fetch and verify one candidate's manifest; returns null when it must be skipped. */
export async function verifyCandidate(
  candidate: SearchObject,
  skipped: Record<string, number>,
): Promise<SnapshotListing | null> {
  const packageName = candidate.package.name
  const bump = (reason: string): null => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
    return null
  }
  if (BLOCKLIST.has(packageName)) return bump('blocked')
  if (packageName.startsWith('@deepseek-ai/') || packageName.startsWith('@harness-ai/')) return bump('first-party')

  let packument: Packument
  try {
    packument = await fetchJson<Packument>(`${REGISTRY_URL}/${encodeURIComponent(packageName).replace('%40', '@')}`)
  } catch {
    return bump('manifest-unreachable')
  }
  const latest = packument['dist-tags']?.latest
  const manifest = latest === undefined ? undefined : packument.versions?.[latest]
  if (manifest === undefined || latest === undefined) return bump('no-latest-version')
  if (manifest.deprecated !== undefined) return bump('deprecated')

  const description = firstString(manifest.description, candidate.package.description) ?? ''
  const keywords = manifest.keywords ?? candidate.package.keywords ?? []
  const license = licenseOf(manifest)
  const downloads = candidate.downloads?.weekly ?? null
  const publishedRaw = packument.time?.[latest]
  const parsed = publishedRaw === undefined ? null : new Date(publishedRaw)
  const publishedAt = parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed : null
  const riskFlags = riskFlagsFor({
    ...(manifest.scripts === undefined ? {} : { scripts: manifest.scripts }),
    ...(manifest.gypfile === undefined ? {} : { gypfile: manifest.gypfile }),
    hasAttestation: typeof manifest.dist?.attestations?.url === 'string',
    license,
    downloads,
    publishedAt,
  })
  // Installable means the install path can actually carry it: a real profile
  // layer, pinned by an integrity hash we can re-check, and not dependent on
  // install-time scripts we refuse to run.
  const installable = typeof manifest.dsh?.bundle?.patch === 'string'
    && typeof manifest.dist?.integrity === 'string'
    && !riskFlags.includes('install-scripts')

  return {
    id: `npm:${packageName}`,
    name: packageName.replace(/^@[^/]+\//, '').replace(/^dsh-plugin-/, '') || packageName,
    packageName,
    version: latest,
    description: description.slice(0, 2000),
    category: categoryFor(keywords, description),
    author: authorOf(manifest, candidate.package.publisher?.username),
    homepage: normalizeHomepage(manifest, packageName),
    source: 'npm',
    installable,
    license,
    downloads,
    integrity: manifest.dist?.integrity ?? null,
    publishedAt: publishedAt === null ? null : publishedAt.toISOString(),
    riskFlags,
  }
}

export interface ScanResult {
  listings: SnapshotListing[]
  scanned: number
  skipped: Record<string, number>
}

/** One full pass: search, verify every candidate, return what survived. */
export async function scanRegistry(): Promise<ScanResult> {
  const skipped: Record<string, number> = {}
  const candidates = await scanCandidates()
  const verified = await mapLimit(candidates, MANIFEST_CONCURRENCY, (candidate) =>
    verifyCandidate(candidate, skipped))
  const listings = verified.filter((entry): entry is SnapshotListing => entry !== null)
  // Stable order, so a snapshot with no real changes produces no diff.
  listings.sort((left, right) => left.id.localeCompare(right.id))
  return { listings, scanned: candidates.length, skipped }
}
