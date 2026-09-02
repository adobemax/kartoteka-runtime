#!/usr/bin/env node

const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { access, copyFile, mkdir, readFile, stat, writeFile } = require('node:fs/promises')
const { basename, join, resolve } = require('node:path')

const RUNTIME_VERSION = '1.0.0-rc.1'
const FFMPEG_VERSION = '9.0.1'
const RELEASE_TAG = `media-runtime-v${RUNTIME_VERSION}`
const REPOSITORY = 'adobemax/kartoteka-runtime'
const TARGETS = Object.freeze([
  { name: 'darwin-arm64', platform: 'darwin', arch: 'arm64' },
  { name: 'darwin-x64', platform: 'darwin', arch: 'x64' },
  { name: 'win32-x64', platform: 'win32', arch: 'x64' }
])

class ReleaseAssemblyError extends Error {}

class FileHasher {
  async sha256(path) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  }
}

class MediaRuntimeReleaseAssembler {
  constructor(inputDirectory, outputDirectory) {
    this.inputDirectory = resolve(inputDirectory)
    this.outputDirectory = resolve(outputDirectory)
    this.hasher = new FileHasher()
  }

  async assemble() {
    await mkdir(this.outputDirectory, { recursive: true })
    const runtimes = []
    for (const target of TARGETS) runtimes.push(await this.collectRuntime(target))
    const sourceAssets = await this.copySourceEvidence()
    const manifest = {
      schemaVersion: 1,
      manifestVersion: RUNTIME_VERSION,
      artifactModel: 'ffmpeg-media-runtime',
      unsignedEngineeringArtifact: true,
      productionReady: false,
      ffmpegVersion: FFMPEG_VERSION,
      licenseProfile: 'LGPL-2.1-or-later',
      source: {
        url: `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`,
        sha256: 'cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635',
        assets: sourceAssets
      },
      runtimes
    }
    const manifestName = `media-runtime-manifest-${RUNTIME_VERSION}.json`
    const manifestPath = join(this.outputDirectory, manifestName)
    await this.assertMissing(manifestPath)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    const releaseFiles = [...runtimes.map((runtime) => runtime.archive.name), ...sourceAssets.map((asset) => asset.name), manifestName]
    const sums = []
    for (const name of releaseFiles) sums.push(`${await this.hasher.sha256(join(this.outputDirectory, name))}  ${name}`)
    const sumsPath = join(this.outputDirectory, 'SHA256SUMS.txt')
    await this.assertMissing(sumsPath)
    await writeFile(sumsPath, `${sums.join('\n')}\n`)
    return { releaseTag: RELEASE_TAG, manifest: manifestPath, files: [...releaseFiles, basename(sumsPath)] }
  }

  async collectRuntime(target) {
    const metadataName = `media-runtime-${target.name}.metadata.json`
    const metadataPath = await this.findUnique(metadataName)
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    if (metadata.schemaVersion !== 1 || metadata.artifactKind !== 'marknot-media-runtime' ||
        metadata.runtimeVersion !== RUNTIME_VERSION || metadata.ffmpegVersion !== FFMPEG_VERSION ||
        metadata.licenseProfile !== 'LGPL-2.1-or-later' || metadata.gplEnabled !== false ||
        metadata.nonfreeEnabled !== false || metadata.target?.platform !== target.platform ||
        metadata.target?.arch !== target.arch || metadata.unsignedEngineeringArtifact !== true ||
        metadata.productionReady !== false) {
      throw new ReleaseAssemblyError(`Invalid build metadata for ${target.name}`)
    }
    const archivePath = await this.findUnique(metadata.archive?.name)
    const actualSize = (await stat(archivePath)).size
    const actualSha256 = await this.hasher.sha256(archivePath)
    if (metadata.archive.size !== actualSize || metadata.archive.sha256 !== actualSha256) {
      throw new ReleaseAssemblyError(`Archive evidence does not match for ${target.name}`)
    }
    const destination = join(this.outputDirectory, metadata.archive.name)
    await this.assertMissing(destination)
    await copyFile(archivePath, destination)
    return Object.freeze({
      id: `media-runtime-${RUNTIME_VERSION}-${target.name}`,
      platform: target.platform,
      arch: target.arch,
      layout: metadata.layout,
      buildConfiguration: metadata.buildConfiguration,
      archive: {
        name: metadata.archive.name,
        format: 'tar.gz',
        url: `https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}/${metadata.archive.name}`,
        size: actualSize,
        sha256: actualSha256
      }
    })
  }

  async copySourceEvidence() {
    const names = [`ffmpeg-${FFMPEG_VERSION}.tar.xz`, `ffmpeg-${FFMPEG_VERSION}.tar.xz.asc`, 'ffmpeg-devel.asc']
    const assets = []
    for (const name of names) {
      const source = await this.findUnique(name)
      const destination = join(this.outputDirectory, name)
      await this.assertMissing(destination)
      await copyFile(source, destination)
      assets.push(Object.freeze({ name, size: (await stat(destination)).size, sha256: await this.hasher.sha256(destination) }))
    }
    return Object.freeze(assets)
  }

  async findUnique(name) {
    if (typeof name !== 'string' || name.length === 0 || basename(name) !== name) {
      throw new ReleaseAssemblyError('Release input name is invalid')
    }
    const direct = join(this.inputDirectory, name)
    try {
      await access(direct)
      return direct
    } catch {
      const { readdir } = require('node:fs/promises')
      const entries = await readdir(this.inputDirectory, { recursive: true, withFileTypes: true })
      const matches = entries.filter((entry) => entry.isFile() && entry.name === name)
        .map((entry) => join(entry.parentPath, entry.name))
      if (matches.length !== 1) throw new ReleaseAssemblyError(`Expected exactly one ${name}, found ${matches.length}`)
      return matches[0]
    }
  }

  async assertMissing(path) {
    await access(path).then(
      () => { throw new ReleaseAssemblyError(`Refusing to overwrite ${path}`) },
      () => undefined
    )
  }
}

async function main() {
  const input = process.argv[2]
  const output = process.argv[3]
  if (!input || !output) throw new ReleaseAssemblyError('Usage: assemble_media_runtime_release.cjs <input-directory> <output-directory>')
  console.log(JSON.stringify(await new MediaRuntimeReleaseAssembler(input, output).assemble(), null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
