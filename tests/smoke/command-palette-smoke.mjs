import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const temporary = await mkdtemp(join(tmpdir(), 'commitscope-palette-'));
const repo = join(temporary, 'repository');
const worktree = join(temporary, 'linked-demo');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
let app;
try {
  await mkdir(repo);
  git('init', '-q', '-b', 'main');
  for (let i = 0; i < 4; i++) {
    await writeFile(join(repo, 'file.txt'), `version ${i}\n`);
    git('add', 'file.txt');
    git('-c', 'user.name=Palette', '-c', 'user.email=palette@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `palette commit ${i}`);
  }
  const head = git('rev-parse', 'HEAD');
  const target = git('rev-parse', 'HEAD~2');
  git('branch', 'feature/中文', target);
  git('tag', 'v-palette', target);
  git('worktree', 'add', '-q', '--detach', worktree, head);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Exercise the actual bundle, including the released daemon and generated protocol validators.
  app = await electron.launch({ executablePath: resolve(root, 'release/mac-arm64/CherryPeek.app/Contents/MacOS/CherryPeek'),
    args: [`--user-data-dir=${join(temporary, 'profile')}`], env, chromiumSandbox: true });
  const page = await app.firstWindow();
  await page.locator('[data-testid="core-status"][data-state="ready"]').waitFor({ timeout: 20_000 });
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, repo);
  const dialog = page.getByRole('dialog', { name: '快速跳转' });
  const input = page.getByRole('combobox', { name: '搜索命令或跳转目标' });
  const open = async query => {
    await page.keyboard.press('Meta+k');
    await input.waitFor();
    await input.fill(query);
  };
  const execute = async query => {
    await open(query);
    await page.getByRole('option').first().waitFor();
    await input.press('Enter');
    await dialog.waitFor({ state: 'hidden' });
  };

  // Works before a repository is open; only the native picker result is stubbed.
  await execute('打开仓库');
  await page.getByTestId('commit-row').first().waitFor({ timeout: 20_000 });
  const priorFocus = page.locator('input').first();
  await priorFocus.focus();
  await open('feature/中');
  await page.getByRole('option').filter({ hasText: 'feature/中文' }).waitFor();
  await input.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(element => element === document.activeElement, await priorFocus.elementHandle(), { timeout: 3_000 });

  await open('切换到');
  await page.getByRole('button', { name: '关闭快速跳转' }).focus();
  await page.keyboard.press('Meta+2');
  assert.equal(await page.getByTestId('page-commits').getAttribute('aria-current'), 'page', 'modal keyboard input must not reach the page behind it');
  await input.focus();
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await input.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true });
  await input.dispatchEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, isComposing: true });
  assert.equal(await dialog.isVisible(), true, 'IME composition cannot execute or close the palette');
  await input.dispatchEvent('compositionend');
  await input.press('ArrowDown');
  await input.press('Enter');
  await page.getByTestId('files-page').waitFor();
  assert.equal(await page.getByTestId('page-files').getAttribute('aria-current'), 'page');
  await execute('切换到提交页');

  await execute('feature/中');
  await page.waitForFunction(async () => (await window.commitScope.getRepositorySession()).value?.scope?.ref === 'refs/heads/feature/中文');
  await page.waitForFunction(() => document.querySelector('[data-testid="scope-picker"]')?.textContent.includes('feature/中文') && !document.querySelector('[data-testid="scope-picker"]').disabled);
  assert.equal(git('symbolic-ref', 'HEAD'), 'refs/heads/main');
  await execute('v-palette');
  await page.waitForFunction(async () => (await window.commitScope.getRepositorySession()).value?.scope?.ref === 'refs/tags/v-palette');
  await page.waitForFunction(() => document.querySelector('[data-testid="scope-picker"]')?.textContent.includes('v-palette') && !document.querySelector('[data-testid="scope-picker"]').disabled);
  await execute('linked-demo');
  await page.waitForFunction(async () => Boolean((await window.commitScope.getRepositorySession()).value?.scope?.worktree));
  await page.waitForFunction(() => document.querySelector('[data-testid="scope-picker"]')?.textContent.includes('linked-demo') && !document.querySelector('[data-testid="scope-picker"]').disabled);
  assert.equal(git('rev-parse', 'HEAD'), head);
  await execute('HEAD');
  await page.waitForFunction(async () => (await window.commitScope.getRepositorySession()).value?.scope === 'head');
  await page.waitForFunction(() => document.querySelector('[data-testid="scope-picker"]')?.textContent.includes('main') && !document.querySelector('[data-testid="scope-picker"]').disabled);
  await page.locator(`[data-testid="commit-row"][data-oid="${head}"]`).click();
  await execute(target.slice(0, 8).toUpperCase());
  await page.locator(`[data-testid="commit-row"][data-oid="${target}"][aria-selected="true"]`).waitFor({ timeout: 20_000 });
  await execute('复制当前提交');
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), target);

  await open('nothing-matches-this');
  await page.getByText('没有匹配的结果', { exact: true }).waitFor();
  await page.mouse.click(10, 100);
  await dialog.waitFor({ state: 'hidden' });
  // No top-bar button: ⌘K (listed in the shortcut guide) opens it again.
  await page.keyboard.press('Meta+KeyK');
  await dialog.waitFor();
  await input.fill('切换到');
  await mkdir(resolve(root, 'output/playwright'), { recursive: true });
  await page.screenshot({ path: resolve(root, 'output/playwright/p4-07-command-palette.png') });
  await input.press('Escape');
  assert.equal(git('symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.equal(git('status', '--porcelain'), '');
  console.log(JSON.stringify({ passed: true, bundle: true, openRepository: true, ime: true, focusRestored: true,
    scopeBrowsing: ['branch', 'tag', 'worktree'], shortHash: true, copiedCanonicalOid: true, pageSwitch: true, outsideDismiss: true, repositoryUnchanged: true }));
} finally {
  await app?.close().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
