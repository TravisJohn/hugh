'use strict';

/**
 * assistant.js
 * -----------------------------------------------------------------------------
 * Server-side brain for the floating "Hugh Admin Assistant". Calls OpenAI with
 * function-calling and a small toolbox grounded in the real project:
 *
 *   - read_file / list_files     → app/ (and the rest of the repo) source
 *   - git_log                    → recent changes
 *   - architecture_summary       → the latest scan (hotspots, layer counts)
 *   - npm_latest                 → newest published version of a dependency
 *   - web_fetch                  → release notes / changelogs for libraries+tools
 *
 * The OpenAI key and model are read from the project's .env.local (or the
 * environment). Nothing here touches the browser — the key never leaves the
 * server. Uses Node's global fetch (Node 18+), so no extra dependency.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOOL_DIR = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(TOOL_DIR, '..', '..');
const DATA_FILE = path.join(TOOL_DIR, 'architecture-data.json');
const SOURCE_ROOTS = ['app', 'components', 'hooks', 'lib', 'types', 'utils', 'supabase'];
const MAX_TOOL_ROUNDS = 6;

// --- config / env ------------------------------------------------------------

/** Minimal .env.local parser so we don't need the dotenv dependency. */
function loadEnv() {
  const out = {};
  const file = path.join(PROJECT_ROOT, '.env.local');
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (let line of text.split(/\r?\n/)) {
      line = line.replace(/^﻿/, '').trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      out[key] = val;
    }
  } catch { /* no .env.local — rely on process.env */ }
  return out;
}

function config() {
  const env = { ...loadEnv(), ...process.env }; // real env wins
  return {
    apiKey: env.OPENAI_API_KEY || '',
    model: env.OPENAI_MODEL || 'gpt-4o', // override in .env.local with your best model
    baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    adminUrl: env.HUGH_ADMIN_URL || 'http://localhost:3000/admin',
  };
}

function assistantStatus() {
  const c = config();
  return { configured: Boolean(c.apiKey), model: c.model, adminUrl: c.adminUrl };
}

// --- safety helpers ----------------------------------------------------------

function safeResolve(rel) {
  const abs = path.resolve(PROJECT_ROOT, rel);
  if (!abs.startsWith(PROJECT_ROOT)) throw new Error('path escapes project root');
  return abs;
}

/**
 * Block files that may hold secrets/credentials so the assistant can never read
 * them into the model context (and out to OpenAI / a prompt-injection). The
 * .env files hold the OpenAI, Supabase service-role, Anthropic and ElevenLabs
 * keys — full system access — so this matters even for a local tool.
 */
function isSensitive(rel) {
  const p = rel.replace(/\\/g, '/').toLowerCase();
  const base = p.split('/').pop();
  if (base.startsWith('.env')) return true;
  if (/\.(pem|key|p12|pfx|crt|cer)$/.test(base)) return true;
  if (['.npmrc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials', '.pgpass'].includes(base)) return true;
  if (p.split('/').includes('.git')) return true;
  return false;
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } catch (e) { return `git error: ${e.message}`; }
}

function clip(str, n) { return str.length > n ? str.slice(0, n) + `\n…[truncated, ${str.length - n} more chars]` : str; }

// --- tool implementations ----------------------------------------------------

/** All repo-relative source paths — from the scan if present, else a walk. */
function allPaths() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).components.map((c) => c.path);
  } catch {
    const paths = [];
    const walk = (dir, base) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(dir, e.name), r = path.join(base, e.name).split(path.sep).join('/');
        if (e.isDirectory()) walk(full, r); else paths.push(r);
      }
    };
    for (const root of SOURCE_ROOTS) {
      const abs = path.join(PROJECT_ROOT, root);
      if (fs.existsSync(abs)) walk(abs, root);
    }
    return paths;
  }
}

/** Paths that look like what the model asked for (basename / substring match). */
function suggestPaths(rel) {
  const want = rel.toLowerCase().replace(/\.(ts|tsx|js|jsx)$/, '');
  const base = want.split('/').pop();
  return allPaths()
    .filter((p) => { const lp = p.toLowerCase(); return lp.includes(want) || lp.includes(base); })
    .slice(0, 15);
}

const TOOLS_IMPL = {
  read_file({ path: rel }) {
    if (isSensitive(rel)) return `Refused: "${rel}" may contain secrets/credentials and is blocked from the assistant.`;
    const abs = safeResolve(rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      const hints = suggestPaths(rel);
      return `No file at "${rel}".` + (hints.length
        ? ` Did you mean one of these? Call read_file again with the exact path:\n${hints.join('\n')}`
        : ' Use list_files to discover the right path.');
    }
    return clip(fs.readFileSync(abs, 'utf8'), 16000);
  },
  list_files({ prefix = '' }) {
    const filtered = allPaths().filter((p) => p.startsWith(prefix)).sort();
    return clip(filtered.join('\n') + `\n(${filtered.length} files)`, 8000);
  },
  git_log({ limit = 15 }) {
    const n = Math.max(1, Math.min(50, Number(limit) || 15));
    return clip(git(['log', `-n${n}`, '--date=short', '--pretty=format:%h %ad %an — %s', '--stat']), 8000);
  },
  architecture_summary() {
    try {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const top = d.components.slice(0, 12).map((c) =>
        `${c.path} — hotspot ${c.hotspotScore}, LOC ${c.loc}, complexity ${c.complexity} (in ${c.fanIn}/out ${c.fanOut}), churn ${c.churn}`);
      return `Scanned ${d.generatedAt}\nfiles: ${d.components.length}, edges: ${d.edges.length}\n\nTop hotspots:\n${top.join('\n')}`;
    } catch { return 'No architecture-data.json yet — run `npm run scan`.'; }
  },
  async npm_latest({ package: pkg }) {
    if (!/^[@a-z0-9._/-]+$/i.test(pkg)) return 'invalid package name';
    try {
      const res = await fetch(`https://registry.npmjs.org/${pkg}`);
      if (!res.ok) return `registry HTTP ${res.status}`;
      const j = await res.json();
      const latest = j['dist-tags'] && j['dist-tags'].latest;
      const times = j.time || {};
      const recent = Object.entries(times).filter(([k]) => k !== 'created' && k !== 'modified')
        .sort((a, b) => new Date(b[1]) - new Date(a[1])).slice(0, 6)
        .map(([v, t]) => `${v} (${String(t).slice(0, 10)})`);
      const repo = (j.repository && j.repository.url) || j.homepage || '';
      return `${pkg}\nlatest: ${latest}\nrecent: ${recent.join(', ')}\nrepo: ${repo}`;
    } catch (e) { return `npm fetch failed: ${e.message}`; }
  },
  async web_fetch({ url }) {
    if (!/^https?:\/\//i.test(url)) return 'only http(s) URLs allowed';
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'hugh-admin-assistant' } });
      const type = res.headers.get('content-type') || '';
      let text = await res.text();
      if (type.includes('html')) {
        text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      }
      return clip(text, 8000);
    } catch (e) { return `fetch failed: ${e.message}`; }
  },
};

const TOOLS_SCHEMA = [
  { type: 'function', function: { name: 'read_file', description: 'Read a source file from the Hugh repo by repo-relative path (e.g. app/admin/page.tsx).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List repo source files, optionally filtered by a path prefix (e.g. app/api/).', parameters: { type: 'object', properties: { prefix: { type: 'string' } } } } },
  { type: 'function', function: { name: 'git_log', description: 'Recent git commits with changed files. limit defaults to 15.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } } },
  { type: 'function', function: { name: 'architecture_summary', description: 'Latest architecture scan: file/edge counts and top hotspots (churn × complexity).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'npm_latest', description: 'Latest published version + recent release dates for an npm package (for checking library updates vs the installed version).', parameters: { type: 'object', properties: { package: { type: 'string' } }, required: ['package'] } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Fetch a public http(s) URL (release notes, changelogs, docs) and return its text.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
];

// --- system prompt -----------------------------------------------------------

function installedDeps() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    const all = { ...p.dependencies, ...p.devDependencies };
    return Object.entries(all).map(([k, v]) => `${k}@${v}`).join(', ');
  } catch { return '(package.json unreadable)'; }
}

function systemPrompt() {
  return [
    "You are the Hugh Admin Assistant — an expert pair-administrator for the Hugh codebase.",
    "Hugh is a Next.js 16 (App Router) app on Vercel; Supabase (Postgres + Auth); Anthropic Claude for LLM; OpenAI Realtime voice in administrator preview; Tailwind. Source roots: app/, components/, hooks/, lib/, types/, utils/, supabase/.",
    "",
    "Your job: help administer and understand Hugh — architecture questions, where code lives, what changed recently, operational/admin tasks, and whether the libraries and tools it depends on have meaningful updates.",
    "",
    "Use your tools to ground every answer in the ACTUAL repo — do not guess at file contents or versions. Cite the files you read (path). For 'recent developments' in a library, compare the installed version against npm_latest and read the project's release notes/changelog via web_fetch before answering.",
    "",
    "Path conventions (App Router): API endpoints are folders ending in route.ts, e.g. the 'generate-question' route is app/api/interview/generate-question/route.ts — NOT app/api/generate-question.ts. Pages are app/<segment>/page.tsx. If you are unsure of an exact path, call list_files (optionally with a prefix like app/api/) FIRST, or read_file and follow the suggested paths it returns on a miss. Never give up after one failed read — search, then retry.",
    "Be concise and concrete. Lead with the answer, then the supporting detail. Prefer real paths, real versions, real commit hashes.",
    "",
    `Installed dependencies (from package.json): ${installedDeps()}`,
  ].join('\n');
}

// --- OpenAI tool loop --------------------------------------------------------

async function handleAssistant({ messages }) {
  const c = config();
  if (!c.apiKey) {
    return { needsSetup: true, reply: 'The assistant needs an OpenAI key. Add `OPENAI_API_KEY=...` to your project `.env.local` (optionally `OPENAI_MODEL=...`), then restart the server.' };
  }

  const convo = [{ role: 'system', content: systemPrompt() }, ...messages];
  const toolsUsed = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({ model: c.model, messages: convo, tools: TOOLS_SCHEMA, tool_choice: 'auto' }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { error: `OpenAI HTTP ${res.status}: ${clip(body, 400)}` };
    }
    const data = await res.json();
    const msg = data.choices[0].message;
    convo.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { reply: msg.content || '(no reply)', toolsUsed };
    }

    // Execute every requested tool call, append results, loop again.
    for (const call of msg.tool_calls) {
      const name = call.function.name;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* ignore */ }
      let result;
      try {
        result = TOOLS_IMPL[name] ? await TOOLS_IMPL[name](args) : `unknown tool ${name}`;
      } catch (e) { result = `tool error: ${e.message}`; }
      toolsUsed.push({ name, args });
      convo.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
  }
  return { reply: 'Stopped after too many tool calls — please narrow the question.', toolsUsed };
}

module.exports = { handleAssistant, assistantStatus };
