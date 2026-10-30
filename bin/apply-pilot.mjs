#!/usr/bin/env node
// apply-pilot command line. Run `apply-pilot help` for the command list.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir, homeSource, loadEnv, loadProfile, paths, saveHome, settingsFile } from '../src/config.mjs';
import { initHome, inspectHome } from '../src/home.mjs';
import { Tracker, findDuplicates, lastActivity } from '../src/tracker.mjs';
import { buildPrompt, evaluateText, finishEvaluation, parseModelJson } from '../src/evaluate.mjs';
import { dueFollowUps } from '../src/followups.mjs';
import { lintText } from '../src/lint.mjs';
import { buildDocx, readParagraphs } from '../src/docx.mjs';
import { triage } from '../src/triage.mjs';
import { findCareerOps, runCareerOps } from '../src/careerops.mjs';
import { checkJobPolicy } from '../src/job-policy.mjs';
import { readResumeLibrary, registerResume, routeResume } from '../src/resumes.mjs';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      opt[k] = v !== undefined ? v : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    } else pos.push(a);
  }
  return { pos, opt };
}

const HELP = `Apply-Pilot — local job/internship application pipeline

Data folder: APPLY_PILOT_HOME, else the folder saved with "home PATH" or in the panel, else ./apply-data.
It holds profile.json, data/applications.md, inbox/, output/.

  init [--example NAME]                 create the data directory (examples: ${['generic', 'pharma-m2-europe', 'cn-eu-careers'].join(', ')})
  screen JOB.json [--out REPORT.json]  check job policy and recommend a registered resume (offline)
  policy JOB.json                       inspect job type and internship allowlist
  resume list                          list registered resume versions
  resume add CV.pdf --id ID --language zh|en --tracks robotics --types full_time,phd [--keywords ROS,planning]
  resume route JOB.json                recommend a resume; never submits an application
  home [PATH] [--init [EXAMPLE]]        show the data folder, or save PATH as the default (--init creates it)
  doctor                                check setup (node, profile, tracker, optional tools, API keys)
  ui [--port 4321] [--open]             dashboard + control panel (scans, checks, export) in your browser
  shortcut [--dir DIR]                  put a double-click launcher for the panel on your desktop
  import PATH [--write] [--json]        read an existing database (file or folder): applications.md, Markdown tables,
                                        Excel .xlsx, CSV/TSV, JSON, SQLite; preview first, --write appends new rows
  list [--status S] [--q TEXT]          print tracker rows
  add --company C --role R [--url U] [--score N] [--status S] [--notes N] [--force]
  status NUM STATUS [--note TEXT]       change status and append a dated note
  note NUM TEXT                         append a dated note without changing status
  followups [--json]                    applications due a follow-up (rules: profile.followUp)
  eval prompt JD.txt                    print the scoring prompt for your agent to answer
  eval score ANSWER.json [--jd JD.txt]  weighted score from the agent's JSON answer
  eval run JD.txt [--provider deepseek|openai|openrouter|ollama|anthropic] [--model M] [--add]
  eval pipeline [--provider P] [--limit 10]   evaluate pending data/pipeline.md postings into output/agent-evaluation-DATE.md
  agent [claude|codex|deepseek]         show or choose the AI agent the panel pairs with
  jd URL [--out FILE] [--browser] [--json]   fetch a job description (ATS APIs, page text, optional browser)
  keywords REPORT.md [--cv cv.md] [--json]   which "## Keywords extracted" items your CV covers
  lint FILE...                          plain-writing check for letters and emails
  docx list FILE.docx                   show paragraph indices of a template
  docx build TEMPLATE OUT CHANGES.json  fill paragraphs, keep everything else identical
  scan portals [--only NAME] [--pipeline [FILE]]  company career sites: Workday, SuccessFactors, Phenom, Eightfold, SmartRecruiters,
                                        Personio, Greenhouse, Lever, Ashby, Teamtailor, Recruitee, Workable
  scan boards [--pipeline]              job boards and public APIs: JobTech, Euraxess, France Travail, Adzuna, Jooble, Careerjet
  scan websearch [--engine E] [--pipeline]  search queries through Brave, Mojeek or your SearXNG
  scan all [--pipeline]                 portals + boards + websearch
  linkedin login | linkedin scan [--jobs|--posts] [--pipeline]
  triage SCAN.json [--json OUT] [--pipeline [FILE]]   new candidates, minus tracked and filtered; optionally append to data/pipeline.md
  merge-additions [DIR] [--dry-run]     merge batch TSV tracker additions (default DIR: batch/tracker-additions)
  export xlsx OUT.xlsx                  tracker to a fresh spreadsheet
  careerops SCRIPT [ARGS]               run a career-ops script on the same data (optional)

Nothing here sends email or submits forms. Agents must get your approval first (see AGENTS.md).`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  const home = homeDir();
  loadEnv(home);
  const profile = loadProfile(home);
  const p = paths(home, profile);
  const tracker = () => new Tracker(p.tracker);

  switch (cmd) {
    case 'policy': {
      if (!pos[0]) throw new Error('policy JOB.json');
      console.log(JSON.stringify(checkJobPolicy(profile, JSON.parse(readFileSync(pos[0], 'utf8'))), null, 2));
      break;
    }
    case 'screen':
    case 'resume': {
      const split = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (cmd === 'resume' && pos[0] === 'list') { console.log(JSON.stringify(readResumeLibrary(home), null, 2)); break; }
      if (cmd === 'resume' && pos[0] === 'add') {
        const row = registerResume(home, pos[1], { id: opt.id, language: opt.language, tracks: split(opt.tracks), jobTypes: split(opt.types), keywords: split(opt.keywords) });
        console.log(JSON.stringify(row, null, 2)); break;
      }
      const file = cmd === 'screen' ? pos[0] : pos[0] === 'route' ? pos[1] : null;
      if (!file) throw new Error('screen JOB.json | resume list|add|route');
      const job = JSON.parse(readFileSync(file, 'utf8'));
      const report = { job, ...routeResume(home, profile, job) };
      console.log(JSON.stringify(report, null, 2));
      if (opt.out) {
        if (existsSync(opt.out)) throw new Error('report already exists; choose a new output path');
        mkdirSync(dirname(resolve(opt.out)), { recursive: true });
        writeFileSync(opt.out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
      }
      break;
    }
    case 'init': {
      const { wrote } = initHome(home, opt.example || 'generic');
      for (const f of wrote) console.log(`wrote ${f}`);
      if (!wrote.length) console.log(`kept existing files in ${home}`);
      console.log('Next: edit profile.json, then `apply-pilot ui`.');
      break;
    }
    case 'home': {
      if (pos[0]) {
        const info = inspectHome(pos[0]);
        if (info.isFile) throw new Error(`${info.home} is a file, not a folder`);
        if (!info.hasProfile && !info.hasTracker) {
          if (!opt.init) throw new Error(`${info.home} has no Apply-Pilot data; add --init to create it there`);
          initHome(info.home, typeof opt.init === 'string' ? opt.init : 'generic');
        }
        console.log(`saved ${info.home} in ${saveHome(info.home)}`);
        if (process.env.APPLY_PILOT_HOME) console.log(`note: APPLY_PILOT_HOME is set (${process.env.APPLY_PILOT_HOME}) and still takes precedence`);
        break;
      }
      const info = inspectHome(home);
      const from = { env: 'from APPLY_PILOT_HOME', settings: `from ${settingsFile()}`, default: 'default ./apply-data' }[homeSource()];
      console.log(`${home}  (${from})`);
      console.log(info.hasTracker ? `${info.rows} tracked rows` : 'no tracker yet: run `apply-pilot init` or `apply-pilot home PATH --init`');
      break;
    }
    case 'doctor': {
      const ok = (b, msg) => console.log(`${b ? '✓' : '✗'} ${msg}`);
      ok(Number(process.versions.node.split('.')[0]) >= 20, `node ${process.versions.node} (need >= 20)`);
      ok(existsSync(p.profile), `profile ${p.profile}`);
      ok(existsSync(p.tracker), `tracker ${p.tracker} (${existsSync(p.tracker) ? tracker().rows().length + ' rows' : 'missing'})`);
      ok(profile.scoring.dimensions.length > 0, `${profile.scoring.dimensions.length} scoring dimensions`);
      for (const mod of ['playwright', 'exceljs']) {
        let has = true; try { await import(mod); } catch { has = false; }
        ok(has, `${mod} ${has ? 'installed' : 'not installed (optional)'}`);
      }
      if (findCareerOps()) ok(true, `career-ops ${findCareerOps()} (optional companion)`);
      for (const k of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) if (process.env[k]) ok(true, `${k} set`);
      break;
    }
    case 'ui': {
      const { serve } = await import('../src/ui/server.mjs');
      serve({ home, port: Number(opt.port || process.env.PORT || 4321), open: Boolean(opt.open) });
      break;
    }
    case 'agent': {
      const { detectAgents, readAgent, saveAgent } = await import('../src/agents.mjs');
      if (pos[0]) console.log(`selected ${saveAgent(home, pos[0])}`);
      const sel = readAgent(home);
      for (const a of Object.values(detectAgents())) {
        console.log(`${a.id === sel ? '●' : '○'} ${a.label.padEnd(12)} ${a.ready ? 'ready' : 'not set up'}${a.cli ? `  cli: ${a.cli}` : ''}${a.apiKey === null ? '' : `  api key: ${a.apiKey ? 'set' : 'missing'}`}`);
      }
      break;
    }
    case 'shortcut': {
      const { createShortcut } = await import('../src/shortcut.mjs');
      console.log(`created ${createShortcut({ home, cli: join(PKG, 'bin', 'apply-pilot.mjs'), port: Number(opt.port || 4321), dir: opt.dir })}`);
      console.log('Double-click it to start the panel and open it in your browser. Use the panel\'s Quit button to stop it.');
      break;
    }
    case 'list': {
      const q = String(opt.q || '').toLowerCase();
      for (const r of tracker().rows()) {
        if (opt.status && r.status.toLowerCase() !== String(opt.status).toLowerCase()) continue;
        if (q && !`${r.company} ${r.role} ${r.notes}`.toLowerCase().includes(q)) continue;
        console.log(`#${r.num}\t${r.status}\t${lastActivity(r)}\t${r.company} | ${r.role}`.slice(0, 160));
      }
      break;
    }
    case 'add': {
      if (!opt.company || !opt.role) throw new Error('add needs --company and --role');
      const t = tracker();
      const dupes = findDuplicates(t.rows(), { company: opt.company, role: opt.role, url: opt.url });
      if (dupes.length && !opt.force) {
        console.log(`possible duplicate of ${dupes.map((d) => `#${d.num} (${d.status})`).join(', ')}; re-run with --force to add anyway`);
        process.exitCode = 2; break;
      }
      const row = t.add({ company: opt.company, role: opt.role, url: opt.url, score: opt.score, status: opt.status, notes: opt.notes || '' });
      t.save();
      console.log(`added #${row.num} ${row.status} ${row.company} | ${row.role}`);
      break;
    }
    case 'status':
    case 'note': {
      const t = tracker();
      const num = Number(pos[0]);
      const status = cmd === 'note' ? t.get(num)?.status : pos[1];
      const text = cmd === 'note' ? pos.slice(1).join(' ') : opt.note;
      const { before, after, row } = t.setStatus(num, status, text);
      t.save();
      console.log(`#${row.num} ${row.company}: ${before} → ${after}${text ? ` (+ note)` : ''}`);
      break;
    }
    case 'followups': {
      const due = dueFollowUps(tracker().rows(), profile.followUp);
      if (opt.json) { console.log(JSON.stringify(due.map(({ row, f }) => ({ ...f, company: row.company, role: row.role })), null, 2)); break; }
      if (!due.length) { console.log('nothing due'); break; }
      for (const { row, f } of due) console.log(`#${row.num}\t${f.silentDays}d quiet\t${f.channel}\t${row.company} | ${row.role}`.slice(0, 160));
      break;
    }
    case 'eval': {
      const [sub, file] = pos;
      if (sub === 'prompt') { const pr = buildPrompt(profile, readFileSync(file, 'utf8')); console.log(`${pr.system}\n\n${pr.user}`); break; }
      if (sub === 'score') {
        const answer = parseModelJson(readFileSync(file, 'utf8'));
        console.log(JSON.stringify(finishEvaluation(profile, answer, opt.jd ? readFileSync(opt.jd, 'utf8') : ''), null, 2));
        break;
      }
      if (sub === 'run') {
        const jd = readFileSync(file, 'utf8');
        const res = await evaluateText(profile, jd, { provider: opt.provider || 'deepseek', model: opt.model, baseUrl: opt['base-url'] });
        console.log(JSON.stringify(res, null, 2));
        if (opt.add) {
          const t = tracker();
          const status = res.decision === 'Skip' ? 'SKIP' : 'Evaluated';
          const row = t.add({ company: res.company || '?', role: res.role || '?', score: `${res.score100}/100`, status, url: opt.url, notes: `${res.decision}; ${res.summary || ''}` });
          t.save();
          console.log(`added #${row.num}`);
        }
        break;
      }
      if (sub === 'pipeline') {
        // Evaluate pending "- [ ] url | company | role" lines of data/pipeline.md through a model API.
        const { fetchJd } = await import('../src/jd.mjs');
        const pipe = join(home, 'data', 'pipeline.md');
        const pending = existsSync(pipe) ? readFileSync(pipe, 'utf8').split(/\r?\n/).filter((l) => /^- \[ \] https?:\/\//.test(l)) : [];
        const items = pending.slice(-Number(opt.limit || 10)).reverse().map((l) => {
          const [url, company = '', role = ''] = l.replace(/^- \[ \] /, '').split(' | ').map((s) => s.trim());
          return { url, company, role };
        });
        const results = [];
        for (const it of items) {
          try {
            const jd = await fetchJd(it.url, { browser: Boolean(opt.browser) });
            const r = await evaluateText(profile, `${it.company}\n${it.role}\n\n${jd.text}`, { provider: opt.provider || 'deepseek', model: opt.model, baseUrl: opt['base-url'] });
            results.push({ ...it, ...r });
            console.log(`${r.score100}/100 ${r.decision}\t${it.company} | ${it.role}`);
          } catch (e) { results.push({ ...it, error: e.message }); console.log(`ERROR\t${it.company} | ${it.role}: ${e.message}`); }
        }
        mkdirSync(p.output, { recursive: true });
        const base = join(p.output, `agent-evaluation-${new Date().toLocaleDateString('sv-SE')}`);
        writeFileSync(`${base}.json`, JSON.stringify(results, null, 2));
        const md = ['| Company | Role | Score | Decision | Main gap | URL |', '|---|---|---|---|---|---|',
          ...results.map((r) => `| ${r.company} | ${r.role} | ${r.score100 ?? '–'} | ${r.decision || r.error || ''} | ${(r.gaps || [])[0] || ''} | ${r.url} |`),
          '', ...results.filter((r) => r.summary).map((r) => `**${r.company} — ${r.role}**: ${r.summary}`)].join('\n');
        writeFileSync(`${base}.md`, `${md}\n`);
        console.log(`${results.length} evaluated → ${base}.md`);
        break;
      }
      throw new Error('eval prompt|score|run|pipeline');
    }
    case 'lint': {
      let bad = 0;
      for (const f of pos) {
        const { issues, stats } = lintText(readFileSync(f, 'utf8'), profile);
        console.log(`${f}: ${issues.length} issue(s), ${stats.words} words, ${stats.sentences} sentences, mean ${stats.meanWords}`);
        for (const i of issues) console.log(`  - ${i.rule}: ${i.detail}`);
        bad += issues.length;
      }
      process.exitCode = bad ? 1 : 0;
      break;
    }
    case 'docx': {
      const [sub, a, b, c] = pos;
      if (sub === 'list') { (await readParagraphs(a)).forEach((t, i) => console.log(i, t.slice(0, 110))); break; }
      if (sub === 'build') { console.log('template sha256', await buildDocx(a, b, JSON.parse(readFileSync(c, 'utf8')))); break; }
      throw new Error('docx list|build');
    }
    case 'linkedin': {
      const li = await import('../src/scan/linkedin.mjs');
      if (pos[0] === 'login') { await li.login(profile, home); break; }
      if (pos[0] === 'scan') {
        const res = await li.scan(profile, home, { only: opt.jobs ? 'jobs' : opt.posts ? 'posts' : undefined });
        if (res.requiresLogin) { console.log('LOGIN_REQUIRED: run `apply-pilot linkedin login` and sign in yourself'); process.exitCode = 2; break; }
        console.log(`saved ${li.saveScan(res, p.inbox)}`);
        if (opt.pipeline) {
          const { appendPipeline } = await import('../src/additions.mjs');
          const t = triage(res, tracker().rows(), profile);
          console.log(`triage: ${t.fresh.length} new, ${t.tracked.length} already tracked; ${appendPipeline(join(home, 'data', 'pipeline.md'), t.fresh)} appended to data/pipeline.md`);
        }
        break;
      }
      throw new Error('linkedin login|scan');
    }
    case 'scan': {
      const kinds = pos[0] === 'all' ? ['portals', 'boards', 'websearch'] : [pos[0]];
      if (!kinds.every((k) => ['portals', 'boards', 'websearch'].includes(k))) throw new Error('scan portals|boards|websearch|all [--only NAME] [--engine brave|mojeek|searxng] [--pipeline]');
      const portals = await import('../src/scan/portals.mjs');
      const boards = await import('../src/scan/boards.mjs');
      for (const kind of kinds) {
        console.log(`\n== ${kind}`);
        const res = kind === 'portals' ? await portals.scanPortals(profile, { only: opt.only })
          : kind === 'boards' ? await boards.scanBoards(profile, { only: opt.only })
          : await boards.scanWebsearch(profile, { only: opt.only, engine: opt.engine });
        const file = boards.saveScan(res, p.inbox, kind);
        console.log(`${res.jobs.length} kept, ${Object.entries(res.skipped).map(([k, v]) => `${v} ${k}`).join(', ') || 'none filtered'}, ${res.errors.length} errors`);
        const silent = (res.perCompany || []).filter((c) => !c.error && c.found === 0).map((c) => c.company);
        if (silent.length) console.log(`0 found (check the board is still live): ${silent.join(', ')}`);
        if (res.websearch?.length) console.log(`${res.websearch.length} queries are for "apply-pilot scan websearch" (or your agent)`);
        console.log(`saved ${file}`);
        if (opt.pipeline) {
          const { appendPipeline } = await import('../src/additions.mjs');
          const t = triage(res, tracker().rows(), profile);
          const target = opt.pipeline === true ? join(home, 'data', 'pipeline.md') : resolve(opt.pipeline);
          console.log(`triage: ${t.fresh.length} new, ${t.tracked.length} already tracked, ${t.filtered.length} filtered; ${appendPipeline(target, t.fresh)} appended to ${target}`);
        }
      }
      break;
    }
    case 'import': {
      if (!pos[0]) throw new Error('import PATH [--write] [--json]  (a file or a folder)');
      const { previewImport, writeImport } = await import('../src/importer.mjs');
      const pv = await previewImport(pos[0], p.tracker);
      if (opt.json) { console.log(JSON.stringify(pv, null, 2)); if (!opt.write) break; }
      else {
        console.log(`${pv.input}: ${pv.files} file(s) scanned, ${pv.sources.length} table(s) recognised`);
        for (const s of pv.sources) console.log(`  - ${s.file}${s.sheet ? ` › ${s.sheet}` : ''}: ${s.rows} rows  ${JSON.stringify(s.mapping)}`);
        for (const e of pv.errors) console.log(`  ! ${e}`);
        console.log(`${pv.fresh.length} new, ${pv.duplicates.length} already in the tracker or repeated`);
        for (const r of pv.fresh.slice(0, 12)) console.log(`  + ${r.status.padEnd(9)} ${r.company} | ${r.role}`.slice(0, 150));
        if (pv.fresh.length > 12) console.log(`  … ${pv.fresh.length - 12} more`);
      }
      if (opt.write) {
        if (!existsSync(p.tracker)) tracker().save();
        const nums = writeImport(pv, p.tracker);
        console.log(`imported ${nums.length} row(s)${nums.length ? ` as #${nums[0]}–#${nums.at(-1)}` : ''} into ${p.tracker}`);
      } else console.log('Preview only. Add --write to append the new rows to the tracker.');
      break;
    }
    case 'jd': {
      const { fetchJd } = await import('../src/jd.mjs');
      const r = await fetchJd(pos[0], { browser: Boolean(opt.browser) });
      if (opt.out) { writeFileSync(opt.out, `${r.url}\n\n${r.text}\n`); console.log(`${r.source}: ${r.text.length} chars → ${opt.out}`); }
      else console.log(opt.json ? JSON.stringify(r, null, 2) : r.text);
      break;
    }
    case 'keywords': {
      const { extractKeywords, coverage, coverageMarkdown, htmlToText } = await import('../src/keywords.mjs');
      const cvFile = opt.cv || join(home, 'cv.md');
      const cv = readFileSync(cvFile, 'utf8');
      const cov = coverage(extractKeywords(readFileSync(pos[0], 'utf8')), /\.html?$/i.test(cvFile) ? htmlToText(cv) : cv);
      console.log(opt.json ? JSON.stringify(cov, null, 2) : coverageMarkdown(cov, opt.cv ? cvFile : 'cv.md (base CV, before per-role tailoring)'));
      break;
    }
    case 'merge-additions': {
      // Tab-separated tracker additions (header row: # Date Company Role Score Status PDF Report Notes ... url),
      // the batch format career-ops evaluations produce. Existing postings get a re-evaluation note instead.
      const { mergeAdditions } = await import('../src/additions.mjs');
      const res = mergeAdditions(tracker(), pos[0] || join(home, 'batch', 'tracker-additions'), { dryRun: Boolean(opt['dry-run']) });
      console.log(`${res.added.length} added, ${res.updated.length} updated, ${res.files} file(s)${opt['dry-run'] ? ' (dry run)' : ''}`);
      break;
    }
    case 'triage': {
      const res = triage(JSON.parse(readFileSync(pos[0], 'utf8')), tracker().rows(), profile);
      console.log(`${res.fresh.length} new, ${res.tracked.length} already tracked, ${res.filtered.length} filtered out`);
      for (const c of res.fresh) console.log(`- [${c.kind}] ${c.role} | ${c.company} ${c.url || c.people?.[0] || ''}`.slice(0, 200));
      if (opt.json) writeFileSync(opt.json, JSON.stringify(res, null, 2));
      if (opt.pipeline) {
        const { appendPipeline } = await import('../src/additions.mjs');
        const file = opt.pipeline === true ? join(home, 'data', 'pipeline.md') : resolve(opt.pipeline);
        console.log(`${appendPipeline(file, res.fresh)} appended to ${file}`);
      }
      break;
    }
    case 'export': {
      const { exportXlsx } = await import('../src/excel.mjs');
      console.log(`wrote ${await exportXlsx(tracker().rows(), resolve(pos[1] || 'applications.xlsx'))}`);
      break;
    }
    case 'careerops':
      process.exitCode = runCareerOps(pos[0], process.argv.slice(4), home);
      break;
    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);
      break;
    default:
      throw new Error(`unknown command "${cmd}" (try: apply-pilot help)`);
  }
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
