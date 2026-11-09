import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
const temporary = await mkdtemp(join(tmpdir(), 'commitscope-narrow-'));
const repo = join(temporary, 'repository');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
let app;
try {
  await mkdir(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Narrow Test');
  git('config', 'user.email', 'narrow@example.test');
  git('config', 'commit.gpgsign', 'false');
  for (let i = 0; i < 90; i++) {
    await writeFile(join(repo, 'file.txt'), `version ${i}\n`);
    git('add', 'file.txt');
    git('commit', '-q', '-m', `fixture ${String(i).padStart(2, '0')}`);
  }
  const head = git('rev-parse', 'HEAD');
  const refs = git('show-ref');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: resolve(root, 'release/mac-arm64/CommitScope.app/Contents/MacOS/CommitScope'),
    args: [`--user-data-dir=${join(temporary, 'profile')}`, `--repository=${repo}`], env, chromiumSandbox: true,
  });
  const page = await app.firstWindow();
  const resize = async width => {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), width);
    await page.waitForFunction(width => document.querySelector('[data-testid="history-split-view"]')?.dataset.layout === (width < 1100 ? 'narrow' : 'split'), width);
  };
  const pane = page.getByTestId('commit-detail-pane');
  const list = page.getByRole('listbox', { name: '提交', exact: true });
  const selected = () => page.locator('[data-testid="commit-row"][aria-selected="true"]').getAttribute('data-oid');
  await page.locator(`[data-testid="commit-row"][data-oid="${head}"]`).waitFor({ timeout: 30_000 });
  await resize(1180);
  await list.evaluate(element => { element.scrollTop = 650; });
  const target = git('rev-parse', 'HEAD~14');
  await page.locator(`[data-testid="commit-row"][data-oid="${target}"]`).click();
  await page.waitForFunction(oid => document.querySelector('[data-testid="commit-row"][aria-selected="true"]')?.getAttribute('data-oid') === oid, target);
  const anchor = await list.evaluate(element => { window.narrowTestList = element; return element.scrollTop; });
  const sidebarWidth = (await page.getByTestId('history-sidebar').boundingBox()).width;
  await resize(900);
  await pane.waitFor({ state: 'hidden' });
  assert.equal(await selected(), target);
  assert.equal(await list.evaluate(element => element === window.narrowTestList), true);
  assert.ok(Math.abs(await list.evaluate(element => element.scrollTop) - anchor) < 1);
  assert.ok((await page.getByTestId('history-sidebar').boundingBox()).width >= 890);

  await list.focus();
  await list.press('ArrowDown');
  assert.equal(await pane.isVisible(), false, 'arrow keys select without opening');
  const next = await selected();
  assert.notEqual(next, target);
  await list.press('Enter');
  await pane.waitFor();
  assert.equal(await page.getByRole('button', { name: '关闭详情', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.getByRole('button', { name: '上一个提交', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(oid => document.querySelector('[data-testid="commit-row"][aria-selected="true"]')?.getAttribute('data-oid') === oid, target);
  await page.getByRole('button', { name: '下一个提交', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(oid => document.querySelector('[data-testid="commit-row"][aria-selected="true"]')?.getAttribute('data-oid') === oid, next);
  await page.keyboard.press('Escape');
  await pane.waitFor({ state: 'hidden' });
  assert.equal(await list.evaluate(element => element === document.activeElement), true);
  await page.locator(`[data-testid="commit-row"][data-oid="${next}"]`).click();
  await pane.waitFor();
  await mkdir(resolve(root, 'output/playwright'), { recursive: true });
  await page.screenshot({ path: resolve(root, 'output/playwright/p4-06-narrow-detail.png') });
  await page.keyboard.press('Meta+k');
  await page.getByRole('dialog', { name: '快速跳转' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '快速跳转' }).waitFor({ state: 'hidden' });
  assert.equal(await pane.isVisible(), true, 'Escape closes only the upper dialog');
  await page.getByTestId('detail-drawer-backdrop').click({ position: { x: 10, y: 100 } });
  await pane.waitFor({ state: 'hidden' });
  assert.ok(Math.abs(await list.evaluate(element => element.scrollTop) - anchor) < 1);

  await page.keyboard.press('Meta+f');
  await page.getByTestId('search-input').fill('fixture');
  await page.waitForFunction(() => document.querySelector('[data-testid="search-status"]')?.textContent.includes('90'), undefined, { timeout: 20_000 });
  await page.keyboard.press('Escape');
  const searchList = page.getByRole('listbox', { name: '搜索提交', exact: true });
  await searchList.evaluate(element => { element.scrollTop = 450; window.narrowTestSearch = element; });
  const searchOid = await searchList.getByRole('option').nth(8).getAttribute('data-oid');
  const result = page.locator(`[data-testid="search-result-${searchOid}"]`);
  await result.focus();
  await result.press('Enter');
  await pane.waitFor();
  const searchAnchor = await searchList.evaluate(element => element.scrollTop);
  await page.keyboard.press('Escape');
  await pane.waitFor({ state: 'hidden' });
  assert.equal(await result.evaluate(element => element === document.activeElement), true);
  await result.press('Enter');
  await pane.waitFor();
  await resize(1180);
  assert.equal(await pane.isVisible(), true);
  assert.equal(await page.getByTestId('detail-drawer-backdrop').count(), 0);
  assert.equal(await searchList.evaluate(element => element === window.narrowTestSearch), true);
  assert.ok(Math.abs(await searchList.evaluate(element => element.scrollTop) - searchAnchor) < 1);
  assert.ok(Math.abs((await page.getByTestId('history-sidebar').boundingBox()).width - sidebarWidth) < 1);
  await resize(900);
  await pane.waitFor({ state: 'hidden' });
  assert.equal(await page.locator(`[data-testid="search-result-${searchOid}"]`).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Meta+k');
  await page.getByRole('combobox', { name: '搜索命令或跳转目标' }).fill(target.slice(0, 8));
  await page.keyboard.press('Enter');
  await pane.waitFor();
  await page.waitForFunction(oid => document.querySelector('[data-testid="commit-row"][aria-selected="true"]')?.getAttribute('data-oid') === oid, target);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(git('show-ref'), refs);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('status', '--porcelain'), '');
  console.log('Packaged narrow-history smoke passed: resize preserves nodes, selection and anchors; history/search keyboard activation, previous/next, focus return, same-row reopen, layered Escape, backdrop, read-only repository.');
} finally {
  await app?.close();
  await rm(temporary, { recursive: true, force: true });
}
