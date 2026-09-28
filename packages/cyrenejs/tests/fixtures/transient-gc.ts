import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';

import { Cyrene, ripple } from '../../src/index.ts';

let disposals = 0;
const plain = ripple('plain', () => ({}), { lifetime: 'transient' });
const callable = ripple('callable', () => () => {}, { lifetime: 'transient' });
const asynchronous = ripple('asynchronous', async () => ({}), { lifetime: 'transient' });

const borrowed = ripple(
  'borrowed',
  () => ({
    [Symbol.dispose]() {
      assert.fail('borrowed resource was disposed');
    },
  }),
  { lifetime: 'transient', ownership: 'borrowed' },
);

const owned = ripple(
  'owned',
  () => ({
    [Symbol.dispose]() {
      disposals++;
    },
  }),
  { lifetime: 'transient' },
);

const app = new Cyrene().use(plain, callable, asynchronous, borrowed, owned);
const disposable = new WeakRef(app.resolve(owned));

const collectable = [
  new WeakRef(app.resolve(plain)),
  new WeakRef(app.resolve(callable)),
  new WeakRef(await app.resolve(asynchronous)),
  new WeakRef(app.resolve(borrowed)),
];

/** 跨事件循环轮次执行 GC，避免 WeakRef 在当前任务内保活造成假阴性。 */
async function expectCollected(references: WeakRef<object>[]): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await setImmediate();
    globalThis.gc!();

    if (references.every(reference => reference.deref() === undefined)) {
      return;
    }
  }

  assert.fail('resolved transient objects are still strongly retained');
}

await expectCollected(collectable);
assert.ok(disposable.deref(), 'owned disposable was collected before disposal');
assert.equal(disposals, 0);
await app.dispose();
assert.equal(disposals, 1);
await expectCollected([disposable]);
