#!/usr/bin/env node

const { spawn } = require('node:child_process')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const tar = require('tar')

const PROJECT_ROOT = resolve(__dirname, '..')
const TARGETS = Object.freeze({
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', suffix: '' },
  'darwin-x64': { platform: 'darwin', arch: 'x64', suffix: '' },
  'win32-x64': { platform: 'win32', arch: 'x64', suffix: '.exe' }
})

class MediaVerifyError extends Error {}

class CommandRunner {
  run(executable, args, timeoutMs = 30_000) {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout = []
      const stderr = []
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
      child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
      child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
      child.once('error', rejectPromise)
      child.once('close', (code) => {
        clearTimeout(timer)
        const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
        if (code !== 0) return rejectPromise(new MediaVerifyError(timedOut ? 'Media command timed out' : result.stderr || result.stdout))
        resolvePromise(result)
      })
    })
  }
}

class SyntheticWaveFactory {
  create() {
    const sampleRate = 16_000
    const seconds = 3
    const samples = sampleRate * seconds
    const data = Buffer.alloc(samples * 2)
    for (let index = 0; index < samples; index += 1) {
      const second = index / sampleRate
      const value = second >= 1 && second < 2 ? 0 : Math.round(Math.sin(2 * Math.PI * 440 * second) * 8_000)
      data.writeInt16LE(value, index * 2)
    }
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + data.length, 4)
    header.write('WAVEfmt ', 8)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(data.length, 40)
    return Buffer.concat([header, data])
  }
}

class MediaRuntimeVerifier {
  constructor(artifactPath, targetName) {
    this.artifactPath = resolve(artifactPath)
    this.targetName = targetName
    this.target = TARGETS[targetName]
    if (!this.target) throw new MediaVerifyError(`Unsupported target: ${targetName}`)
    if (process.platform !== this.target.platform || process.arch !== this.target.arch) {
      throw new MediaVerifyError(`Verifier host ${process.platform}-${process.arch} does not match ${targetName}`)
    }
    this.runner = new CommandRunner()
  }

  async verify() {
    const root = await mkdtemp(join(tmpdir(), 'Маркнот media runtime '))
    try {
      await tar.x({ file: this.artifactPath, cwd: root, strict: true, preservePaths: false })
      const payload = join(root, 'media-runtime')
      const buildInfo = JSON.parse(await readFile(join(payload, 'metadata', 'build-info.json'), 'utf8'))
      this.verifyBuildInfo(buildInfo)
      const ffmpeg = join(payload, buildInfo.layout.ffmpegExecutable)
      const ffprobe = join(payload, buildInfo.layout.ffprobeExecutable)
      const configuration = await this.runner.run(ffmpeg, ['-hide_banner', '-buildconf'])
      const configurationText = `${configuration.stdout}\n${configuration.stderr}`
      if (!configurationText.includes('--disable-gpl') || !configurationText.includes('--disable-nonfree') ||
          configurationText.includes('--enable-gpl') || configurationText.includes('--enable-nonfree')) {
        throw new MediaVerifyError('Runtime configuration is not approved LGPL-only')
      }
      const fixtureDirectory = join(root, 'синтетические fixtures')
      await require('node:fs/promises').mkdir(fixtureDirectory)
      const wav = join(fixtureDirectory, 'tone silence.wav')
      await writeFile(wav, new SyntheticWaveFactory().create())
      const mp3 = join(fixtureDirectory, 'tone.mp3')
      const mp3Base64 = (await readFile(join(PROJECT_ROOT, 'tests', 'fixtures', 'audio', 'synthetic-tone.mp3.base64'), 'utf8')).trim()
      await writeFile(mp3, Buffer.from(mp3Base64, 'base64'))
      const generated = await this.generateFormats(ffmpeg, wav, fixtureDirectory)
      const probes = []
      for (const input of [wav, mp3, ...generated]) probes.push(await this.probeAndExtract(ffmpeg, ffprobe, input, fixtureDirectory))
      const silence = await this.runner.run(ffmpeg, ['-hide_banner', '-nostdin', '-i', wav, '-af', 'silencedetect=n=-50dB:d=0.2', '-f', 'null', '-'])
      const silenceOutput = `${silence.stdout}\n${silence.stderr}`
      if (!silenceOutput.includes('silence_start') || !silenceOutput.includes('silence_end')) {
        throw new MediaVerifyError('Silence detection did not report a complete interval')
      }
      return { target: this.targetName, artifact: this.artifactPath, formats: probes.map((item) => item.format), silenceDetected: true }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  verifyBuildInfo(info) {
    if (info.schemaVersion !== 1 || info.artifactKind !== 'marknot-media-runtime' || info.ffmpegVersion !== '9.0.1' ||
        info.licenseProfile !== 'LGPL-2.1-or-later' || info.gplEnabled !== false || info.nonfreeEnabled !== false ||
        info.target?.platform !== this.target.platform || info.target?.arch !== this.target.arch ||
        info.unsignedEngineeringArtifact !== true || info.productionReady !== false) {
      throw new MediaVerifyError('Media runtime build metadata is incompatible')
    }
  }

  async generateFormats(ffmpeg, wav, directory) {
    const requests = [
      ['m4a', ['-c:a', 'aac', '-b:a', '32k']],
      ['aac', ['-c:a', 'aac', '-b:a', '32k', '-f', 'adts']],
      ['flac', ['-c:a', 'flac']],
      ['ogg', ['-c:a', 'flac', '-f', 'ogg']],
      ['webm', ['-ac', '2', '-c:a', 'vorbis', '-strict', 'experimental', '-f', 'webm']]
    ]
    const paths = []
    for (const [extension, args] of requests) {
      const output = join(directory, `generated.${extension}`)
      await this.runner.run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', wav, ...args, output])
      paths.push(output)
    }
    return paths
  }

  async probeAndExtract(ffmpeg, ffprobe, input, directory) {
    const probe = await this.runner.run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', input])
    const metadata = JSON.parse(probe.stdout)
    const duration = Number(metadata.format?.duration)
    if (!Number.isFinite(duration) || duration <= 0) throw new MediaVerifyError('Probe returned an invalid duration')
    const format = input.split('.').at(-1)
    const output = join(directory, `extract-${format}.wav`)
    await this.runner.run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', '0', '-t', '0.2', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output])
    return { format, duration }
  }
}

async function main() {
  const artifactPath = process.argv[2]
  const targetName = process.argv[3]
  if (!artifactPath || !targetName) throw new MediaVerifyError('Usage: verify_media_runtime.cjs <archive> <target>')
  console.log(JSON.stringify(await new MediaRuntimeVerifier(artifactPath, targetName).verify(), null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
