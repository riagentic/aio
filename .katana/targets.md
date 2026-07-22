# Targets

- you can build server application
- you can build electron application
- you can build browser application
- you can build android application
- you can build cli application
- you can build remote application (server + thin clients)
- you can build unified aio client

## Dev builds

- default dev build, whatever the default target is: `deno task dev`
- local browser dev build: `deno task dev:browser`
- local electron dev build: `deno task dev:electron`
- local android dev build running in emulator: `deno task dev:android`
- local cli app dev build: `deno task dev:cli`
- local service dev build: `deno task dev:service`
- unified aio client dev build: `deno task dev:client`
- remote server/browser dev build (exposed server):
  `deno task dev:remote:browser`
- electron thin client that connects to a remote server:
  `deno task dev:remote:electron`
- android dev against an exposed server: `deno task dev:remote:android`
- cli thin client that connects to a remote aio server:
  `deno task dev:remote:cli`
- remote service dev build (exposed headless server):
  `deno task dev:remote:service`

## Production builds

- default production build: `deno task compile`
- local browser production build: `deno task compile:browser`
- local electron production build: `deno task compile:electron`
- local android production build (apk): `deno task compile:android`
- local cli app production build: `deno task compile:cli`
- local service production build: `deno task compile:service`
- unified aio client production build: `deno task compile:client`
- remote server/browser production build: `deno task compile:remote:browser`
- electron app that connects to a remote server (builds both, server and
  client): `deno task compile:remote:electron`
- android app that connects to a remote server (builds both, server and client):
  `deno task compile:remote:android`
- cli app that connects to a remote aio server (builds both, server and client):
  `deno task compile:remote:cli`
- remote service production build (headless remote server):
  `deno task compile:remote:service`
