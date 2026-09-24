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

/**
 * @typedef {Map<number, {x: number, y: number, z: number, before: VoxelState, after: VoxelState}>} StrokeMap
 */

/**
 * @typedef {{ids: Int32Array, offsets: Int32Array, before: Uint8Array, changed: number}} FaceRecord
 * @typedef {ReturnType<import('../core/palette.js').Palette['snapshot']>} PaletteState
 */

/**
 * One undoable step. Entries are tagged because the stack carries unrelated
 * kinds of change, and undo has to know which object to write to.
 *
 * A merge is its own kind for a reason: it rewrites face bytes *and* the
 * palette, and it is many-to-one, so it cannot be undone by running the map
 * backwards. It carries the old face bytes and both palette states instead.
 * @typedef {{kind: 'voxels', map: StrokeMap}
 *   | {kind: 'palette', index: number, before: number, after: number}
 *   | {kind: 'merge', remap: Uint8Array, record: FaceRecord,
 *      before: PaletteState, after: PaletteState}} Entry
 */

export class History {
  /** @param {number} limit how many strokes to keep */
  constructor(limit = 120) {
    this.limit = limit;
    /** @type {Entry[]} */
    this.stack = [];
    /** index of the next slot; everything at or after it is redoable */
    this.cursor = 0;
    /** @type {StrokeMap | null} */
    this.pending = null;
    /**
     * Slot whose colour the open picker drag is rewriting, or null.
     *
     * A colour picker fires `input` for every pixel the user drags across, and
     * each one is a real change to the model. Without this, one drag would
     * leave dozens of undo steps and Ctrl+Z would crawl back through the
     * gradient instead of returning the original colour.
     * @type {number | null}
     */
    this.paletteDrag = null;
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

  /**
   * Record a colour swapped in place, coalescing a picker drag into one step.
   *
   * `before` is the colour of the slot when the drag began, not the previous
   * `input` - that is what makes one Ctrl+Z restore the original rather than
   * the second-to-last shade the pointer passed over.
   *
   * @param {number} index palette slot
   * @param {number} before packed 0xRRGGBB before the drag
   * @param {number} after packed 0xRRGGBB now
   * @returns {boolean} true when a new step was pushed (false when coalesced)
   */
  pushPalette(index, before, after) {
    const top = this.cursor > 0 ? this.stack[this.cursor - 1] : null;
    if (this.paletteDrag === index && top && top.kind === 'palette' && top.index === index) {
      top.after = after;
      return false;
    }
    this.stack.length = this.cursor; // a new step drops the redo tail
    this.stack.push({ kind: 'palette', index, before, after });
    if (this.stack.length > this.limit) this.stack.shift();
    this.cursor = this.stack.length;
    this.paletteDrag = index;
    return true;
  }

  /**
   * Close the picker drag, so the next colour change starts its own step.
   * Cheap and idempotent; call it on pointer-up, `change` or blur.
   */
  endPalette() {
    this.paletteDrag = null;
  }

  /**
   * Record a palette merge: freed slots, remapped face bytes and all.
   *
   * Never coalesced with anything. A merge is a deliberate one-off, and the
   * user who presses Ctrl+Z after it means that operation, not the stroke
   * before it.
   *
   * @param {Uint8Array} remap the map that was applied
   * @param {FaceRecord} record every face byte it changed, as it was
   * @param {PaletteState} before palette before the merge
   * @param {PaletteState} after palette after it
   */
  pushMerge(remap, record, before, after) {
    this.stack.length = this.cursor; // a new step drops the redo tail
    this.stack.push({ kind: 'merge', remap, record, before, after });
    if (this.stack.length > this.limit) this.stack.shift();
    this.cursor = this.stack.length;
    this.paletteDrag = null;
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
    this.stack.push({ kind: 'voxels', map });
    if (this.stack.length > this.limit) this.stack.shift();
    this.cursor = this.stack.length;
    this.paletteDrag = null;
    return true;
  }

  /**
   * @param {import('../core/volume.js').Volume} vol
   * @param {import('../core/palette.js').Palette} [palette]
   * @returns {'voxels'|'palette'|'merge'|null} what was undone, so the caller
   *   knows whether geometry, only the palette texture, or both have to be
   *   refreshed
   */
  undo(vol, palette) {
    if (!this.canUndo) return null;
    const entry = this.stack[this.cursor - 1];
    if (entry.kind === 'merge') {
      if (!palette) return null;
      this.cursor--;
      vol.restoreFaces(entry.record);
      palette.restore(entry.before);
      this.paletteDrag = null;
      return 'merge';
    }
    if (entry.kind === 'palette') {
      // Without the palette there is nothing to write to; leave the cursor
      // where it is rather than silently dropping the step.
      if (!palette) return null;
      this.cursor--;
      applyColour(palette, entry.index, entry.before);
      this.paletteDrag = null;
      return 'palette';
    }
    this.cursor--;
    for (const e of entry.map.values()) writeVoxel(vol, e.x, e.y, e.z, e.before);
    this.paletteDrag = null;
    return 'voxels';
  }

  /**
   * @param {import('../core/volume.js').Volume} vol
   * @param {import('../core/palette.js').Palette} [palette]
   * @returns {'voxels'|'palette'|'merge'|null}
   */
  redo(vol, palette) {
    if (!this.canRedo) return null;
    const entry = this.stack[this.cursor];
    if (entry.kind === 'merge') {
      if (!palette) return null;
      this.cursor++;
      // Applying the same map again lands on the same bytes: the faces are back
      // to what they were when it was first applied, and the map is a function.
      vol.remapFaces(entry.remap);
      palette.restore(entry.after);
      this.paletteDrag = null;
      return 'merge';
    }
    if (entry.kind === 'palette') {
      if (!palette) return null;
      this.cursor++;
      applyColour(palette, entry.index, entry.after);
      this.paletteDrag = null;
      return 'palette';
    }
    this.cursor++;
    for (const e of entry.map.values()) writeVoxel(vol, e.x, e.y, e.z, e.after);
    this.paletteDrag = null;
    return 'voxels';
  }

  clear() {
    this.stack.length = 0;
    this.cursor = 0;
    this.pending = null;
    this.paletteDrag = null;
  }
}

/**
 * @param {import('../core/palette.js').Palette} palette
 * @param {number} index @param {number} packed 0xRRGGBB
 */
function applyColour(palette, index, packed) {
  palette.replace(index, (packed >> 16) & 255, (packed >> 8) & 255, packed & 255);
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function sameFaces(a, b) {
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return false;
  return true;
}
