// Dashboard and control panel over the tracker. Serves http://localhost:PORT,
// pushes a reload event (server-sent events) when the tracker file changes, and
// runs a fixed list of local tasks (scans, checks, exports) on request.
//
// The panel can only start the tasks in TASKS below. None of them sends email,
// submits a form or writes to an external site. Requests must carry the
// per-run token and come from this host, so other web pages cannot trigger them.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeSource, loadProfile, localDate, paths as pathsOf, saveHome } from '../config.mjs';
import { initHome, inspectHome, suggestedHome } from '../home.mjs';
import { followUpStatus } from '../followups.mjs';
import { Tracker, events, lastActivity, parseScore } from '../tracker.mjs';
import { AGENT_TASKS, detectAgents, launchInteractive, readAgent, saveAgent, taskCommand } from '../agents.mjs';
import { readResumeLibrary, routeResume } from '../resumes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', '..', 'bin', 'apply-pilot.mjs');

const TASKS = {
  doctor: { label: 'doctor', args: () => ['doctor'] },
  all: { label: 'scan all', args: () => ['scan', 'all', '--pipeline'] },
  portals: { label: 'scan portals', args: () => ['scan', 'portals', '--pipeline'] },
  boards: { label: 'scan boards', args: () => ['scan', 'boards', '--pipeline'] },
  websearch: { label: 'scan websearch', args: () => ['scan', 'websearch', '--pipeline'] },
  linkedin: { label: 'linkedin scan', args: () => ['linkedin', 'scan', '--pipeline'] },
  followups: { label: 'followups', args: () => ['followups'] },
  export: { label: 'export xlsx', args: (p) => ['export', 'xlsx', join(p.output, `applications-${localDate()}.xlsx`)] },
};

export function openInBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function openFolder(dir) {
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).unref();
}

export function serve({ home, port = 4321, host = '127.0.0.1', open = false }) {
  const token = randomBytes(16).toString('hex');
  // The data folder can change while the panel runs (folder picker), so these are reassigned by use().
  let profile, paths, trackerFile, setup = false, watcher = null;
  const data = () => {
    if (!existsSync(trackerFile)) return [];
    const today = localDate();
    return new Tracker(trackerFile).rows().map((r) => {
      const f = followUpStatus(r, profile.followUp, today);
      return {
        num: r.num, date: r.date, company: r.company, role: r.role, status: r.status, notes: r.notes,
        score: parseScore(r.score), url: (r.url.match(/https?:\/\/\S+/) || [])[0] || '',
        lastActivity: lastActivity(r, today), events: events(r, today), due: Boolean(f?.due), channel: f?.channel || null,
      };
    });
  };

  const clients = new Set();
  const push = (event, payload) => { for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); };
  let timer = null;
  const use = (dir) => {
    profile = loadProfile(dir);
    paths = pathsOf(dir, profile);
    trackerFile = paths.tracker;
    setup = !existsSync(paths.profile) && !existsSync(trackerFile);
    watcher?.close();
    watcher = null;
    if (existsSync(dirname(trackerFile))) {
      watcher = watch(dirname(trackerFile), (_e, name) => {
        if (name && String(name) !== basename(trackerFile)) return;
        clearTimeout(timer);
        timer = setTimeout(() => push('changed', {}), 300);
      });
    }
  };
  use(resolve(home));
  const homeInfo = () => ({ path: paths.home, source: homeSource(), setup, suggested: inspectHome(homeSource() === 'env' ? paths.home : suggestedHome()) });
  const useHome = ({ path, create }) => {
    if (running) throw new Error(`"${running}" is still running`);
    if (!path) throw new Error('enter a folder path');
    const info = inspectHome(path);
    if (info.isFile) throw new Error(`${info.home} is a file, not a folder`);
    const created = !info.hasProfile && !info.hasTracker;
    if (created && !create) throw new Error(`no Apply-Pilot data in ${info.home}`);
    if (created) initHome(info.home);
    saveHome(info.home);
    use(info.home);
    agents = detectAgents();
    push('changed', {});
    return { ok: true, home: info.home, created, envOverride: Boolean(process.env.APPLY_PILOT_HOME) && resolve(process.env.APPLY_PILOT_HOME) !== info.home };
  };

  let running = null;
  let agents = detectAgents();
  const runTask = (id) => {
    if (running) return { ok: false, error: `"${running}" is still running` };
    let label, cmd, args, shell = false;
    if (TASKS[id]) {
      ({ label } = TASKS[id]);
      cmd = process.execPath; args = [CLI, ...TASKS[id].args(paths)];
    } else if (AGENT_TASKS[id]) {
      const agent = readAgent(paths.home);
      if (!agent) return { ok: false, error: 'choose an AI agent first' };
      const c = taskCommand(agent, id, { home: paths.home, cli: CLI });
      if (!c) return { ok: false, error: `${agent} cannot run this task here (install opencode or use Claude/Codex)` };
      label = `${AGENT_TASKS[id].label} · ${agent}`;
      ({ cmd, args, shell } = c);
      if (shell) args = args.map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
    } else return { ok: false, error: 'unknown task' };
    running = label;
    push('task', { state: 'start', task: label, at: new Date().toISOString() });
    const child = spawn(cmd, args, { cwd: paths.home, shell, env: { ...process.env, APPLY_PILOT_HOME: paths.home }, windowsHide: true });
    child.on('error', (e) => { push('log', { text: `! ${e.message}` }); });
    const line = (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((text) => push('log', { text }));
    child.stdout.on('data', line);
    child.stderr.on('data', line);
    child.on('close', (code) => { push('task', { state: 'end', task: label, code }); running = null; });
    return { ok: true };
  };

  const latestInbox = () => {
    if (!existsSync(paths.inbox)) return [];
    return readdirSync(paths.inbox).filter((f) => f.endsWith('.json'))
      .map((f) => ({ file: f, mtime: statSync(join(paths.inbox, f)).mtimeMs })).sort((a, b) => b.mtime - a.mtime).slice(0, 8)
      .map(({ file, mtime }) => ({ file, at: new Date(mtime).toISOString() }));
  };

  const allowed = (req) => {
    const hostHeader = String(req.headers.host || '');
    const origin = String(req.headers.origin || '');
    const actualPort = server.address()?.port || port;
    const local = new RegExp(`^(localhost|127\\.0\\.0\\.1):${actualPort}$`);
    return local.test(hostHeader) && (!origin || new RegExp(`^http://(localhost|127\\.0\\.0\\.1):${actualPort}$`).test(origin)) && req.headers['x-token'] === token;
  };

  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/data') {
      try { json(res, 200, { generated: new Date().toISOString(), home: homeInfo(), followUpDays: profile.followUp.afterDays, rows: data(), running, inbox: latestInbox(), tasks: Object.keys(TASKS), agents, agent: readAgent(paths.home) }); }
      catch (err) { res.writeHead(500).end(String(err)); }
      return;
    }
    if (pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (pathname.startsWith('/api/') && req.method === 'POST') {
      if (!allowed(req)) return json(res, 403, { ok: false, error: 'forbidden' });
      const withBody = (fn) => {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
        req.on('end', () => { try { json(res, 200, fn(JSON.parse(body || '{}'))); } catch (e) { json(res, 400, { ok: false, error: e.message || 'bad request' }); } });
      };
      if (pathname === '/api/run') return withBody((b) => runTask(b.task));
      if (pathname === '/api/prepare') return withBody((b) => ({ ok: true, ...routeResume(paths.home, loadProfile(paths.home), b) }));
      if (pathname === '/api/resumes') return withBody(() => ({ ok: true, resumes: readResumeLibrary(paths.home), policy: loadProfile(paths.home).jobPolicy }));
      if (pathname === '/api/home/check') return withBody((b) => ({ ok: true, ...inspectHome(b.path || '') }));
      if (pathname === '/api/home/use') return withBody(useHome);
      if (pathname === '/api/agent/select') return withBody((b) => ({ ok: true, agent: saveAgent(paths.home, b.agent) }));
      if (pathname === '/api/agent/launch') return withBody((b) => ({ ok: launchInteractive(b.agent, { home: paths.home }) }));
      if (pathname === '/api/import/preview' || pathname === '/api/import/write') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
        req.on('end', async () => {
          try {
            const { path } = JSON.parse(body || '{}');
            if (!path) throw new Error('enter a file or folder path');
            const { previewImport, writeImport } = await import('../importer.mjs');
            const pv = await previewImport(path, trackerFile);
            const added = pathname.endsWith('/write') ? writeImport(pv, trackerFile) : null;
            json(res, 200, { ok: true, input: pv.input, files: pv.files, sources: pv.sources, errors: pv.errors, fresh: pv.fresh.length, duplicates: pv.duplicates.length, sample: pv.fresh.slice(0, 40), added });
          } catch (e) { json(res, 200, { ok: false, error: e.message }); }
        });
        return;
      }
      if (pathname === '/api/agent/refresh') { agents = detectAgents(); return json(res, 200, { ok: true, agents }); }
      if (pathname === '/api/open-data') { mkdirSync(paths.home, { recursive: true }); openFolder(paths.home); return json(res, 200, { ok: true }); }
      if (pathname === '/api/quit') { json(res, 200, { ok: true }); setTimeout(() => process.exit(0), 200); return; }
      return json(res, 404, { ok: false });
    }
    if (pathname === '/prepare') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(readFileSync(join(HERE, 'prepare.html'), 'utf8').replace('__TOKEN__', token));
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(readFileSync(join(HERE, 'index.html'), 'utf8').replace('__TOKEN__', token));
      return;
    }
    if (pathname === '/icon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
      res.end(readFileSync(join(HERE, '..', '..', 'assets', 'icon.svg')));
      return;
    }
    res.writeHead(404).end();
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`port ${port} is already in use: Apply-Pilot is probably running, opening it`);
      if (open) openInBrowser(`http://localhost:${port}`);
      setTimeout(() => process.exit(0), 500);
    } else throw err;
  });
  server.listen(port, host, () => {
    const actualPort = server.address().port;
    console.log(`apply-pilot panel: http://localhost:${actualPort}  (tracker: ${trackerFile})`);
    if (open) openInBrowser(`http://localhost:${actualPort}`);
  });
  server.on('close', () => { watcher?.close(); clearTimeout(timer); });
  return server;
}
