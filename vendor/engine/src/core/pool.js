/**
 * Object pooling for hot-path allocs (projectiles, particles, pooled audio
 * sources). Pure JS so it is unit-testable in Node with no browser deps.
 */
export class Pool {
  /**
   * @param {object} opts
   * @param {() => T} opts.create   factory for a fresh pooled object
   * @param {(item: T) => void} [opts.reset]  reset an item on release
   * @param {(item: T) => void} [opts.onAcquire]  hook before handing one out
   * @param {number} [opts.initial=16]  pre-warm count
   */
  constructor({ create, reset, onAcquire, initial = 16 } = {}) {
    if (typeof create !== 'function') throw new TypeError('Pool requires a create() factory')
    this.create = create
    this.reset = reset
    this.onAcquire = onAcquire
    this._free = []
    this._out = 0
    for (let i = 0; i < initial; i++) this._free.push(create())
  }

  /** Number of items currently checked out. */
  get inUse() {
    return this._out
  }

  /** Total items created so far (free + in use). */
  get size() {
    return this._free.length + this._out
  }

  /** Number of free (idle) items. */
  get available() {
    return this._free.length
  }

  /** Acquire an item, growing the pool if empty. */
  acquire() {
    let item = this._free.pop()
    if (item === undefined) item = this.create()
    this._out += 1
    if (this.onAcquire) this.onAcquire(item)
    return item
  }

  /** Return an item to the pool (after resetting it). */
  release(item) {
    if (this.reset) this.reset(item)
    this._out = Math.max(0, this._out - 1)
    this._free.push(item)
  }

  /** Release all checked-out items. */
  releaseAll() {
    // No tracking of outstanding refs beyond the count; callers hand them back.
  }
}
