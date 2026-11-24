/*
 * Rotation-aware geometry for detected drawing text.
 *
 * A PDF text item reports the ORIGIN of its baseline plus the run
 * width and the font height measured along the TEXT's own axes, not
 * along the page's. A vertical callout - "Ø25" written up the side of
 * a view - therefore has a width that runs DOWN the page and a height
 * that runs ACROSS it, and the familiar (x + width/2, y - height/2)
 * centre lands well away from the glyphs.
 *
 * That is why a vertical dimension could be marked with a balloon
 * while the value stored against it came from a neighbour, or from
 * nothing at all: the leader pointed at empty paper, the anchor was
 * in the wrong place, and the symbol/tolerance adjacency tests (which
 * only ever looked at x) could not see a "Ø" stacked above its
 * number.
 *
 * Every stage downstream works on axis-aligned boxes, so the
 * rotation is resolved exactly once - here - and everything else
 * stays orientation blind.
 */

const TINY = 1e-6;

/*
 * Unit vectors of a text run's own axes in canvas space, or null when
 * the item carries no text matrix (OCR words, and any detection whose
 * box has already been resolved through textAABB).
 */
export const textAxes = (item) => {
  const mat = item && item.mat;

  if (!mat || mat.length < 4) {
    return null;
  }

  const alongLength = Math.hypot(mat[0], mat[1]);
  const upLength = Math.hypot(mat[2], mat[3]);

  if (!(alongLength > TINY) || !(upLength > TINY)) {
    return null;
  }

  return {
    along: [mat[0] / alongLength, mat[1] / alongLength],
    up: [mat[2] / upLength, mat[3] / upLength]
  };
};

/*
 * Axis-aligned bounding box of a text run in canvas space, with the
 * origin at the box's TOP-LEFT corner.
 *
 * Without a text matrix the item is already an axis-aligned box in
 * that form (OCR words). With one, (x, y) is the start of the
 * baseline: the glyph box runs from there for `width` along the
 * reading direction and for `height` across it, so its four corners
 * are the baseline start, the baseline end, and those two lifted by
 * the font height. Unrotated text collapses to exactly the box the
 * old (x, y - height / 2) centre assumed, so horizontal drawings are
 * unaffected.
 */
export const textAABB = (item, options) => {
  if (!item) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const width = Math.abs(Number(item.width || 0));
  const height = Math.abs(Number(item.height || 0));
  const x = Number(item.x || 0);
  const y = Number(item.y || 0);
  const axes = textAxes(item);

  if (!axes) {
    return withCenter({ x, y, width, height }, options);
  }

  const xs = [
    x,
    x + axes.along[0] * width,
    x + axes.up[0] * height,
    x + axes.along[0] * width + axes.up[0] * height
  ];

  const ys = [
    y,
    y + axes.along[1] * width,
    y + axes.up[1] * height,
    y + axes.along[1] * width + axes.up[1] * height
  ];

  const left = Math.min(...xs);
  const top = Math.min(...ys);

  return withCenter(
    {
      x: left,
      y: top,
      width: Math.max(...xs) - left,
      height: Math.max(...ys) - top
    },
    options
  );
};

/*
 * The centre of the axis-aligned box and the centre projected along
 * the run's own text axes are the same point for an orthogonal
 * matrix, so publishing the AABB centre is safe to mix with callers
 * that still project from the baseline origin.
 */
const withCenter = (box, options) =>
  options && options.center
    ? {
      ...box,
      centerX: box.x + box.width / 2,
      centerY: box.y + box.height / 2
    }
    : box;

export const textCenterX = (item) => {
  const box = textAABB(item);
  return box.x + box.width / 2;
};

export const textCenterY = (item) => {
  const box = textAABB(item);
  return box.y + box.height / 2;
};

/* Centre of a run as a point. */
export const textCenter = (item) => ({
  x: textCenterX(item),
  y: textCenterY(item)
});

/*
 * Reading angle of the run in canvas space, or null when unknown.
 * 0 reads left to right, +/- PI/2 reads top to bottom / bottom to
 * top.
 */
export const textAngle = (item) => {
  const axes = textAxes(item);

  if (!axes) {
    return null;
  }

  return Math.atan2(axes.along[1], axes.along[0]);
};

/*
 * True when the run is written along the page's vertical axis.
 *
 * With a text matrix this is exact. Without one (OCR) the only
 * evidence is the shape of the box: Tesseract returns a rotated word
 * as a box that is clearly taller than it is wide, which a horizontal
 * callout never is.
 */
export const isVerticalText = (item) => {
  if (!item) {
    return false;
  }

  const axes = textAxes(item);

  if (axes) {
    return Math.abs(axes.along[1]) > Math.abs(axes.along[0]) + TINY;
  }

  const box = textAABB(item);

  return box.height > box.width * 1.4 && box.height > 0;
};

/*
 * Position of a point in the run's own frame, measured from the
 * baseline start.
 *
 *   along  - distance in the reading direction; negative is BEFORE
 *            the value, which is where a "Ø" in front of its number
 *            lives at any rotation.
 *   across - distance off the baseline, i.e. how far the point sits
 *            from the text's own line.
 *
 * For items without a text matrix the frame degenerates to the page's
 * own axes with the box origin, which is the previous behaviour.
 */
export const projectOnTextAxes = (item, pointX, pointY) => {
  const x = Number((item && item.x) || 0);
  const y = Number((item && item.y) || 0);
  const axes = textAxes(item);

  if (!axes) {
    return { along: pointX - x, across: pointY - y };
  }

  const dx = pointX - x;
  const dy = pointY - y;

  return {
    along: dx * axes.along[0] + dy * axes.along[1],
    across: dx * axes.up[0] + dy * axes.up[1]
  };
};

/* Smallest box containing both. */
export const unionBox = (a, b) => {
  if (!a) return b;
  if (!b) return a;

  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);

  return {
    x: left,
    y: top,
    width: Math.max(a.x + a.width, b.x + b.width) - left,
    height: Math.max(a.y + a.height, b.y + b.height) - top
  };
};

/* Distance between two boxes, 0 when they touch or overlap. */
export const boxGap = (a, b) => {
  const dx = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
  const dy = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0);
  return Math.hypot(dx, dy);
};

/*
 * ADD-ON: rotation-aware OCR helpers (pure, Node-testable).
 *
 * A rotated OCR pass draws the source canvas onto a grown canvas with
 *   translate(rotW/2, rotH/2); rotate(theta); drawImage(src, -srcW/2, -srcH/2)
 * so a source point p maps to R(theta) * (p - srcCentre) + rotCentre.
 * These helpers invert that transform for Tesseract bounding boxes.
 */

const ROT_TINY = 1e-9;

/*
 * Size of the canvas a rotation of srcW x srcH needs. Cardinals avoid
 * the ceil() that would inflate 995.0000000000001 to 996 and shift
 * every rotated reading by a pixel.
 */
export const rotatedCanvasSize = (srcW, srcH, rotation) => {
  if (!rotation) {
    return { width: srcW, height: srcH };
  }

  const absCos = Math.abs(Math.cos(rotation));
  const absSin = Math.abs(Math.sin(rotation));

  if (absSin < ROT_TINY) {
    return { width: srcW, height: srcH };
  }

  if (absCos < ROT_TINY) {
    return { width: srcH, height: srcW };
  }

  return {
    width: Math.ceil(srcW * absCos + srcH * absSin),
    height: Math.ceil(srcW * absSin + srcH * absCos)
  };
};

/*
 * Map a rotated-canvas bbox ({x0, y0, x1, y1} in canvas pixels) back
 * to an axis-aligned box in the SOURCE canvas ({x, y, width, height}).
 * The four corners are inverse-rotated about the shared centre and
 * their bounding box taken, so a diagonal word keeps a box that
 * contains it. Rotation 0 is an exact passthrough.
 */
export const mapRotatedBBox = (bbox, rotation, srcW, srcH) => {
  const wx = Number(bbox?.x0 || 0);
  const wy = Number(bbox?.y0 || 0);
  const ww = Number(bbox?.x1 ?? wx) - wx;
  const wh = Number(bbox?.y1 ?? wy) - wy;

  if (!rotation) {
    return { x: wx, y: wy, width: ww, height: wh };
  }

  const { width: rotW, height: rotH } = rotatedCanvasSize(srcW, srcH, rotation);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const rx = rotW / 2;
  const ry = rotH / 2;
  const cx0 = srcW / 2;
  const cy0 = srcH / 2;

  const toSource = (X, Y) => {
    const u = X - rx;
    const v = Y - ry;
    return [cx0 + u * cos + v * sin, cy0 - u * sin + v * cos];
  };

  const corners = [
    toSource(wx, wy),
    toSource(wx + ww, wy),
    toSource(wx, wy + wh),
    toSource(wx + ww, wy + wh)
  ];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const [px, py] of corners) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};
