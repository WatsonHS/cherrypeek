import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const temporary = await mkdtemp(join(tmpdir(), 'commitscope-patch-equivalence-'));
const repo = join(temporary, 'repository');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const commit = message => git('commit', '-q', '-m', message);
let app;
try {
  await mkdir(repo);
  git('init', '-q', '-b', 'main', '--object-format=sha256');
  git('config', 'user.name', 'Patch Test');
  git('config', 'user.email', 'patch@example.test');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(repo, 'file.txt'), 'root\n');
  git('add', 'file.txt'); commit('root');
  git('branch', 'merged');
  git('checkout', '-q', '-b', 'unmerged');
  await writeFile(join(repo, 'pending.txt'), 'not merged\n');
  git('add', 'pending.txt'); commit('pending');
  git('checkout', '-q', '-b', 'feature', 'main');
  for (const text of ['root\nfirst\n', 'root\nfirst\nsecond\n']) {
    await writeFile(join(repo, 'file.txt'), text);
    git('add', 'file.txt'); commit('feature change');
  }
  git('checkout', '-q', 'main');
  git('merge', '--squash', 'feature'); commit('squash feature');
  const head = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', head);
  const before = [git('show-ref'), git('status', '--porcelain=v1'), git('count-objects', '-v')];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: resolve(root, 'release/mac-arm64/CommitScope.app/Contents/MacOS/CommitScope'),
    args: [`--user-data-dir=${join(temporary, 'profile')}`, `--repository=${repo}`],
    env, chromiumSandbox: true,
  });
  const page = await app.firstWindow();
  await page.locator(`[data-testid="commit-row"][data-oid="${head}"]`).waitFor({ timeout: 30_000 });
  await page.getByTestId('scope-picker').click();
  const feature = page.locator('[data-ref-name="refs/heads/feature"]');
  await feature.getByText('内容已在 origin/main', { exact: true }).waitFor({ timeout: 20_000 });
  await page.locator('[data-ref-name="refs/heads/merged"]').getByText('已合入', { exact: true }).waitFor();
  const unmerged = page.locator('[data-ref-name="refs/heads/unmerged"]');
  assert.equal(await unmerged.locator('[data-slot="badge"]').count(), 0);
  await feature.getByTestId('handoff-cleanup').click();
  await page.getByTestId('handoff-subject').getByText(/已找到等价补丁/).waitFor();
  assert.equal(await page.getByTestId('handoff-blocked').count(), 0);
  await page.getByTestId('handoff-copy').click();
  assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /不是提交祖先关系[\s\S]*未被后续提交撤销/u);
  await mkdir(resolve(root, 'output/playwright'), { recursive: true });
  await page.screenshot({ path: resolve(root, 'output/playwright/p4-08-patch-handoff.png') });
  await page.getByTestId('handoff-close').click();
  await page.getByTestId('scope-picker').click();
  await feature.getByText('内容已在 origin/main', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(root, 'output/playwright/p4-08-patch-status.png') });
  assert.equal(git('symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.deepEqual([git('show-ref'), git('status', '--porcelain=v1'), git('count-objects', '-v')], before);
  console.log('Packaged SHA-256 patch-equivalence smoke passed: squash badge, ancestry badge, no negative badge, cleanup handoff, read-only repository.');
} finally {
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
