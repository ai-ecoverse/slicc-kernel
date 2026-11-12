import { test } from 'node:test';

const staging = process.env.STAGING_URL;

if (staging) {
  const url = new URL(staging);
  process.env.SLICC_CF_COMPUTER_URL = url.origin;
  process.env.SLICC_CF_COMPUTER_KEY = url.searchParams.get('key') ?? '';
  await import('./computer-cloudflare-example.test.mjs');
  await import('./computer-cloudflare-ports.test.mjs');
} else {
  test('the Computer example on the staging Worker', {
    skip: 'no STAGING_URL: the pull request pipeline deploys one with tools/cf-staging.mjs',
  });
}
