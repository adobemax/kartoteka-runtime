#!/usr/bin/env node

const { spawn } = require('node:child_process')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { delimiter, join, resolve } = require('node:path')
const tar = require('tar')

const PROJECT_ROOT = resolve(__dirname, '..')
const EXPECTED_PYTHON_VERSION = '3.12.13'
const EXPECTED_MARKITDOWN_VERSION = '0.1.6'
const MAX_CAPTURE_BYTES = 1024 * 1024
const EXPECTED_MACHINES = Object.freeze({
  'darwin-arm64': 'arm64',
  'darwin-x64': 'x86_64',
  'win32-x64': 'AMD64'
})
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

class VerifyError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'VerifyError'
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

      child.stdout.on('data', (chunk) => stdout.append(chunk))
      child.stderr.on('data', (chunk) => stderr.append(chunk))
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
      throw new VerifyError(`${label} ${status}`, {
        cause: new Error(result.stderr || result.stdout || `signal ${result.signal ?? 'none'}`)
      })
    }
    return result
  }
}

class RuntimeArtifactVerifier {
  constructor(artifactPath) {
    this.artifactPath = resolve(artifactPath)
    this.runner = new CommandRunner()
  }

  async verify() {
    const root = await mkdtemp(join(tmpdir(), 'kartoteka-runtime-verify-'))
    try {
      await tar.x({ file: this.artifactPath, cwd: root, strict: true })
      const buildInfo = JSON.parse(await readFile(join(root, 'metadata', 'build-info.json'), 'utf8'))
      const expectedMachine = this.verifyBuildInfo(buildInfo)
      const python = join(root, buildInfo.layout.pythonExecutable.replace(/^runtime\//, 'runtime/'))
      const pythonPath = buildInfo.layout.pythonPathEntries
        .map((entry) => join(root, entry))
        .join(delimiter)
      const env = { ...process.env, PYTHONPATH: pythonPath }
      const version = await this.verifyVersions(python, env, expectedMachine)
      const fixtures = await this.verifyFixtures(python, env)
      const worker = await this.verifyWorker(python, env)
      return {
        artifact: this.artifactPath,
        target: buildInfo.target,
        unsignedEngineeringArtifact: buildInfo.unsignedEngineeringArtifact,
        productionReady: buildInfo.productionReady,
        version,
        fixtures,
        worker
      }
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  verifyBuildInfo(buildInfo) {
    const targetName = `${buildInfo.target?.platform}-${buildInfo.target?.arch}`
    const expectedMachine = EXPECTED_MACHINES[targetName]
    if (
      buildInfo.artifactKind !== 'markitdown-full-runtime-bundle' ||
      buildInfo.unsignedEngineeringArtifact !== true ||
      buildInfo.productionReady !== false ||
      !expectedMachine
    ) {
      throw new VerifyError('Artifact build metadata is incompatible with this unsigned RC verifier')
    }
    return expectedMachine
  }

  async verifyVersions(python, env, expectedMachine) {
    const script = [
      'import importlib.metadata as metadata, json, platform, sys',
      "print(json.dumps({'python': '.'.join(map(str, sys.version_info[:3])), 'markitdown': metadata.version('markitdown'), 'machine': platform.machine()}))"
    ].join('; ')
    const result = await this.runner.checked(
      {
        executable: python,
        args: ['-c', script],
        env,
        timeoutMs: 30_000
      },
      'runtime version check'
    )
    const version = JSON.parse(result.stdout.trim())
    if (
      version.python !== EXPECTED_PYTHON_VERSION ||
      version.markitdown !== EXPECTED_MARKITDOWN_VERSION ||
      version.machine !== expectedMachine
    ) {
      throw new VerifyError(`Unexpected runtime versions: ${JSON.stringify(version)}`)
    }
    return version
  }

  async verifyFixtures(python, env) {
    const smokeScript = [
      'import json',
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
      '    passed = "MARKITDOWN_SPIKE_140" in markdown.replace("\\\\_", "_")',
      '    results.append({"file": path.name, "passed": passed, "markdownBytes": len(markdown.encode("utf-8"))})',
      'print(json.dumps(results, ensure_ascii=False))',
      'raise SystemExit(0 if all(item["passed"] for item in results) else 2)'
    ].join('\n')
    const result = await this.runner.checked(
      {
        executable: python,
        args: ['-c', smokeScript],
        env,
        timeoutMs: 2 * 60_000
      },
      'fixture smoke'
    )
    return JSON.parse(result.stdout.trim())
  }

  async verifyWorker(python, env) {
    const payload = {
      id: 'runtime-verify-smoke',
      command: 'convert',
      filePath: join(PROJECT_ROOT, 'tests', 'fixtures', 'markitdown', 'sample.pdf')
    }
    const workerSmoke = [
      'import json, subprocess, sys',
      `payload = ${JSON.stringify(JSON.stringify(payload) + '\n')}`,
      'process = subprocess.run(',
      '    [sys.executable, "-m", "markitdown_worker"],',
      '    input=payload,',
      '    stdout=subprocess.PIPE,',
      '    stderr=subprocess.PIPE,',
      '    text=True,',
      '    timeout=30,',
      ')',
      'response = json.loads(process.stdout)',
      'print(json.dumps({"exitCode": process.returncode, "ok": response.get("ok"), "markdownBytes": len(response.get("markdown", "").encode("utf-8"))}))',
      'raise SystemExit(0 if process.returncode == 0 and response.get("ok") else 2)'
    ].join('\n')
    const result = await this.runner.checked(
      {
        executable: python,
        args: ['-c', workerSmoke],
        env,
        timeoutMs: 60_000
      },
      'worker smoke'
    )
    return JSON.parse(result.stdout.trim())
  }
}

async function main() {
  const artifactPath =
    process.argv[2] ||
    join(
      PROJECT_ROOT,
      'release',
      'runtime-ci',
      '1.4.0-rc.3',
      'markitdown-runtime-1.4.0-win32-x64.tar.gz'
    )
  const verifier = new RuntimeArtifactVerifier(artifactPath)
  console.log(JSON.stringify(await verifier.verify(), null, 2))
}

main().catch((error) => {
  console.error(error instanceof VerifyError ? error.message : error)
  if (error?.cause) console.error(error.cause.message)
  process.exit(1)
})
