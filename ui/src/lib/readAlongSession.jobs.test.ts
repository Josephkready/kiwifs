import { describe, expect, it, vi } from 'vitest';
import { ReadAlongSession, type SpeechWord } from './readAlongSession';

class FakeAudio extends EventTarget {
  src = '';
  currentTime = 0;
  duration = NaN;
  playbackRate = 1;
  paused = true;
  ended = false;
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(a: string) {
    if (a === 'src') this.src = '';
  }
}

const json = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

const words: SpeechWord[] = [
  { word: 'ab', start: 0, end: 0.9, char_offset: 0 },
  { word: 'ab', start: 1, end: 1.9, char_offset: 3 },
  { word: 'ab', start: 2, end: 2.9, char_offset: 6 },
];

const chunks = [{ index: 0, text: 'ab ab ab', base: 0 }];

const settle = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(cond()).toBe(true);
};

function setup(pending: Record<string, unknown>, poll: Record<string, unknown>) {
  const urls: string[] = [];
  const f = vi.fn((url: string) => {
    urls.push(url);
    if (url.endsWith('/synthesize')) return json(202, pending);
    if (url.includes('/synthesize/jobs/')) return json(200, poll);
    return json(404, {});
  }) as unknown as typeof fetch;
  const audio = new FakeAudio();
  const s = new ReadAlongSession({
    endpoint: '/api/speech/',
    chunks,
    fetchImpl: f,
    audio: audio as unknown as HTMLAudioElement,
    pollMs: 1,
  });
  return { s, urls };
}

const complete = { status: 'complete', result: { id: 'item1', words } };

describe('jobUrl re-rooting', () => {
  it('re-roots a relative status_url under the endpoint', async () => {
    const { s, urls } = setup({ status: 'pending', job_id: 'j1', status_url: '/synthesize/jobs/j1' }, complete);
    s.start();
    await settle(() => s.getState().chunks[0].status === 'ready');
    expect(urls).toContain('/api/speech/synthesize/jobs/j1');
    s.stop();
  });

  it('keeps only the path of an absolute status_url', async () => {
    const { s, urls } = setup(
      { status: 'pending', job_id: 'j1', status_url: 'http://upstream:8000/synthesize/jobs/j1' },
      complete,
    );
    s.start();
    await settle(() => s.getState().chunks[0].status === 'ready');
    expect(urls).toContain('/api/speech/synthesize/jobs/j1');
    expect(urls.some((u) => u.includes('upstream'))).toBe(false);
    s.stop();
  });

  it('falls back to job_id when status_url is missing', async () => {
    const { s, urls } = setup({ status: 'pending', job_id: 'j2' }, complete);
    s.start();
    await settle(() => s.getState().chunks[0].status === 'ready');
    expect(urls).toContain('/api/speech/synthesize/jobs/j2');
    s.stop();
  });
});
