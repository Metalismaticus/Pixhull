// @ts-check
/**
 * Undo / redo for voxel edits.
 *
 * A stroke - everything between pointer-down and pointer-up - is one undo step,
 * which is what a drawing tool should do; nobody wants to press undo once per
 * voxel of a drag.
 *
 * Each entry stores the before and after state of only the voxels the stroke
 * touched, so a one-voxel dab costs eight bytes and dragging across a model
 * costs a few kilobytes, rather than snapshotting the whole volume.
 */

/**
 * @typedef {Object} VoxelState
 * @property {boolean} solid
 * @property {Uint8Array} faces six palette indices
 */

/**
 * @param {import('../core/volume.js').Volume} vol
 * @returns {VoxelState}
 */
function readVoxel(vol, x, y, z) {
  const faces = new Uint8Array(6);
  for (let d = 0; d < 6; d++) faces[d] = vol.getFace(x, y, z, d);
  return { solid: vol.get(x, y, z), faces };
}

/**
 * @param {import('../core/volume.js').Volume} vol
 * @param {VoxelState} s
 */
function writeVoxel(vol, x, y, z, s) {
  vol.set(x, y, z, s.solid);
  if (!s.solid) return;
  for (let d = 0; d < 6; d++) vol.setFace(x, y, z, d, s.faces[d]);
}

export class History {
  /** @param {number} limit how many strokes to keep */
  constructor(limit = 120) {
    this.limit = limit;
    /** @type {Array<Map<number, {x: number, y: number, z: number, before: VoxelState, after: VoxelState}>>} */
    this.stack = [];
    /** index of the next slot; everything at or after it is redoable */
    this.cursor = 0;
    /** @type {Map<number, {x: number, y: number, z: number, before: VoxelState, after: VoxelState}> | null} */
    this.pending = null;
  }

  get canUndo() {
    return this.cursor > 0;
  }

  get canRedo() {
    return this.cursor < this.stack.length;
  }

  /**
   * Has the user changed the model by hand since the last clear()?
   *
   * The history is cleared exactly where the volume is replaced, so "there is
   * something to undo" is the same question as "a rebuild would throw work
   * away". An open stroke counts too: the pointer can still be down when a
   * hotkey fires. Undoing everything back to the build makes this false again,
   * which is right - there is then nothing left to lose.
   */
  get hasEdits() {
    return this.cursor > 0 || !!(this.pending && this.pending.size > 0);
  }

  /** Open a stroke. Safe to call when one is already open. */
  begin() {
    if (!this.pending) this.pending = new Map();
  }

  /**
   * Snapshot a voxel before it changes. Only the first call per voxel per
   * stroke has any effect, so repeatedly painting the same voxel while dragging
   * stays cheap and still undoes to the state before the stroke.
   * @param {import('../core/volume.js').Volume} vol
   */
  touch(vol, x, y, z) {
    if (!this.pending) this.begin();
    const map = /** @type {Map<number, any>} */ (this.pending);
    const key = x + vol.nx * (y + vol.ny * z);
    if (map.has(key)) return;
    map.set(key, { x, y, z, before: readVoxel(vol, x, y, z), after: readVoxel(vol, x, y, z) });
  }

  /**
   * Close the stroke, capturing the result. A stroke that changed nothing is
   * dropped rather than filling the stack with no-ops.
   * @param {import('../core/volume.js').Volume} vol
   * @returns {boolean} true when something was recorded
   */
  commit(vol) {
    const map = this.pending;
    this.pending = null;
    if (!map || map.size === 0) return false;

    let changed = false;
    for (const e of map.values()) {
      e.after = readVoxel(vol, e.x, e.y, e.z);
      if (e.after.solid !== e.before.solid || !sameFaces(e.after.faces, e.before.faces)) changed = true;
    }
    if (!changed) return false;

    this.stack.length = this.cursor; // a new stroke drops the redo tail
    this.stack.push(map);
    if (this.stack.length > this.limit) this.stack.shift();
    this.cursor = this.stack.length;
    return true;
  }

  /** @param {import('../core/volume.js').Volume} vol @returns {boolean} */
  undo(vol) {
    if (!this.canUndo) return false;
    const map = this.stack[--this.cursor];
    for (const e of map.values()) writeVoxel(vol, e.x, e.y, e.z, e.before);
    return true;
  }

  /** @param {import('../core/volume.js').Volume} vol @returns {boolean} */
  redo(vol) {
    if (!this.canRedo) return false;
    const map = this.stack[this.cursor++];
    for (const e of map.values()) writeVoxel(vol, e.x, e.y, e.z, e.after);
    return true;
  }

  clear() {
    this.stack.length = 0;
    this.cursor = 0;
    this.pending = null;
  }
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function sameFaces(a, b) {
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return false;
  return true;
}
