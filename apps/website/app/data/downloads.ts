import release from './releases.json'

export type Download = {
  platform: string
  architecture: string
  url: string
  sha256: string
}

// Only published artifacts with HTTPS URLs and checksums become download links.
export const downloads = (release.downloads as Download[]).filter(
  (item) => /^https:\/\//.test(item.url) && /^[a-f\d]{64}$/i.test(item.sha256),
)
export { release }
