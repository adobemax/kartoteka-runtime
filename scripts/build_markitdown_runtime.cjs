#!/usr/bin/env node

const { createHash, randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const { createReadStream, createWriteStream } = require('node:fs')
const {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} = require('node:fs/promises')
const { get } = require('node:https')
const { tmpdir } = require('node:os')
const { basename, dirname, join, resolve } = require('node:path')
const { pipeline } = require('node:stream/promises')
const tar = require('tar')

const PROJECT_ROOT = resolve(__dirname, '..')
const RUNTIME_VERSION = '1.4.0-windows-ci.1'
const APP_VERSION = '1.4.0'
const MARKITDOWN_VERSION = '0.1.6'
const PYTHON_VERSION = '3.12.13'
const MAX_CAPTURE_BYTES = 1024 * 1024
const CAPABILITIES = Object.freeze(['base', 'pdf', 'docx', 'pptx', 'xls'])
const FIXTURE_EXTENSIONS = Object.freeze([
  '.csv',
  '.docx',
  '.htm',
  '.html',
  '.json',
  '.pdf',
  '.pptx',
  '.txt',
  '.xls',
  '.xml'
])

const TARGETS = Object.freeze({
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    machine: 'AMD64',
    upstream: {
      url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260623/cpython-3.12.13%2B20260623-x86_64-pc-windows-msvc-install_only.tar.gz',
      sha256: 'c6af85bb83d5158c9ff71f50dfad467853d1cd236f932b144e87e26e2ea2a83e',
      size: 46013305
    }
  }
})

class BuildError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'BuildError'
  }
}

class BoundedOutputBuffer {
  constructor(limitBytes) {
    this.limitBytes = limitBytes
    this.buffer = Buffer.alloc(0)
  }

  append(chunk) {
    const combined = Buffer.concat([this.buffer, Buffer.from(chunk)])
    this.buffer = combined.subarray(Math.max(0, combined.length - this.limitBytes))
  }

  toString() {
    return this.buffer.toString('utf8')
  }
}

class CommandRunner {
  run(request) {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stdout = new BoundedOutputBuffer(MAX_CAPTURE_BYTES)
      const stderr = new BoundedOutputBuffer(MAX_CAPTURE_BYTES)
      let timedOut = false
      let killTimer
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      }, request.timeoutMs)

      child.stdout.on('data', (chunk) => {
        const buffer = Buffer.from(chunk)
        stdout.append(buffer)
        if (request.streamOutput) process.stderr.write(buffer)
      })
      child.stderr.on('data', (chunk) => {
        const buffer = Buffer.from(chunk)
        stderr.append(buffer)
        if (request.streamOutput) process.stderr.write(buffer)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        rejectPromise(error)
      })
      child.once('close', (exitCode, signal) => {
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        resolvePromise({
          exitCode,
          signal,
          timedOut,
          stdout: stdout.toString(),
          stderr: stderr.toString()
        })
      })
    })
  }

  async checked(request, label) {
    const result = await this.run(request)
    if (result.exitCode !== 0) {
      const status = result.timedOut
        ? `timed out after ${request.timeoutMs}ms`
        : `failed with exit code ${result.exitCode}`
      throw new BuildError(`${label} ${status}`, {
        cause: new Error(result.stderr || result.stdout || `signal ${result.signal ?? 'none'}`)
      })
    }
    return result
  }
}

class FileHasher {
  async sha256(path) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  }
}

class HttpsDownloader {
  constructor(hasher) {
    this.hasher = hasher
  }

  async downloadAndVerify(source, destination) {
    await mkdir(dirname(destination), { recursive: true })
    const temporary = `${destination}.${randomUUID()}.part`
    try {
      await this.download(source.url, temporary)
      const size = (await stat(temporary)).size
      if (size !== source.size) {
        throw new BuildError(`Downloaded CPython archive size mismatch: ${size} != ${source.size}`)
      }
      const sha256 = await this.hasher.sha256(temporary)
      if (sha256 !== source.sha256) {
        throw new BuildError(`Downloaded CPython archive SHA-256 mismatch: ${sha256}`)
      }
      await rename(temporary, destination)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  download(url, destination) {
    return new Promise((resolvePromise, rejectPromise) => {
      const request = get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume()
          this.download(new URL(response.headers.location, url).toString(), destination)
            .then(resolvePromise)
            .catch(rejectPromise)
          return
        }
        if (response.statusCode !== 200) {
          response.resume()
          rejectPromise(new BuildError(`Download failed with HTTP ${response.statusCode}`))
          return
        }
        pipeline(response, createWriteStream(destination)).then(resolvePromise).catch(rejectPromise)
      })
      request.once('error', rejectPromise)
    })
  }
}

class PythonRuntimeLayout {
  constructor(root) {
    this.root = root
  }

  async findPythonExecutable() {
    const candidates = [
      join(this.root, 'python', 'python.exe'),
      join(this.root, 'python', 'install', 'python.exe'),
      join(this.root, 'install', 'python.exe'),
      join(this.root, 'python.exe'),
      join(this.root, 'python', 'bin', 'python3'),
      join(this.root, 'python', 'bin', 'python3.12'),
      join(this.root, 'python', 'install', 'bin', 'python3'),
      join(this.root, 'python', 'install', 'bin', 'python3.12'),
      join(this.root, 'install', 'bin', 'python3'),
      join(this.root, 'install', 'bin', 'python3.12'),
      join(this.root, 'bin', 'python3'),
      join(this.root, 'bin', 'python3.12')
    ]
    for (const candidate of candidates) {
      try {
        await access(candidate)
        return candidate
      } catch {
        // Try the next known python-build-standalone layout.
      }
    }
    throw new BuildError('Cannot find CPython executable in extracted runtime')
  }

  portablePathFor(executable) {
    const relative = executable.slice(this.root.length + 1)
    return relative.split(require('node:path').sep).join('/')
  }
}

class SitePackagesLocator {
  constructor(runner) {
    this.runner = runner
  }

  async locate(python) {
    const script = [
      'import json, sysconfig',
      'print(json.dumps(sysconfig.get_path("purelib")))'
    ].join('; ')
    const result = await this.runner.checked(
      {
        executable: python,
        args: ['-c', script],
        timeoutMs: 30_000
      },
      'site-packages lookup'
    )
    const sitePackages = JSON.parse(result.stdout.trim())
    const sitePackagesStat = await stat(sitePackages).catch((error) => {
      throw new BuildError(`Resolved site-packages directory does not exist: ${sitePackages}`, {
        cause: error
      })
    })
    if (!sitePackagesStat.isDirectory()) {
      throw new BuildError(`Resolved site-packages path is not a directory: ${sitePackages}`)
    }
    return sitePackages
  }
}

class RuntimeBundleBuilder {
  constructor(targetName) {
    this.targetName = targetName
    this.target = TARGETS[targetName]
    if (!this.target) {
      throw new BuildError(`Unsupported target "${targetName}"`)
    }
    this.runner = new CommandRunner()
    this.hasher = new FileHasher()
    this.downloader = new HttpsDownloader(this.hasher)
    this.sitePackages = new SitePackagesLocator(this.runner)
    this.outputDirectory = join(PROJECT_ROOT, 'release', 'runtime-ci', RUNTIME_VERSION)
    this.artifactName = `markitdown-runtime-${APP_VERSION}-${targetName}.tar.gz`
    this.artifactPath = join(this.outputDirectory, this.artifactName)
    this.metadataPath = join(
      this.outputDirectory,
      `markitdown-runtime-${APP_VERSION}-${targetName}.metadata.json`
    )
    this.checksumsPath = join(this.outputDirectory, 'SHA256SUMS.txt')
  }

  async build() {
    await this.assertOutputDoesNotExist()
    const workRoot = await mkdtemp(join(tmpdir(), `kartoteka-runtime-${this.targetName}-`))
    try {
      const paths = this.createPaths(workRoot)
      await mkdir(this.outputDirectory, { recursive: true })
      this.log('prepare runtime')
      await this.prepareRuntime(paths)
      this.log('verify runtime')
      const pythonExecutable = await this.verifyRuntime(paths)
      this.log('install packages into build venv')
      await this.preparePackages(paths, pythonExecutable)
      this.log('copy worker')
      await this.copyWorker(paths)
      this.log('write dependency inventory')
      const packageInventory = await this.createPackageInventory(paths)
      this.assertPackageInventory(packageInventory)
      this.log('run smoke')
      await this.smokePayload(paths, pythonExecutable)
      this.log('write payload metadata')
      const buildInfo = await this.writePayloadMetadata(paths, pythonExecutable, packageInventory)
      this.log('archive payload')
      await this.archivePayload(paths)
      this.log('describe artifact')
      const artifact = await this.describeArtifact()
      this.log('write artifact metadata')
      await this.writeArtifactMetadata(buildInfo, artifact)
      return { artifact, buildInfo }
    } finally {
      await rm(workRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  createPaths(workRoot) {
    return {
      workRoot,
      upstreamArchive: join(workRoot, basename(new URL(this.target.upstream.url).pathname)),
      upstreamExtract: join(workRoot, 'upstream-runtime'),
      payload: join(workRoot, 'payload'),
      payloadRuntime: join(workRoot, 'payload', 'runtime'),
      payloadPackages: join(workRoot, 'payload', 'packages'),
      payloadWorkerParent: join(workRoot, 'payload', 'worker'),
      payloadMetadata: join(workRoot, 'payload', 'metadata'),
      buildVenv: join(workRoot, 'build-venv')
    }
  }

  async assertOutputDoesNotExist() {
    try {
      await access(this.artifactPath)
      throw new BuildError(`Refusing to overwrite existing artifact: ${this.artifactPath}`)
    } catch (error) {
      if (error instanceof BuildError) throw error
    }
  }

  async prepareRuntime(paths) {
    await this.downloader.downloadAndVerify(this.target.upstream, paths.upstreamArchive)
    await mkdir(paths.upstreamExtract, { recursive: true })
    await tar.x({ file: paths.upstreamArchive, cwd: paths.upstreamExtract, strict: true })
    const layout = new PythonRuntimeLayout(paths.upstreamExtract)
    const upstreamPython = await layout.findPythonExecutable()
    const relative = layout.portablePathFor(upstreamPython)
    const topLevel = relative.split('/')[0]
    await mkdir(paths.payloadRuntime, { recursive: true })
    await cp(join(paths.upstreamExtract, topLevel), join(paths.payloadRuntime, topLevel), {
      recursive: true,
      verbatimSymlinks: true
    })
  }

  async verifyRuntime(paths) {
    const layout = new PythonRuntimeLayout(paths.payloadRuntime)
    const python = await layout.findPythonExecutable()
    const result = await this.runner.checked(
      {
        executable: python,
        args: ['-c', "import platform, sys; print('.'.join(map(str, sys.version_info[:3]))); print(platform.machine())"],
        timeoutMs: 30_000
      },
      'CPython version check'
    )
    const [version, machine] = result.stdout.trim().split(/\r?\n/)
    if (version !== PYTHON_VERSION) {
      throw new BuildError(`Unexpected Python version: ${version}`)
    }
    if (machine !== this.target.machine) {
      throw new BuildError(`Unexpected Python architecture: ${machine}`)
    }
    return python
  }

  async preparePackages(paths, pythonExecutable) {
    await this.runner.checked(
      {
        executable: pythonExecutable,
        args: ['-m', 'venv', paths.buildVenv],
        timeoutMs: 2 * 60_000
      },
      'build venv creation'
    )
    const venvPython = join(paths.buildVenv, 'Scripts', 'python.exe')
    const requirementsDirectory = join(PROJECT_ROOT, 'python', 'requirements')
    await this.runner.checked(
      {
        executable: venvPython,
        args: [
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          '--no-input',
          '--only-binary',
          ':all:',
          '--constraint',
          join(requirementsDirectory, 'constraints.txt'),
          '--requirement',
          join(requirementsDirectory, 'all-capabilities.txt')
        ],
        timeoutMs: 20 * 60_000,
        streamOutput: true
      },
      'Python dependency installation'
    )
    const sitePackages = await this.sitePackages.locate(venvPython)
    await mkdir(paths.payloadPackages, { recursive: true })
    const entries = await readdir(sitePackages)
    for (const entry of entries) {
      await cp(join(sitePackages, entry), join(paths.payloadPackages, entry), {
        recursive: true,
        verbatimSymlinks: true
      })
    }
  }

  async copyWorker(paths) {
    await mkdir(paths.payloadWorkerParent, { recursive: true })
    await cp(join(PROJECT_ROOT, 'markitdown_worker'), join(paths.payloadWorkerParent, 'markitdown_worker'), {
      recursive: true,
      filter: (source) => !source.includes('__pycache__')
    })
  }

  async createPackageInventory(paths) {
    const pythonPath = this.pythonPath(paths)
    const result = await this.runner.checked(
      {
        executable: await new PythonRuntimeLayout(paths.payloadRuntime).findPythonExecutable(),
        args: ['-m', 'pip', 'list', '--format=json'],
        env: { ...process.env, PYTHONPATH: pythonPath },
        timeoutMs: 60_000
      },
      'dependency inventory'
    )
    const packages = JSON.parse(result.stdout)
    await mkdir(paths.payloadMetadata, { recursive: true })
    await writeFile(
      join(paths.payloadMetadata, 'dependency-inventory.json'),
      `${JSON.stringify(packages, null, 2)}\n`
    )
    return packages
  }

  async smokePayload(paths, pythonExecutable) {
    const marker = 'MARKITDOWN_SPIKE_140'
    const smokeScript = [
      'import json, sys',
      'from pathlib import Path',
      'from markitdown import MarkItDown',
      `fixture_dir = Path(${JSON.stringify(join(PROJECT_ROOT, 'tests', 'fixtures', 'markitdown'))})`,
      `extensions = set(${JSON.stringify(FIXTURE_EXTENSIONS)})`,
      'converter = MarkItDown()',
      'results = []',
      'for path in sorted(fixture_dir.iterdir()):',
      '    if path.suffix not in extensions:',
      '        continue',
      '    result = converter.convert_local(path)',
      '    markdown = result.text_content or ""',
      `    passed = ${JSON.stringify(marker)} in markdown.replace("\\\\_", "_")`,
      '    results.append({"file": path.name, "passed": passed, "markdownBytes": len(markdown.encode("utf-8"))})',
      'print(json.dumps(results, ensure_ascii=False))',
      'raise SystemExit(0 if all(item["passed"] for item in results) else 2)'
    ].join('\n')
    await this.runner.checked(
      {
        executable: pythonExecutable,
        args: ['-c', smokeScript],
        env: { ...process.env, PYTHONPATH: this.pythonPath(paths) },
        timeoutMs: 2 * 60_000
      },
      'MarkItDown fixture smoke'
    )

    const workerPayload = {
      id: 'runtime-build-smoke',
      command: 'convert',
      filePath: join(PROJECT_ROOT, 'tests', 'fixtures', 'markitdown', 'sample.pdf')
    }
    const workerSmoke = [
      'import json, subprocess, sys',
      `payload = ${JSON.stringify(JSON.stringify(workerPayload) + '\n')}`,
      `python_path = ${JSON.stringify(this.pythonPath(paths))}`,
      'process = subprocess.run(',
      '    [sys.executable, "-m", "markitdown_worker"],',
      '    input=payload,',
      '    stdout=subprocess.PIPE,',
      '    stderr=subprocess.PIPE,',
      '    text=True,',
      '    timeout=30,',
      '    env={**__import__("os").environ, "PYTHONPATH": python_path},',
      ')',
      'print(process.stdout)',
      'raise SystemExit(0 if process.returncode == 0 and json.loads(process.stdout)["ok"] else 2)'
    ].join('\n')
    await this.runner.checked(
      {
        executable: pythonExecutable,
        args: ['-c', workerSmoke],
        env: { ...process.env, PYTHONPATH: this.pythonPath(paths) },
        timeoutMs: 60_000
      },
      'JSONL worker smoke'
    )
  }

  assertPackageInventory(packages) {
    const markItDown = packages.find(
      (entry) => typeof entry.name === 'string' && entry.name.toLowerCase() === 'markitdown'
    )
    if (markItDown?.version !== MARKITDOWN_VERSION) {
      throw new BuildError(
        `Copied package inventory must contain markitdown ${MARKITDOWN_VERSION}; found ${markItDown?.version ?? 'missing'}`
      )
    }
  }

  async writePayloadMetadata(paths, pythonExecutable, packageInventory) {
    const layout = new PythonRuntimeLayout(paths.payloadRuntime)
    const pythonExecutablePortable = `runtime/${layout.portablePathFor(pythonExecutable)}`
    const buildInfo = {
      artifactKind: 'markitdown-full-runtime-bundle',
      artifactVersion: RUNTIME_VERSION,
      appVersion: APP_VERSION,
      target: {
        platform: this.target.platform,
        arch: this.target.arch
      },
      capabilities: CAPABILITIES,
      unsignedEngineeringArtifact: true,
      productionReady: false,
      generatedAt: new Date().toISOString(),
      pythonVersion: PYTHON_VERSION,
      markitdownVersion: MARKITDOWN_VERSION,
      sourceRuntime: {
        provider: 'astral-sh/python-build-standalone',
        release: '20260623',
        url: this.target.upstream.url,
        size: this.target.upstream.size,
        sha256: this.target.upstream.sha256
      },
      layout: {
        pythonExecutable: pythonExecutablePortable,
        pythonPathEntries: ['packages', 'worker'],
        packageDirectory: 'packages',
        workerModule: 'markitdown_worker'
      },
      packageCount: packageInventory.length
    }
    await mkdir(paths.payloadMetadata, { recursive: true })
    await writeFile(join(paths.payloadMetadata, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`)
    await writeFile(
      join(paths.payloadMetadata, 'UNSIGNED_ENGINEERING_ARTIFACT.txt'),
      [
        'This runtime bundle is an unsigned engineering RC artifact.',
        'It is not production-ready and does not satisfy signing/notarization/Authenticode gates.',
        ''
      ].join('\n')
    )
    await copyFile(
      join(PROJECT_ROOT, 'python', 'requirements', 'constraints.txt'),
      join(paths.payloadMetadata, 'constraints.txt')
    )
    return buildInfo
  }

  async archivePayload(paths) {
    await tar.c(
      {
        cwd: paths.payload,
        file: this.artifactPath,
        gzip: true,
        portable: true,
        strict: true
      },
      ['runtime', 'packages', 'worker', 'metadata']
    )
  }

  async describeArtifact() {
    const artifactSize = (await stat(this.artifactPath)).size
    const artifactSha256 = await this.hasher.sha256(this.artifactPath)
    return {
      name: this.artifactName,
      path: this.artifactPath,
      size: artifactSize,
      sha256: artifactSha256
    }
  }

  async writeArtifactMetadata(buildInfo, artifact) {
    const portableArtifact = {
      name: artifact.name,
      size: artifact.size,
      sha256: artifact.sha256
    }
    await writeFile(
      this.metadataPath,
      `${JSON.stringify({ ...buildInfo, artifact: portableArtifact }, null, 2)}\n`
    )
    await writeFile(this.checksumsPath, `${artifact.sha256}  ${artifact.name}\n`)
  }

  pythonPath(paths) {
    return [paths.payloadPackages, paths.payloadWorkerParent].join(require('node:path').delimiter)
  }

  log(stage) {
    console.error(`[runtime-build:${this.targetName}] ${stage}`)
  }
}

async function main() {
  const target = process.argv[2] || 'win32-x64'
  const builder = new RuntimeBundleBuilder(target)
  const { artifact } = await builder.build()
  console.log(
    JSON.stringify(
      {
        ok: true,
        artifact: {
          name: artifact.name,
          path: artifact.path,
          size: artifact.size,
          sha256: artifact.sha256
        }
      },
      null,
      2
    )
  )
}

main().catch((error) => {
  console.error(error instanceof BuildError ? error.message : error)
  if (error?.cause) console.error(error.cause.message)
  process.exit(1)
})
