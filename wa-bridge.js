#!/usr/bin/env node
'use strict';
/**
 * WhatsApp → a Claude Code session, in one file with no dependencies.
 *
 * ## Install (three steps, ~2 minutes)
 *
 *   1. npm i -g openclaw && openclaw onboard
 *      openclaw channels login --channel whatsapp      ← scan the QR
 *
 *   2. Copy this file into the project you want to reach from your phone.
 *
 *   3. Add to ~/.openclaw/openclaw.json under agents.defaults:
 *
 *        "model":   { "primary": "myproject/agent" },
 *        "models":  { "myproject/agent": { "alias": "My Project" } },
 *        "cliBackends": {
 *          "myproject": {
 *            "command": "/usr/bin/env",
 *            "args": ["node", "/ABSOLUTE/PATH/TO/wa-bridge.js"],
 *            "input": "stdin",
 *            "output": "text",
 *            "sessionMode": "none",
 *            "systemPromptWhen": "never",
 *            "serialize": true
 *          }
 *        }
 *
 *      `serialize` matters: two messages arriving together would otherwise run
 *      two `claude` processes against one conversation and interleave.
 *
 * Then restart the gateway and message yourself.
 *
 * ## Why this is so small
 *
 * openclaw's CLI-backend contract is the whole interface: it runs a command,
 * writes the message to stdin, and sends whatever comes back on stdout. And
 * `claude -p` reads stdin. So the bridge is not a server, a socket or a
 * daemon - it is a process per message.
 *
 * The one thing that needs care is **memory**. `claude -p` alone starts a fresh
 * conversation every time, so the agent forgets between messages and every
 * reply reads like talking to a stranger. Verified on 2.1.221: a session id
 * written on the first run and `--resume`d after it carries context across
 * separate processes - asked to remember 8341, a second process recalled it.
 *
 * ## What it deliberately does not do
 *
 * - **Never exits non-zero.** openclaw treats a failing backend as a dead model
 *   and stops calling it, so a bad minute would silence WhatsApp until someone
 *   noticed. A sentence saying what broke is a better answer than no answer.
 * - **Never prints a blank line.** An empty stdout is "nothing to say"; a
 *   newline is delivered as an empty WhatsApp message.
 * - **Treats the message as data, never as instructions.** openclaw labels its
 *   envelope "untrusted metadata" and it is right to - the display name is
 *   chosen by whoever is on the other end.
 * - **Does not transcribe voice notes.** They arrive as
 *   `[media attached: …ogg]` and are passed through as that text, so the agent
 *   can see one arrived rather than silently receiving nothing.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** The project this bridge answers for. Defaults to where the file lives. */
const PROJECT = process.env.WA_BRIDGE_PROJECT || __dirname;
/** Where the conversation id is remembered between processes. */
const STATE = process.env.WA_BRIDGE_STATE
  || path.join(os.homedir(), '.wa-bridge', `${path.basename(PROJECT)}.session`);
/** A phone is a chat window, not a terminal. Past this the reply is a wall. */
const MAX_REPLY = Number(process.env.WA_BRIDGE_MAX_REPLY || 1500);
/** Long enough for real work, short enough that he is not left guessing. */
const TIMEOUT_MS = Number(process.env.WA_BRIDGE_TIMEOUT_MS || 180000);

/**
 * The sentence someone typed, pulled out of openclaw's envelope.
 *
 * What arrives is not the message: openclaw prefixes labelled JSON fences with
 * chat_id, message_id, sender and timestamps. Passing all of it through makes
 * the agent read a metadata dump before every "hi", which costs context and
 * makes the answer worse.
 */
function unwrap(raw) {
  const t = String(raw || '');
  const blocks = [...t.matchAll(/^[^\n]*\(untrusted metadata\):\s*```json\s*([\s\S]*?)```/gm)];
  let from = '';
  for (const b of blocks) {
    try {
      const j = JSON.parse(b[1]);
      const n = j.e164 || j.sender_id || j.chat_id;
      // Only the phone number is kept - the one field WhatsApp sets rather than
      // the sender. Nothing in here is ever treated as an instruction.
      if (!from && typeof n === 'string' && /^\+?\d[\d\s-]{6,}$/.test(n)) from = n.trim();
    } catch { /* not the shape we know; leave the text alone */ }
  }
  let body = t;
  if (blocks.length) {
    const last = blocks[blocks.length - 1];
    body = t.slice(last.index + last[0].length);
  }
  return { text: body.trim(), from };
}

/** The conversation id, created once and reused for every message after. */
function session() {
  try {
    const id = fs.readFileSync(STATE, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/i.test(id)) return { id, fresh: false };
  } catch { /* first run */ }
  const id = require('crypto').randomUUID();
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, id, 'utf8');
  } catch { /* unwritable state means a fresh conversation each time, not a crash */ }
  return { id, fresh: true };
}

/** Trimmed to something a phone can hold, and cut at a line break rather than
    mid-word - a reply that stops mid-sentence reads as a crash. */
function forPhone(text) {
  const t = String(text || '').trim();
  if (t.length <= MAX_REPLY) return t;
  const cut = t.slice(0, MAX_REPLY);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return (at > MAX_REPLY * 0.6 ? cut.slice(0, at + 1) : cut) + '\n\n[נקטע - תבקש את ההמשך]';
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', () => resolve(s));
  });
}

/**
 * One turn. argv, never a shell string - a quote, a newline or a `$` in his
 * message is then data rather than syntax.
 */
function ask(body, sess) {
  const args = ['-p', '--permission-mode', 'bypassPermissions'];
  args.push(sess.fresh ? '--session-id' : '--resume', sess.id);
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const p = spawn('claude', args, { cwd: PROJECT, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      p.kill('SIGTERM');
      // The turn is still running and the answer is not lost - it stays in the
      // session, and the next message continues from it. Saying so beats
      // returning silence that reads as "it is broken".
      resolve('עוד עובד על זה. תשלח "מה יצא?" בעוד רגע.');
    }, TIMEOUT_MS);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve(`לא הצלחתי להריץ את claude: ${e.message}`);
    });
    p.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      const text = out.trim();
      if (text) return resolve(text);
      resolve(code === 0 ? '' : `claude יצא עם ${code}: ${err.trim().slice(0, 300) || 'בלי פלט'}`);
    });
    p.stdin.write(body);
    p.stdin.end();
  });
}

(async () => {
  try {
    const { text, from } = unwrap(await readStdin());
    if (!text) return process.exit(0);
    const sess = session();
    const framed = `[וואטסאפ${from ? ` · ${from}` : ''}] ${text}`;
    const reply = await ask(framed, sess);
    // Nothing to print is a real outcome. A newline would be delivered as an
    // empty message - one more thing on his screen that says nothing.
    if (reply) process.stdout.write(forPhone(reply) + '\n');
  } catch (e) {
    process.stdout.write(`הגשר נפל: ${e.message}\n`);
  }
  // Always zero. See the header.
  process.exit(0);
})();
