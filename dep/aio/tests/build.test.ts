import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { join } from '@std/path'
import { slugify, copyDir, writePlaceholderIcon } from '../src/build-helpers.ts'

const buildScript = join(import.meta.dirname ?? '.', '..', 'src', 'build.ts')

/** Run build.ts with given args in a given cwd, return exit code + combined output */
async function runBuild(args: string[], cwd?: string): Promise<{ code: number; stderr: string; stdout: string }> {
  const result = await new Deno.Command('deno', {
    args: ['run', '-A', buildScript, ...args],
    stdout: 'piped',
    stderr: 'piped',
    cwd,
  }).output()
  const dec = new TextDecoder()
  return { code: result.code, stderr: dec.decode(result.stderr), stdout: dec.decode(result.stdout) }
}

// ── slugify ──────────────────────────────────────────────

Deno.test('slugify: basic title', () => {
  assertEquals(slugify('My Cool App'), 'my-cool-app')
})

Deno.test('slugify: special characters stripped', () => {
  assertEquals(slugify('App@2.0! (beta)'), 'app-2-0-beta')
})

Deno.test('slugify: leading/trailing dashes removed', () => {
  assertEquals(slugify('--test--'), 'test')
})

Deno.test('slugify: empty string → myapp', () => {
  assertEquals(slugify(''), 'myapp')
})

Deno.test('slugify: only special chars → myapp', () => {
  assertEquals(slugify('!!!'), 'myapp')
})

Deno.test('slugify: already slugified passes through', () => {
  assertEquals(slugify('my-app'), 'my-app')
})

// ── writePlaceholderIcon ────────────────────────────────

Deno.test('writePlaceholderIcon: valid SVG with uppercase letter', async () => {
  const tmp = await Deno.makeTempFile({ suffix: '.svg' })
  try {
    await writePlaceholderIcon(tmp, 'myapp')
    const svg = await Deno.readTextFile(tmp)
    assertEquals(svg.includes('<svg'), true)
    assertEquals(svg.includes('xmlns="http://www.w3.org/2000/svg"'), true)
    assertEquals(svg.includes('>M<'), true) // first letter uppercase
  } finally {
    await Deno.remove(tmp)
  }
})

Deno.test('writePlaceholderIcon: empty label → A', async () => {
  const tmp = await Deno.makeTempFile({ suffix: '.svg' })
  try {
    await writePlaceholderIcon(tmp, '')
    const svg = await Deno.readTextFile(tmp)
    assertEquals(svg.includes('>A<'), true)
  } finally {
    await Deno.remove(tmp)
  }
})

Deno.test('writePlaceholderIcon: lowercase label gets uppercased', async () => {
  const tmp = await Deno.makeTempFile({ suffix: '.svg' })
  try {
    await writePlaceholderIcon(tmp, 'dashboard')
    const svg = await Deno.readTextFile(tmp)
    assertEquals(svg.includes('>D<'), true)
  } finally {
    await Deno.remove(tmp)
  }
})

// ── copyDir ─────────────────────────────────────────────

Deno.test('copyDir: copies files and subdirectories', async () => {
  const src = await Deno.makeTempDir()
  const dst = await Deno.makeTempDir()
  const dstTarget = join(dst, 'out')
  try {
    await Deno.writeTextFile(join(src, 'a.txt'), 'hello')
    await Deno.mkdir(join(src, 'sub'))
    await Deno.writeTextFile(join(src, 'sub', 'b.txt'), 'world')

    await copyDir(src, dstTarget)

    assertEquals(await Deno.readTextFile(join(dstTarget, 'a.txt')), 'hello')
    assertEquals(await Deno.readTextFile(join(dstTarget, 'sub', 'b.txt')), 'world')
  } finally {
    await Deno.remove(src, { recursive: true })
    await Deno.remove(dst, { recursive: true })
  }
})

Deno.test('copyDir: preserves symlinks', async () => {
  const src = await Deno.makeTempDir()
  const dst = await Deno.makeTempDir()
  const dstTarget = join(dst, 'out')
  try {
    await Deno.writeTextFile(join(src, 'real.txt'), 'data')
    await Deno.symlink('real.txt', join(src, 'link.txt'))

    await copyDir(src, dstTarget)

    const target = await Deno.readLink(join(dstTarget, 'link.txt'))
    assertEquals(target, 'real.txt')
  } finally {
    await Deno.remove(src, { recursive: true })
    await Deno.remove(dst, { recursive: true })
  }
})

Deno.test('copyDir: preserves executable bit', async () => {
  const src = await Deno.makeTempDir()
  const dst = await Deno.makeTempDir()
  const dstTarget = join(dst, 'out')
  try {
    await Deno.writeTextFile(join(src, 'run.sh'), '#!/bin/bash\necho hi')
    await Deno.chmod(join(src, 'run.sh'), 0o755)

    await copyDir(src, dstTarget)

    const info = await Deno.stat(join(dstTarget, 'run.sh'))
    assertEquals((info.mode! & 0o111) !== 0, true)
  } finally {
    await Deno.remove(src, { recursive: true })
    await Deno.remove(dst, { recursive: true })
  }
})

// ── Conflicting flags ────────────────────────────────────

Deno.test('build: --cli + --android rejects with error', async () => {
  const { code, stderr } = await runBuild(['--cli', '--android'])
  assertEquals(code, 1)
  assertEquals(stderr.includes('conflicting flags'), true)
})

Deno.test('build: --electron + --cli rejects with error', async () => {
  const { code, stderr } = await runBuild(['--electron', '--cli'])
  assertEquals(code, 1)
  assertEquals(stderr.includes('conflicting flags'), true)
})

Deno.test('build: --client + --android rejects with error', async () => {
  const { code, stderr } = await runBuild(['--client', '--android'])
  assertEquals(code, 1)
  assertEquals(stderr.includes('conflicting flags'), true)
})

Deno.test('build: single flag does not reject', async () => {
  // --cli without src/app.ts will fail later, but NOT from flag validation
  const { stderr } = await runBuild(['--cli'])
  assertEquals(stderr.includes('conflicting flags'), false)
})

Deno.test('build: --service + --compile does not conflict', async () => {
  // --service is not a shell flag, so --compile + --service is valid
  const { stderr } = await runBuild(['--compile', '--service'])
  assertEquals(stderr.includes('conflicting flags'), false)
})

// ── --name flag slugification ──────────────────────────────

Deno.test('build: --name flag slugifies in output', async () => {
  const tmp = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(join(tmp, 'deno.json'), JSON.stringify({ title: 'test' }))
    await Deno.mkdir(join(tmp, 'src'))
    await Deno.writeTextFile(join(tmp, 'src', 'app.ts'), 'console.log("hi")')
    // --cli will try to compile, which fails — but we check the output mentions the slug
    const { stdout } = await runBuild(['--cli', '--name=My App!'], tmp)
    assertEquals(stdout.includes('my-app'), true)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

// ── withDevExcluded: symlink restore after failed compile ──

Deno.test('build: symlinks restored after failed --cli compile', async () => {
  const tmp = await Deno.makeTempDir()
  try {
    // Minimal project: has src/app.ts but deno compile will fail (missing deps)
    await Deno.writeTextFile(join(tmp, 'deno.json'), JSON.stringify({ title: 'test' }))
    await Deno.mkdir(join(tmp, 'src'), { recursive: true })
    await Deno.writeTextFile(join(tmp, 'src', 'app.ts'), 'import "nonexistent_dep_xyz"')

    // Fake node_modules with a dev symlink
    const denoDir = join(tmp, 'node_modules', '.deno')
    const fakeEsbuild = join(denoDir, 'esbuild@0.1.0')
    await Deno.mkdir(join(fakeEsbuild, 'node_modules', 'esbuild'), { recursive: true })
    await Deno.writeTextFile(join(fakeEsbuild, 'node_modules', 'esbuild', 'index.js'), '')

    // Top-level symlink: node_modules/esbuild → .deno/esbuild@0.1.0/node_modules/esbuild
    const symlinkPath = join(tmp, 'node_modules', 'esbuild')
    await Deno.symlink(join(fakeEsbuild, 'node_modules', 'esbuild'), symlinkPath)

    // Verify symlink exists before build
    const before = await Deno.readLink(symlinkPath)
    assertEquals(typeof before, 'string')

    // --cli skips esbuild, goes straight to withDevExcluded → deno compile (which will fail)
    const { code, stdout } = await runBuild(['--cli'], tmp)
    assertEquals(code, 1) // compile fails

    // Symlink must be restored by finally block
    const after = await Deno.readLink(symlinkPath)
    assertEquals(after, before)
    assertEquals(stdout.includes('restored'), true)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})
