#!/usr/bin/env node

const { createHash, randomUUID } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, join, resolve } = require('node:path')
const { spawn } = require('node:child_process')
const tar = require('tar')

const PROJECT_ROOT = resolve(__dirname, '..')
const FFMPEG_VERSION = '9.0.1'
const RUNTIME_VERSION = '1.0.0-rc.1'
const SOURCE_URL = `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`
const SOURCE_SHA256 = 'cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635'
const TARGETS = Object.freeze({
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', executableSuffix: '' },
  'darwin-x64': { platform: 'darwin', arch: 'x64', executableSuffix: '' },
  'win32-x64': { platform: 'win32', arch: 'x64', executableSuffix: '.exe' }
})

class MediaBuildError extends Error {}

class CommandRunner {
  run(executable, args, timeoutMs = 30_000) {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks = []
      let bytes = 0
      let timedOut = false
      const append = (chunk) => {
        chunks.push(Buffer.from(chunk))
        bytes += chunk.length
        while (bytes > 1024 * 1024 && chunks.length > 1) bytes -= chunks.shift().length
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)
      const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
      child.once('error', rejectPromise)
      child.once('close', (code) => {
        clearTimeout(timer)
        const output = Buffer.concat(chunks).toString('utf8')
        if (code !== 0) return rejectPromise(new MediaBuildError(timedOut ? 'Runtime command timed out' : output))
        resolvePromise(output)
      })
    })
  }
}

class FileHasher {
  async sha256(path) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  }
}

class MediaRuntimePackager {
  constructor(targetName, sourceRoot) {
    this.targetName = targetName
    this.target = TARGETS[targetName]
    if (!this.target) throw new MediaBuildError(`Unsupported target: ${targetName}`)
    this.sourceRoot = resolve(sourceRoot)
    this.runner = new CommandRunner()
    this.hasher = new FileHasher()
    this.outputDirectory = join(PROJECT_ROOT, 'release', 'media-runtime-ci', RUNTIME_VERSION)
    this.artifactName = `media-runtime-ffmpeg-${FFMPEG_VERSION}-${targetName}.tar.gz`
    this.artifactPath = join(this.outputDirectory, this.artifactName)
  }

  async package() {
    const suffix = this.target.executableSuffix
    const ffmpeg = join(this.sourceRoot, `ffmpeg${suffix}`)
    const ffprobe = join(this.sourceRoot, `ffprobe${suffix}`)
    await Promise.all([access(ffmpeg), access(ffprobe)])
    const buildConfiguration = await this.runner.run(ffmpeg, ['-hide_banner', '-buildconf'])
    this.assertLgplConfiguration(buildConfiguration)
    const versionOutput = await this.runner.run(ffmpeg, ['-hide_banner', '-version'])
    if (!versionOutput.includes(`ffmpeg version ${FFMPEG_VERSION}`)) {
      throw new MediaBuildError('Unexpected FFmpeg version')
    }
    await mkdir(this.outputDirectory, { recursive: true })
    await access(this.artifactPath).then(
      () => { throw new MediaBuildError(`Refusing to overwrite ${this.artifactPath}`) },
      () => undefined
    )
    const temporaryRoot = await mkdtemp(join(tmpdir(), `marknot-media-package-${this.targetName}-`))
    try {
      const payload = join(temporaryRoot, 'media-runtime')
      const bin = join(payload, 'bin')
      const licenses = join(payload, 'LICENSES')
      const metadata = join(payload, 'metadata')
      await Promise.all([
        mkdir(bin, { recursive: true }),
        mkdir(licenses, { recursive: true }),
        mkdir(metadata, { recursive: true })
      ])
      await Promise.all([
        copyFile(ffmpeg, join(bin, basename(ffmpeg))),
        copyFile(ffprobe, join(bin, basename(ffprobe))),
        copyFile(join(this.sourceRoot, 'COPYING.LGPLv2.1'), join(licenses, 'COPYING.LGPLv2.1')),
        copyFile(join(this.sourceRoot, 'COPYING.LGPLv3'), join(licenses, 'COPYING.LGPLv3')),
        copyFile(join(this.sourceRoot, 'LICENSE.md'), join(licenses, 'FFMPEG_LICENSE.md'))
      ])
      if (this.target.platform !== 'win32') {
        await Promise.all([chmod(join(bin, 'ffmpeg'), 0o755), chmod(join(bin, 'ffprobe'), 0o755)])
      }
      const buildInfo = {
        schemaVersion: 1,
        artifactKind: 'marknot-media-runtime',
        runtimeVersion: RUNTIME_VERSION,
        ffmpegVersion: FFMPEG_VERSION,
        licenseProfile: 'LGPL-2.1-or-later',
        gplEnabled: false,
        nonfreeEnabled: false,
        target: { platform: this.target.platform, arch: this.target.arch },
        layout: {
          ffmpegExecutable: `bin/ffmpeg${suffix}`,
          ffprobeExecutable: `bin/ffprobe${suffix}`
        },
        source: { url: SOURCE_URL, sha256: SOURCE_SHA256 },
        buildConfiguration: buildConfiguration.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        unsignedEngineeringArtifact: true,
        productionReady: false
      }
      await writeFile(join(metadata, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`, { mode: 0o600 })
      await tar.c({ cwd: temporaryRoot, file: this.artifactPath, gzip: true, portable: true, noMtime: true }, ['media-runtime'])
      const artifact = {
        name: this.artifactName,
        size: (await stat(this.artifactPath)).size,
        sha256: await this.hasher.sha256(this.artifactPath)
      }
      await writeFile(
        join(this.outputDirectory, `media-runtime-${this.targetName}.metadata.json`),
        `${JSON.stringify({ ...buildInfo, archive: artifact }, null, 2)}\n`,
        { mode: 0o600 }
      )
      await writeFile(join(this.outputDirectory, `SHA256SUMS.${this.targetName}.txt`), `${artifact.sha256}  ${artifact.name}\n`)
      return { artifact, buildInfo }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  assertLgplConfiguration(output) {
    if (!output.includes('--disable-gpl') || !output.includes('--disable-nonfree') ||
        output.includes('--enable-gpl') || output.includes('--enable-nonfree')) {
      throw new MediaBuildError('FFmpeg build is not the approved LGPL/nonfree-disabled configuration')
    }
  }
}

async function main() {
  const packager = new MediaRuntimePackager(process.argv[2], process.argv[3])
  console.log(JSON.stringify(await packager.package(), null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
