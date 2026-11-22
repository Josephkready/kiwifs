import { describe, expect, it, vi } from 'vitest';
import { ReadAlongSession } from './readAlongSession';

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


const chunks = [{ index: 0, text: 'ab', base: 0 }];

const settle = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(cond()).toBe(true);
};

function setup(poll: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const f = vi.fn((url: string) => {
    if (url.endsWith('/synthesize')) return json(202, { status: 'pending', job_id: 'j1', status_url: '/synthesize/jobs/j1' });
    if (url.includes('/synthesize/jobs/')) return json(200, poll);
    return json(404, {});
  }) as unknown as typeof fetch;
  const audio = new FakeAudio();
  return new ReadAlongSession({
    endpoint: '/api/speech',
    chunks,
    fetchImpl: f,
    audio: audio as unknown as HTMLAudioElement,
    pollMs: 1,
    ...extra,
  });
}

describe('job failure paths', () => {
  it('surfaces a job error status as a per-chunk error', async () => {
    const s = setup({ status: 'error', error: 'boom' });
    s.start();
    await settle(() => s.getState().chunks[0].status === 'error');
    expect(s.getState().chunks[0].error).toBe('boom');
    expect(s.getState().error?.message).toBe('boom');
    s.stop();
  });

  it('times out a job that never completes', async () => {
    const s = setup({ status: 'pending' }, { pollTimeoutMs: 1 });
    s.start();
    await settle(() => s.getState().chunks[0].status === 'error');
    expect(s.getState().chunks[0].error).toBe('speech job timed out');
    s.stop();
  });
});
