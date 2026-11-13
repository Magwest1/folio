import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadPrimaryFeedConfig } from '../electron/primary-feed.js';
import { afterPack } from '../scripts/macos-update-config.mjs';

const readFileReturning = (contents) => async () => contents;

test('returns a valid github feed config', async () => {
  const config = await loadPrimaryFeedConfig({
    resourcesPath: '/res',
    readFileImpl: readFileReturning('provider: github\nowner: me\nrepo: folio\nupdaterCacheDirName: folio-updater\n'),
  });
  assert.deepEqual(config, { provider: 'github', owner: 'me', repo: 'folio', updaterCacheDirName: 'folio-updater' });
});

test('reads app-update.yml from the resources path', async () => {
  let requested;
  await loadPrimaryFeedConfig({
    resourcesPath: '/res',
    readFileImpl: async (file) => {
      requested = file;
      return 'provider: generic\nurl: https://example.com\n';
    },
  });
  assert.equal(requested, path.join('/res', 'app-update.yml'));
});

test('rejects when the file is missing', async () => {
  await assert.rejects(
    loadPrimaryFeedConfig({
      resourcesPath: '/res',
      readFileImpl: async () => {
        throw new Error('ENOENT');
      },
    }),
    /Could not read the update feed config/,
  );
});

test('rejects without a resources path', async () => {
  await assert.rejects(loadPrimaryFeedConfig({ readFileImpl: readFileReturning('provider: github') }), /resources path/);
});

for (const [name, contents] of [
  ['invalid YAML', 'provider: [unclosed'],
  ['a non-object document', '- a\n- b\n'],
  ['a scalar document', 'just text'],
  ['an empty document', ''],
  ['a missing provider', 'owner: me\nrepo: folio\n'],
  ['an empty provider', 'provider: ""\n'],
  ['github without owner', 'provider: github\nrepo: folio\n'],
  ['github without repo', 'provider: github\nowner: me\n'],
]) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(loadPrimaryFeedConfig({ resourcesPath: '/res', readFileImpl: readFileReturning(contents) }), Error);
  });
}

test('loads the config written by the macOS afterPack hook', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const appPath = await mkdtemp(path.join(tmpdir(), 'folio-primary-feed-'));
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  await mkdir(resourcesPath, { recursive: true });

  try {
    await afterPack({
      electronPlatformName: 'darwin',
      appOutDir: appPath,
      packager: {
        config: { publish: packageJson.build.publish },
        appInfo: { name: packageJson.name },
        getResourcesDir: (outputPath) => path.join(outputPath, 'Contents', 'Resources'),
      },
    });
    const config = await loadPrimaryFeedConfig({ resourcesPath });
    assert.equal(config.provider, packageJson.build.publish.provider);
    assert.equal(config.owner, packageJson.build.publish.owner);
    assert.equal(config.repo, packageJson.build.publish.repo);
  } finally {
    await rm(appPath, { recursive: true, force: true });
  }
});

test('electron sources never read build config from package.json at runtime', async () => {
  // electron-builder strips `build` from the packaged package.json.
  const dir = new URL('../electron/', import.meta.url);
  const files = (await readdir(dir)).filter((file) => /\.(c|m)?js$/.test(file));
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = await readFile(new URL(file, dir), 'utf8');
    assert.doesNotMatch(source, /packageMetadata\.build/, `${file} must not read packageMetadata.build`);
  }
});
