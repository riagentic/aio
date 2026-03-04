// Build helpers — pure/extractable utilities used by build.ts
import { join } from '@std/path'

/** Slugify a string for use as binary/app name */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'myapp'
}

/** Recursively copy a directory (preserves symlinks + executable bits) */
export async function copyDir(src: string, dst: string): Promise<void> {
  await Deno.mkdir(dst, { recursive: true })
  for await (const entry of Deno.readDir(src)) {
    const srcPath = join(src, entry.name)
    const dstPath = join(dst, entry.name)
    if (entry.isDirectory) {
      await copyDir(srcPath, dstPath)
    } else if (entry.isSymlink) {
      const target = await Deno.readLink(srcPath)
      await Deno.symlink(target, dstPath)
    } else {
      await Deno.copyFile(srcPath, dstPath)
      // Preserve executable bit
      try {
        const info = await Deno.stat(srcPath)
        if (info.mode !== null && info.mode & 0o111) {
          await Deno.chmod(dstPath, info.mode)
        }
      } catch { /* no mode — skip chmod */ }
    }
  }
}

/** Find gradle binary — checks PATH then common install locations */
export function findGradle(): string | null {
  const home = Deno.env.get('HOME') ?? '/tmp'
  const candidates = [
    'gradle',
    '/usr/bin/gradle',
    '/usr/local/bin/gradle',
    '/snap/bin/gradle',
    '/opt/gradle/bin/gradle',
    `${home}/.sdkman/candidates/gradle/current/bin/gradle`,
  ]
  for (const cmd of candidates) {
    try {
      const r = new Deno.Command(cmd, { args: ['--version'], stdout: 'null', stderr: 'null' }).outputSync()
      if (r.code === 0) return cmd
    } catch { /* not found — try next */ }
  }
  return null
}

/** Write a placeholder SVG icon */
export async function writePlaceholderIcon(path: string, label: string): Promise<void> {
  const letter = (label[0] ?? 'A').toUpperCase()
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">
  <rect width="48" height="48" rx="8" fill="#4a9eff"/>
  <text x="24" y="34" font-size="28" font-family="sans-serif" fill="white" text-anchor="middle">${letter}</text>
</svg>`
  await Deno.writeTextFile(path, svg)
}
