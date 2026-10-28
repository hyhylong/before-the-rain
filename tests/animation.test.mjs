import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ActionScheduler, characterSchema, DEFAULT_CHARACTER, EmotionMixer, mouthShape, PresenceMotion } from '../src/scene/animation.mjs';
import { CueTimeline } from '../src/media/timeline.mjs';

test('character config validates adult identity, local resources and action limits', async () => {
  const config = JSON.parse(await readFile(new URL('../public/character.json', import.meta.url), 'utf8'));
  assert.equal(characterSchema.parse(config).identity.age, 26);
  assert.throws(() => characterSchema.parse({ ...config, identity: { name: 'Mira', age: 17 } }));
  assert.throws(() => characterSchema.parse({ ...config, resources: { ...config.resources, photo: 'https://untrusted.example/picture.png' } }));
});

test('listening and thinking preempt story gestures and invalidate old epoch actions', () => {
  const scheduler = new ActionScheduler();
  assert.equal(scheduler.update({ status: 'speaking', gesture: 'showPhoto' }).name, 'showPhoto');
  const epoch = scheduler.epoch;
  assert.equal(scheduler.update({ status: 'listening', gesture: 'showPhoto' }).name, 'listening');
  assert.equal(scheduler.request('late-photo', 'showPhoto', { epoch }), false);
  assert.equal(scheduler.update({ status: 'thinking', gesture: 'wave' }).name, 'thinking');
  assert.equal(scheduler.update({ status: 'idle', gesture: 'idle' }).name, 'idle');
});

test('configured priorities and expiration arbitrate actions deterministically', () => {
  const scheduler = new ActionScheduler(DEFAULT_CHARACTER);
  scheduler.update({ status: 'speaking', gesture: 'nod' });
  scheduler.request('photo', 'showPhoto', { expires: 5 });
  assert.equal(scheduler.update({ status: 'speaking', gesture: 'nod' }, 4).name, 'showPhoto');
  assert.equal(scheduler.update({ status: 'speaking', gesture: 'nod' }, 6).name, 'nod');
});

test('emotion transitions blend and vowel shapes have genuinely different widths', () => {
  const mixer = new EmotionMixer();
  const weights = mixer.step('melancholy', 0.1);
  assert.ok(weights.curious > 0 && weights.melancholy > 0);
  assert.ok(Math.abs(Object.values(weights).reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  assert.ok(mouthShape({ ee: 1 }, 0.8).width > mouthShape({ oo: 1 }, 0.8).width);
  assert.equal(mouthShape({ aa: 1, closed: 1 }, 1).height, 0.006);
  assert.equal(mouthShape({ aa: 1 }, 0).height, 0.006);
});

test('a held nod completes one movement and a held wave eases back to rest', () => {
  const nod = new PresenceMotion();
  nod.step(10, 0, { action: 'nod' });
  assert.equal(nod.step(10, 0, { action: 'nod' }).nod, 0);
  assert.ok(nod.step(10.175, 0.05, { action: 'nod' }).nod > 0.02);
  assert.ok(nod.step(10.7, 0.05, { action: 'nod' }).nod < -0.02);
  assert.equal(nod.step(11.1, 0.05, { action: 'nod' }).nod, 0);
  assert.equal(nod.step(30, 0.05, { action: 'nod' }).nod, 0);

  const wave = new PresenceMotion();
  assert.equal(wave.step(10, 0, { action: 'wave' }).wave, 0);
  const rising = wave.step(10.2, 0.05, { action: 'wave' }).wave;
  assert.ok(rising > 0 && rising < 1);
  assert.equal(wave.step(10.5, 0.05, { action: 'wave' }).wave, 1);
  const falling = wave.step(12.2, 0.05, { action: 'wave' }).wave;
  assert.ok(falling > 0 && falling < 1);
  assert.equal(wave.step(12.7, 0.05, { action: 'wave' }).wave, 0);
  assert.equal(wave.step(30, 0.05, { action: 'wave' }).wave, 0);
});

test('interrupting a gesture resets its envelope before a fresh gesture starts', () => {
  const scheduler = new ActionScheduler();
  const presence = new PresenceMotion();
  const step = (now, status, gesture) => {
    const action = scheduler.update({ status, gesture }, now);
    return { action, pose: presence.step(now, 0.05, { action: action.name }) };
  };
  step(10, 'speaking', 'wave');
  const waving = step(10.8, 'speaking', 'wave');
  assert.equal(waving.pose.wave, 1);
  const epoch = waving.action.epoch;
  const interrupted = step(10.9, 'listening', 'wave');
  assert.equal(interrupted.action.name, 'listening');
  assert.equal(interrupted.pose.age, 0);
  assert.equal(scheduler.request('late-wave', 'wave', { epoch }), false);
  assert.equal(step(11.5, 'thinking', 'wave').action.name, 'thinking');
  const restarted = step(12, 'speaking', 'wave');
  assert.equal(restarted.pose.age, 0);
  assert.equal(restarted.pose.wave, 0);
  assert.ok(step(12.2, 'speaking', 'wave').pose.wave < 1);
});

test('gaze leads the head while body shifts and speech amplitude ease gradually', () => {
  const presence = new PresenceMotion();
  const first = presence.step(0, 1 / 60, { level: 1 });
  assert.ok(first.gazeX > first.headYaw && first.headYaw > 0);
  assert.ok(first.shift < 0 && first.shift > presence.targetShift);
  assert.ok(first.audio > 0 && first.audio < 0.2);
  const moving = presence.step(1 / 60, 1 / 60, { level: 1 });
  assert.ok(moving.gazeX > first.gazeX && moving.headYaw > first.headYaw);
  assert.ok(moving.audio > first.audio && moving.audio < 1);
  const quiet = presence.step(2 / 60, 1 / 60, { level: 0 });
  assert.ok(quiet.audio > 0 && quiet.audio < moving.audio);
  assert.ok(Math.abs(quiet.shift - moving.shift) < 0.003);

  const whole = new PresenceMotion().step(0, 1 / 30, { level: 1 });
  assert.ok(Math.abs(whole.gazeX - moving.gazeX) < 1e-12);
  assert.ok(Math.abs(whole.shift - moving.shift) < 1e-12);
  assert.ok(Math.abs(whole.audio - moving.audio) < 1e-12);
});

test('blink timing is staggered and gaze changes use varied bounded intervals', () => {
  const presence = new PresenceMotion();
  presence.nextBlink = 0;
  presence.step(0.01, 0.01);
  const closing = presence.step(0.075, 0.01);
  assert.ok(closing.blinkLeft < closing.blinkRight);
  assert.ok(closing.blinkLeft >= 0.02 && closing.blinkRight <= 1);
  const open = presence.step(0.3, 0.01);
  assert.equal(open.blinkLeft, 1);
  assert.equal(open.blinkRight, 1);
  const targets = [];
  const intervals = [];
  let previousDeadline = presence.nextGaze;
  for (let frame = 1; frame <= 600; frame++) {
    const now = frame / 10;
    const pose = presence.step(now, 0.1);
    assert.ok(Math.abs(pose.gazeX) <= 0.6 && Math.abs(pose.gazeY) <= 0.225);
    assert.ok(pose.blinkLeft >= 0.02 && pose.blinkLeft <= 1);
    assert.ok(pose.blinkRight >= 0.02 && pose.blinkRight <= 1);
    if (presence.nextGaze !== previousDeadline) {
      targets.push(presence.targetGazeX);
      intervals.push(presence.nextGaze - now);
      previousDeadline = presence.nextGaze;
    }
  }
  assert.ok(new Set(targets).size > 8);
  assert.ok(new Set(intervals.map((interval) => interval.toFixed(2))).size > 8);
  assert.ok(intervals.every((interval) => interval >= 1.6 && interval <= 4.9));
});

test('timeline seeking skips obsolete effects and cancellation suppresses late cues', () => {
  const timeline = new CueTimeline([{ at: 0, text: 'start' }, { at: 3, effect: 'shutter' }, { at: 6, text: 'end' }]);
  assert.equal(timeline.advance(1).length, 1);
  assert.equal(timeline.advance(2).length, 0);
  assert.equal(timeline.seek(4).at(-1).effect, 'shutter');
  assert.equal(timeline.advance(4).length, 0);
  assert.equal(timeline.advance(7).at(-1).text, 'end');
  timeline.cancel();
  assert.deepEqual(timeline.advance(100), []);
  assert.deepEqual(timeline.seek(0), []);
});
