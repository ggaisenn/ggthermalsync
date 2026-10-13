const assert = require('node:assert/strict');
const RingBuffer = require('../src/store/ringBuffer');

describe('RingBuffer', () => {
  it('starts empty and returns an empty snapshot', () => {
    const buffer = new RingBuffer(3);

    assert.equal(buffer.size, 0);
    assert.deepEqual(buffer.snapshot(), []);
  });

  it('returns inserted frames in chronological order', () => {
    const buffer = new RingBuffer(3);
    const frames = [{ id: 1 }, { id: 2 }, { id: 3 }];

    frames.forEach((frame) => buffer.push(frame));

    assert.deepEqual(buffer.snapshot(), frames);
  });

  it('overwrites the oldest frame when capacity is reached', () => {
    const buffer = new RingBuffer(3);
    [1, 2, 3, 4, 5].forEach((id) => buffer.push({ id }));

    assert.equal(buffer.size, 3);
    assert.deepEqual(buffer.snapshot(), [{ id: 3 }, { id: 4 }, { id: 5 }]);
  });

  it('returns the most recent frames when a snapshot limit is provided', () => {
    const buffer = new RingBuffer(4);
    [1, 2, 3, 4].forEach((id) => buffer.push({ id }));

    assert.deepEqual(buffer.snapshot(2), [{ id: 3 }, { id: 4 }]);
  });

  it('rejects invalid capacities and snapshot limits', () => {
    assert.throws(() => new RingBuffer(0), TypeError);
    assert.throws(() => new RingBuffer(1.5), TypeError);

    const buffer = new RingBuffer(2);
    assert.throws(() => buffer.snapshot(-1), TypeError);
    assert.throws(() => buffer.snapshot(1.5), TypeError);
  });
});
