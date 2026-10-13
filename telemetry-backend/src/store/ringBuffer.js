class RingBuffer {
  constructor(capacity = 3600) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError('RingBuffer capacity must be a positive integer');
    }

    this.capacity = capacity;
    this.frames = new Array(capacity);
    this.nextIndex = 0;
    this.size = 0;
  }

  push(frame) {
    this.frames[this.nextIndex] = frame;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
  }

  snapshot(limit = this.size) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new TypeError('RingBuffer snapshot limit must be a non-negative integer');
    }

    const count = Math.min(limit, this.size);
    const firstIndex = (this.nextIndex - count + this.capacity) % this.capacity;
    return Array.from({ length: count }, (_, offset) => (
      this.frames[(firstIndex + offset) % this.capacity]
    ));
  }

  toArray(limit = this.size) {
    return this.snapshot(limit);
  }
}

module.exports = RingBuffer;
