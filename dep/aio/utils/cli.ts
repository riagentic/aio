#!/usr/bin/env -S deno run -A
// aio CLI — project management tool
// Install: deno install -g -A -n aio dep/aio/utils/cli.ts

import { create } from './create.ts'

const VERSION = '0.2.0'

const c = {
  bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m',
  yellow: '\x1b[33m', reset: '\x1b[0m',
}

function help(): void {
  console.log(`
${c.cyan}${c.bold}aio${c.reset} ${c.dim}v${VERSION}${c.reset} — all-in-one framework

${c.bold}Usage:${c.reset}
  aio <command> [options]

${c.bold}Commands:${c.reset}
  ${c.cyan}create${c.reset} <path> [--mirror]   Create a new aio project
  ${c.cyan}version${c.reset}                     Show version
  ${c.cyan}help${c.reset}                        Show this help

${c.bold}Examples:${c.reset}
  ${c.dim}aio create my-app${c.reset}              Download framework + scaffold
  ${c.dim}aio create ~/dev/app --mirror${c.reset}   Symlink to local framework (dev)

${c.dim}Inside a project, use deno tasks:${c.reset}
  ${c.dim}deno task dev${c.reset}                   Dev server with hot reload
  ${c.dim}deno task am status${c.reset}             App manager
  ${c.dim}deno task compile${c.reset}               Build for production
`)
}

const cmd = Deno.args[0]

switch (cmd) {
  case 'create':
  case 'init':
  case 'new':
    await create(Deno.args.slice(1))
    break

  case 'version':
  case '-v':
  case '--version':
    console.log(`aio ${VERSION}`)
    break

  case 'help':
  case '-h':
  case '--help':
  case undefined:
    help()
    break

  default:
    console.log(`${c.yellow}Unknown command:${c.reset} ${cmd}`)
    console.log(`${c.dim}Run ${c.cyan}aio help${c.dim} for available commands${c.reset}`)
    Deno.exit(1)
}
