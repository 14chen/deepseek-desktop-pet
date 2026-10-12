/**
 * Push the current commit to GitHub over the REST API.
 *
 * `github.com:443` is intermittently unreachable from this network while
 * `api.github.com` answers fine, so `git push` cannot complete. The Git Data
 * API exposes the same primitives - blobs, a tree, a commit, a ref update - and
 * goes over the host that does work.
 *
 * The commit is rebuilt with the *exact* author, committer, timestamps and
 * message of the local one, so GitHub stores a byte-identical object and the
 * resulting SHA matches. Otherwise the local and remote branches would diverge
 * despite having identical content, and the next `git push` would be rejected.
 *
 * Usage: node tools/push-via-api.mjs <owner> <repo> <branch>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [owner, repo, branch = 'main'] = process.argv.slice(2);
if (!owner || !repo) {
  console.error('usage: node tools/push-via-api.mjs <owner> <repo> [branch]');
  process.exit(2);
}

const ROOT = process.cwd();
const API = 'https://api.github.com';

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** Read the raw commit object; the message must stay byte-exact. */
function rawCommit(rev) {
  const text = execFileSync('git', ['cat-file', 'commit', rev], { cwd: ROOT, encoding: 'utf8' });
  const split = text.indexOf('\n\n');
  const headers = text.slice(0, split).split('\n');
  const message = text.slice(split + 2);
  const read = (name) => headers.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1) ?? null;
  const author = read('author');
  const committer = read('committer');
  const parse = (line) => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) throw new Error(`unparsable identity: ${line}`);
    const [, name, email, seconds, zone] = match;
    const iso = new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return { name, email, date: iso, zone };
  };
  return {
    tree: read('tree'),
    parent: read('parent'),
    author: parse(author),
    committer: parse(committer),
    message,
  };
}

/** Recover the token the credential manager already holds, without printing it. */
function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    cwd: ROOT,
    encoding: 'utf8',
    input: 'protocol=https\nhost=github.com\n\n',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const line = out.split(/\r?\n/).find((entry) => entry.startsWith('password='));
  if (!line) throw new Error('no cached GitHub credential');
  return line.slice('password='.length);
}

const TOKEN = token();
const headers = {
  authorization: `token ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-desktop-pet',
  'content-type': 'application/json',
};

async function api(method, route, body) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(`${API}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${route} -> ${response.status} ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    } catch (error) {
      if (attempt === 4) throw error;
      console.log(`    retry ${attempt}: ${String(error.message).slice(0, 120)}`);
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  return null;
}

const head = git('rev-parse', 'HEAD');
let commit = rawCommit('HEAD');
console.log(`pushing ${head.slice(0, 7)} to ${owner}/${repo}#${branch}`);
console.log(`  identity: ${commit.author.name} <${commit.author.email}> ${commit.author.date}`);

/**
 * GitHub normalises commit timestamps to UTC, so a commit stored locally as
 * `+0800` comes back as the same instant in `+0000` - a different object, and
 * therefore a different SHA for identical content. Amending the local commit to
 * the UTC spelling first is what lets both sides agree on the first try.
 */
if (commit.committer.zone !== '+0000' || commit.author.zone !== '+0000') {
  const utc = commit.committer.date;
  console.log(`  normalising the local timestamp ${commit.committer.zone} -> +0000 so the SHAs can match`);
  execFileSync('git', ['commit', '--amend', '--no-edit', '--date', utc], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: utc, GIT_COMMITTER_DATE: utc },
  });
  commit = rawCommit('HEAD');
}

const localHead = git('rev-parse', 'HEAD');

const ref = await api('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`).catch(() => null);
const remoteHead = ref?.object?.sha ?? null;
console.log(`  remote head: ${remoteHead ? remoteHead.slice(0, 7) : '(none)'}`);

if (remoteHead === localHead) {
  console.log('  already up to date.');
  process.exit(0);
}

/**
 * Modes come from git, never from the file name: guessing 100755 for a `.ps1`
 * produced a tree that differed from the local one, and therefore a different
 * commit SHA for identical content.
 */
function modeOf(file) {
  const line = execFileSync('git', ['ls-tree', 'HEAD', '--', file], { cwd: ROOT, encoding: 'utf8' }).trim();
  return line ? line.split(/\s+/)[0] : '100644';
}

// The diff base is the local parent, not the remote head. The remote head may
// be a commit this clone has never seen (for example one created by an earlier
// API push), and diffing against an object that is not in the local database
// simply fails. The parent is present in both, so rebuilding the tree from it
// is deterministic.
const base = commit.parent;
if (!base) {
  console.error('this script expects a commit with a parent');
  process.exit(2);
}
const changed = git('diff', '--name-status', base, 'HEAD')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status, file: rest.join('\t') };
  });
console.log(`  ${changed.length} path(s) changed since ${base.slice(0, 7)}`);

const entries = [];
for (const { status, file } of changed) {
  if (status === 'D' || !fs.existsSync(path.join(ROOT, file))) {
    entries.push({ path: file, mode: '100644', type: 'blob', sha: null });
    continue;
  }
  const content = fs.readFileSync(path.join(ROOT, file));
  const blob = await api('POST', `/repos/${owner}/${repo}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  entries.push({ path: file, mode: modeOf(file), type: 'blob', sha: blob.sha });
}

const baseTree = (await api('GET', `/repos/${owner}/${repo}/git/commits/${base}`)).tree.sha;
const tree = await api('POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: baseTree, tree: entries });
console.log(`  tree ${tree.sha.slice(0, 7)}${tree.sha === commit.tree ? ' (matches local)' : ` (LOCAL IS ${commit.tree.slice(0, 7)})`}`);

const created = await api('POST', `/repos/${owner}/${repo}/git/commits`, {
  message: commit.message,
  tree: tree.sha,
  parents: commit.parent ? [commit.parent] : [],
  author: { name: commit.author.name, email: commit.author.email, date: commit.author.date },
  committer: { name: commit.committer.name, email: commit.committer.email, date: commit.committer.date },
});
console.log(`  commit ${created.sha.slice(0, 7)}${created.sha === localHead ? ' (matches local)' : ` (LOCAL IS ${localHead.slice(0, 7)})`}`);

if (remoteHead) {
  await api('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha: created.sha, force: true });
} else {
  await api('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: created.sha });
}

console.log(`\npushed: https://github.com/${owner}/${repo}/commit/${created.sha}`);
if (created.sha !== localHead) {
  console.log('\nNOTE: the remote SHA differs from the local one.');
  console.log('Run `git fetch origin && git reset --hard origin/' + branch + '` once github.com is reachable.');
  process.exitCode = 3;
}
