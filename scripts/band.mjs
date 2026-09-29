#!/usr/bin/env node
// Drive Pickup's band from outside the browser (e.g. from Claude Code in a terminal).
//
//   node scripts/band.mjs serve              run the local relay (keep it running)
//   node scripts/band.mjs wait               block until the user sends a message; print it
//   node scripts/band.mjs system             print the band's system prompt
//   node scripts/band.mjs tool <name> [json] call a band tool (args as JSON, or on stdin); print its result
//   node scripts/band.mjs say [text]         reply to the user (text or stdin); ends the turn
//
// In the app, pick the "Local" band model. Each turn the page POSTs /turn to the
// relay and the response is held until the driver acts: a tool call (the page
// runs it and POSTs the result as the next /turn, which becomes the driver's
// HTTP response) or a reply, which ends the turn. No dependencies; Node 18+.
// PICKUP_BAND_PORT sets the port (default 7878).
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = Number(process.env.PICKUP_BAND_PORT) || 7878
const BASE = `http://localhost:${PORT}`
const WAIT_MS = 25_000

// ---------------------------------------------------------------------------
// Relay

function serve() {
  let system = ''
  /** The page's open /turn request, waiting for an action. */
  let pending = null // { req, respond(action) }
  /** A user message not yet handed to the driver. */
  let unseen = null
  let waiters = []
  /** A driver's tool call waiting for its result. */
  let toolWaiter = null

  function onTurn(turn, respond) {
    system = turn.system || system
    pending = { turn, respond }
    if (turn.kind === 'toolResult' && toolWaiter) {
      const w = toolWaiter
      toolWaiter = null
      w(turn)
    } else if (turn.kind === 'user') {
      if (waiters.length) {
        waiters.forEach((w) => w(turn))
        waiters = []
      } else unseen = turn
    }
  }

  function act(action) {
    if (!pending) throw new Error('The page is not waiting on the band (send a message from the app first).')
    const { respond } = pending
    pending = null
    respond(action)
  }

  /** Tool results as text; an image goes to a temp file whose path is appended. */
  function describe(turn) {
    let out = turn.isError ? `ERROR: ${turn.text}` : turn.text
    if (turn.image) {
      const file = path.join(os.tmpdir(), `pickup-band-${Date.now()}.png`)
      fs.writeFileSync(file, Buffer.from(turn.image.data, 'base64'))
      out += `\n[image saved to ${file}]`
    }
    return out
  }

  const body = (req) =>
    new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {})
        } catch (e) {
          reject(e)
        }
      })
    })

  const server = http.createServer(async (req, res) => {
    // the app may be served from anywhere (including a public https site)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
    const send = (status, text, type = 'text/plain; charset=utf-8') => {
      res.statusCode = status
      res.setHeader('content-type', type)
      res.end(text)
    }
    try {
      const route = `${req.method} ${req.url.split('?')[0]}`
      switch (route) {
        case 'OPTIONS /turn':
          return send(204, '')
        case 'GET /ping':
          return send(200, 'Pickup band relay')
        case 'POST /turn': {
          const turn = await body(req)
          let done = false
          // the page aborted or reloaded: forget the turn
          res.on('close', () => {
            if (!done && pending?.turn === turn) pending = null
            if (unseen === turn) unseen = null
          })
          onTurn(turn, (action) => {
            done = true
            send(200, JSON.stringify(action), 'application/json')
          })
          return
        }
        case 'GET /system':
          return send(200, system || '(no turn yet: send a message from the app first)')
        case 'GET /wait': {
          if (unseen) {
            const t = unseen
            unseen = null
            return send(200, t.text)
          }
          const t = await new Promise((resolve) => {
            const w = (t) => resolve(t)
            waiters.push(w)
            setTimeout(() => {
              waiters = waiters.filter((x) => x !== w)
              resolve(null)
            }, WAIT_MS)
          })
          return t ? send(200, t.text) : send(204, '')
        }
        case 'POST /tool': {
          const { name, args } = await body(req)
          if (toolWaiter) return send(409, 'Another tool call is still running.')
          const result = new Promise((resolve) => (toolWaiter = resolve))
          try {
            act({ type: 'tool', name, args: args ?? {} })
          } catch (e) {
            toolWaiter = null
            throw e
          }
          return send(200, describe(await result))
        }
        case 'POST /say': {
          const { text } = await body(req)
          act({ type: 'reply', text: String(text ?? '') })
          return send(200, 'ok')
        }
      }
      send(404, 'unknown endpoint')
    } catch (e) {
      send(400, e?.message ?? String(e))
    }
  })
  server.requestTimeout = 0
  server.listen(PORT, '127.0.0.1', () => console.log(`Pickup band relay on ${BASE} — pick the "Local" band model in the app`))
}

// ---------------------------------------------------------------------------
// Driver commands

const stdin = async () => {
  if (process.stdin.isTTY) return ''
  let data = ''
  for await (const c of process.stdin) data += c
  return data
}

async function call(method, route, payload) {
  const res = await fetch(BASE + route, {
    method,
    headers: payload ? { 'content-type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  }).catch(() => {
    throw new Error(`No relay at ${BASE}. Start it with: node scripts/band.mjs serve`)
  })
  const text = await res.text()
  if (res.status >= 400) {
    console.error(text)
    process.exit(1)
  }
  return { status: res.status, text }
}

const [cmd, ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'serve':
    serve()
    break
  case 'wait':
    for (;;) {
      const { status, text } = await call('GET', '/wait')
      if (status === 200) {
        console.log(text)
        break
      }
    }
    break
  case 'system':
    console.log((await call('GET', '/system')).text)
    break
  case 'tool': {
    const [name, json] = rest
    if (!name) throw new Error('usage: band.mjs tool <name> [json args, or on stdin]')
    const raw = json ?? (await stdin())
    console.log((await call('POST', '/tool', { name, args: raw.trim() ? JSON.parse(raw) : {} })).text)
    break
  }
  case 'say': {
    const text = rest.length ? rest.join(' ') : await stdin()
    console.log((await call('POST', '/say', { text: text.trim() })).text)
    break
  }
  default:
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 8).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
}
