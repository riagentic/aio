#!/usr/bin/env -S deno run -A
// Legacy wrapper — delegates to aio CLI create command
// Prefer: deno run -A dep/aio/utils/cli.ts create <path>

import { create } from './dep/aio/utils/create.ts'

const c = { bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', reset: '\x1b[0m' }

console.log(`
  ${c.cyan}_v_${c.reset}
 ${c.cyan}(o>o)${c.reset}  ${c.bold}☠ aio${c.reset}
  ${c.cyan})/${c.reset}   ${c.dim}seven files to production${c.reset}
 ${c.cyan}/|${c.reset}
`)

await create(Deno.args)
