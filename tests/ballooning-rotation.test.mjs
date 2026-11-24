/**
 * Rotation-aware OCR geometry regression tests (no framework required).
 * Run:  node tests/ballooning-rotation.test.mjs
 *
 * Covers the pure helpers the 360-degree detection add-on relies on:
 *   - rotatedCanvasSize  (cardinal + arbitrary angle canvas growth)
 *   - mapRotatedBBox     (inverse mapping of OCR boxes at 0/90/180/270
 *                         and arbitrary angles, round-trip correctness,
 *                         diagonal-word containment, centre stability)
 * plus the pre-existing textGeometry helpers those pipelines share.
 */

import {
  rotatedCanvasSize,
  mapRotatedBBox,
  textAABB,
  textAxes,
  textAngle,
  isVerticalText,
  textCenter,
  boxGap,
  unionBox
} from '../src/utils/ballooning/textGeometry.js';
import { enhanceDetections } from '../src/utils/ballooning/engineeringDetection.js';
import { splitCalloutText } from '../src/utils/ballooning/calloutFormat.js';

/* --------------------------------- test runner --------------------------------- */
let passed = 0;
let failed = 0;
const failures = [];

const check = (cond, label, extra = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    failures.push(`${label} ${extra}`);
    console.log(`  FAIL ${label} ${extra}`);
  }
};

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const nearBox = (got, want, eps = 1e-6) =>
  near(got.x, want.x, eps) &&
  near(got.y, want.y, eps) &&
  near(got.width, want.width, eps) &&
  near(got.height, want.height, eps);

const RAD = (deg) => (deg * Math.PI) / 180;

/*
 * Forward transform, mirroring the canvas calls the OCR passes make:
 *   translate(rotW/2, rotH/2); rotate(theta); drawImage(src, -srcW/2, -srcH/2)
 * Used to build realistic rotated-space bboxes for the inverse tests.
 */
const forwardPoint = (px, py, rotation, srcW, srcH) => {
  const { width: rotW, height: rotH } = rotatedCanvasSize(srcW, srcH, rotation);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const u = px - srcW / 2;
  const v = py - srcH / 2;
  return [rotW / 2 + u * cos - v * sin, rotH / 2 + u * sin + v * cos];
};

const forwardBox = (box, rotation, srcW, srcH) => {
  const corners = [
    forwardPoint(box.x, box.y, rotation, srcW, srcH),
    forwardPoint(box.x + box.width, box.y, rotation, srcW, srcH),
    forwardPoint(box.x, box.y + box.height, rotation, srcW, srcH),
    forwardPoint(box.x + box.width, box.y + box.height, rotation, srcW, srcH)
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x0: minX,
    y0: minY,
    x1: Math.max(...xs),
    y1: Math.max(...ys)
  };
};

/* ============================ rotatedCanvasSize ============================ */
console.log('\n== rotatedCanvasSize');

{
  const s = rotatedCanvasSize(1000, 500, 0);
  check(s.width === 1000 && s.height === 500, 'rotation 0 keeps the canvas size');
}

{
  const s = rotatedCanvasSize(995, 432, RAD(90));
  check(s.width === 432 && s.height === 995, '+90 swaps exactly (no ceil inflation)');
}

{
  const s = rotatedCanvasSize(995, 432, RAD(-90));
  check(s.width === 432 && s.height === 995, '-90 swaps exactly (no ceil inflation)');
}

{
  const s = rotatedCanvasSize(1000, 500, RAD(180));
  check(s.width === 1000 && s.height === 500, '180 keeps the canvas size');
}

{
  const s = rotatedCanvasSize(1000, 500, RAD(45));
  const expected = Math.ceil(1000 * Math.SQRT1_2 + 500 * Math.SQRT1_2);
  check(s.width === expected && s.height === expected, '45 grows to the diagonal bounding square');
}

/* ============================== mapRotatedBBox ============================== */
console.log('\n== mapRotatedBBox (0 / 90 / 180 / 270)');

{
  const got = mapRotatedBBox({ x0: 10, y0: 20, x1: 110, y1: 50 }, 0, 1000, 500);
  check(
    nearBox(got, { x: 10, y: 20, width: 100, height: 30 }),
    'rotation 0 is an exact passthrough'
  );
}

{
  /*
   * Verified by hand against the +90 canvas ops:
   *   source point (x, y) -> rotated (rotW - y, x) with rotW = srcH.
   * Inverse of a rotated-space box therefore reads
   *   x' = wy, y' = srcH - wx - ww, w' = wh, h' = ww.
   */
  const srcW = 1000;
  const srcH = 500;
  const rot = RAD(90);
  const { width: rotW, height: rotH } = rotatedCanvasSize(srcW, srcH, rot);

  // Source box (100, 80, 120x20). Forward it, then map back.
  const fwd = forwardBox({ x: 100, y: 80, width: 120, height: 20 }, rot, srcW, srcH);
  const got = mapRotatedBBox(fwd, rot, srcW, srcH);
  check(
    nearBox(got, { x: 100, y: 80, width: 120, height: 20 }, 1e-6),
    '+90 inverse recovers the source box (round trip)'
  );

  // Explicit known-value check (independent of forwardBox):
  const explicit = mapRotatedBBox({ x0: 80, y0: 100, x1: 100, y1: 220 }, rot, srcW, srcH);
  // wx=80, wy=100, ww=20, wh=120 -> x = wy = 100; y = srcH - wx - ww = 500-80-20 = 400
  check(
    nearBox(explicit, { x: 100, y: 400, width: 120, height: 20 }),
    '+90 explicit formula: x=wy, y=srcH-wx-ww, sizes swapped'
  );
  check(rotW === srcH && rotH === srcW, '+90 rotated canvas is the swapped size');
}

{
  const srcW = 1000;
  const srcH = 500;
  const rot = RAD(-90);
  const fwd = forwardBox({ x: 300, y: 40, width: 60, height: 15 }, rot, srcW, srcH);
  const got = mapRotatedBBox(fwd, rot, srcW, srcH);
  check(
    nearBox(got, { x: 300, y: 40, width: 60, height: 15 }, 1e-6),
    '-90 inverse recovers the source box (round trip)'
  );

  // Explicit: -90 maps source (x,y) -> rotated (y, rotH - x) with rotH = srcW.
  // Inverse: x = rotH - wy - wh, y = wx.
  const explicit = mapRotatedBBox({ x0: 40, y0: 300, x1: 55, y1: 360 }, rot, srcW, srcH);
  // wx=40, wy=300, ww=15, wh=60 -> x = 1000-300-60 = 640; y = 40
  check(
    nearBox(explicit, { x: 640, y: 40, width: 60, height: 15 }),
    '-90 explicit formula: x=srcW-wy-wh, y=wx, sizes swapped'
  );
}

{
  const srcW = 800;
  const srcH = 600;
  const rot = RAD(180);
  const fwd = forwardBox({ x: 150, y: 90, width: 80, height: 25 }, rot, srcW, srcH);
  const got = mapRotatedBBox(fwd, rot, srcW, srcH);
  check(
    nearBox(got, { x: 150, y: 90, width: 80, height: 25 }, 1e-6),
    '180 inverse recovers the source box (round trip)'
  );

  // Explicit point-reflection: box (x, y, w, h) -> (srcW-x-w, srcH-y-h, w, h)
  const explicit = mapRotatedBBox({ x0: 570, y0: 485, x1: 650, y1: 510 }, rot, srcW, srcH);
  check(
    nearBox(explicit, { x: 150, y: 90, width: 80, height: 25 }),
    '180 explicit formula: point reflection through the centre'
  );
}

console.log('\n== mapRotatedBBox (arbitrary angles)');

/*
 * At cardinal angles a box rotated and inverse-rotated recovers
 * exactly (the AABB commutes with 90-degree steps). At any other
 * angle the AABB of the rotated corners is larger than the rotated
 * AABB of the original, so exact equality is the wrong assertion:
 * what the detection pipeline needs is that every true glyph corner
 * lands INSIDE the mapped box (never a shifted/mirrored balloon) and
 * that the box stays reasonably tight. Each source corner is pushed
 * through the forward transform individually, boxed, mapped back,
 * and required to reappear at its original spot.
 */
for (const deg of [15, 30, 37, 45, 60, 72, 100, 123, 135, 200, 315, 359]) {
  const srcW = 1234;
  const srcH = 567;
  const rot = RAD(deg);
  const source = { x: 210, y: 130, width: 90, height: 18 };

  const corners = [
    [source.x, source.y],
    [source.x + source.width, source.y],
    [source.x, source.y + source.height],
    [source.x + source.width, source.y + source.height]
  ];

  let allRecovered = true;
  let worstSlip = 0;
  for (const [px, py] of corners) {
    const [fx, fy] = forwardPoint(px, py, rot, srcW, srcH);
    // Zero-size (point) box: all four corners collapse, so the mapped
    // box centre IS the inverse image of the point - exactly what a
    // balloon anchor needs.
    const got = mapRotatedBBox(
      { x0: fx, y0: fy, x1: fx, y1: fy },
      rot,
      srcW,
      srcH
    );
    const cx = got.x + got.width / 2;
    const cy = got.y + got.height / 2;
    const slip = Math.max(Math.abs(cx - px), Math.abs(cy - py));
    worstSlip = Math.max(worstSlip, slip);
    if (slip > 1e-6) allRecovered = false;
  }
  check(allRecovered, `${deg} degree corner points round trip (worst slip ${worstSlip.toExponential(1)}px)`);

  // Whole-box containment: mapped AABB of the rotated box contains every corner.
  const fwd = forwardBox(source, rot, srcW, srcH);
  const got = mapRotatedBBox(fwd, rot, srcW, srcH);
  const contained = corners.every(
    ([px, py]) =>
      px >= got.x - 1e-6 &&
      px <= got.x + got.width + 1e-6 &&
      py >= got.y - 1e-6 &&
      py <= got.y + got.height + 1e-6
  );
  // Double AABB inflation (forward then inverse) bounds the ratio by
  // (|cos|+|sin|)^2 <= ~2 per step, so up to ~8x worst case; the
  // containment guarantee is what protects the balloon anchor.
  const areaRatio = (got.width * got.height) / (source.width * source.height);
  check(
    contained && areaRatio < 8,
    `${deg} degree mapped box contains the word and stays bounded (area x${areaRatio.toFixed(2)})`
  );
}

{
  /* Centre stability: a box at the page centre, once rotated into
     canvas space and mapped back, must still be centred. */
  const srcW = 1000;
  const srcH = 700;
  for (const deg of [0, 90, 180, 270, 45, 123]) {
    const rot = RAD(deg);
    const centreSource = { x: 490, y: 340, width: 20, height: 20 };
    const fwd = forwardBox(centreSource, rot, srcW, srcH);
    const got = mapRotatedBBox(fwd, rot, srcW, srcH);
    const cx = got.x + got.width / 2;
    const cy = got.y + got.height / 2;
    check(
      near(cx, srcW / 2, 1e-6) && near(cy, srcH / 2, 1e-6),
      `${deg} degree keeps the page-centre box centred`
    );
  }
}

{
  /* Diagonal word: mapped box must CONTAIN all four inverse-rotated corners. */
  const srcW = 1000;
  const srcH = 800;
  const rot = RAD(37);
  const word = { x0: 300, y0: 200, x1: 380, y1: 224 };
  const got = mapRotatedBBox(word, rot, srcW, srcH);

  const { width: rotW, height: rotH } = rotatedCanvasSize(srcW, srcH, rot);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const toSource = (X, Y) => {
    const u = X - rotW / 2;
    const v = Y - rotH / 2;
    return [srcW / 2 + u * cos + v * sin, srcH / 2 - u * sin + v * cos];
  };

  const corners = [
    toSource(word.x0, word.y0),
    toSource(word.x1, word.y0),
    toSource(word.x0, word.y1),
    toSource(word.x1, word.y1)
  ];
  const contained = corners.every(
    ([px, py]) =>
      px >= got.x - 1e-6 &&
      px <= got.x + got.width + 1e-6 &&
      py >= got.y - 1e-6 &&
      py <= got.y + got.height + 1e-6
  );
  check(contained, '37 degree mapped box contains all four source corners');
}

{
  /* Degenerate / hostile inputs never throw and stay finite. */
  const a = mapRotatedBBox(null, RAD(90), 100, 100);
  const b = mapRotatedBBox({ x0: 0, y0: 0, x1: 0, y1: 0 }, RAD(45), 100, 100);
  const c = mapRotatedBBox({ x0: 10, y0: 10, x1: 20, y1: 20 }, RAD(90), 0, 0);
  check(
    [a, b, c].every((box) => Number.isFinite(box.x) && Number.isFinite(box.y)),
    'null/zero/empty inputs return finite boxes'
  );
}

/* ====================== shared textGeometry regression ====================== */
console.log('\n== textGeometry (existing helpers still intact)');

{
  const horizontal = { x: 10, y: 100, width: 60, height: 12, mat: [1, 0, 0, 1, 0, 0] };
  const axes = textAxes(horizontal);
  check(!!axes && near(axes.along[0], 1) && near(axes.along[1], 0), 'horizontal text axes along +x');

  const vertical = { x: 10, y: 100, width: 60, height: 12, mat: [0, -1, 1, 0, 0, 0] };
  const vAxes = textAxes(vertical);
  check(!!vAxes && Math.abs(vAxes.along[1]) > Math.abs(vAxes.along[0]), 'vertical text axes along y');
  check(isVerticalText(vertical) === true, 'isVerticalText true for rotated matrix');
  check(isVerticalText(horizontal) === false, 'isVerticalText false for horizontal matrix');
  check(near(textAngle(horizontal), 0), 'textAngle 0 for horizontal');
  check(near(Math.abs(textAngle(vertical)), Math.PI / 2), 'textAngle +/-90 for vertical');
}

{
  const item = { x: 10, y: 100, width: 60, height: 12, mat: [1, 0, 0, 1, 0, 0] };
  const box = textAABB(item);
  check(nearBox(box, { x: 10, y: 88, width: 60, height: 12 }) || nearBox(box, { x: 10, y: 100, width: 60, height: 12 }), 'textAABB of horizontal run is its own box');
  const centre = textCenter(item);
  check(Number.isFinite(centre.x) && Number.isFinite(centre.y), 'textCenter returns finite point');
}

{
  check(boxGap({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 5, height: 5 }) === 10, 'boxGap separates side-by-side boxes');
  const u = unionBox({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 10 });
  check(u.x === 0 && u.width === 30, 'unionBox spans both boxes');
}

/* ================================= summary ================================= */
console.log('\n== clustering: independent callouts never fuse');
{
  /* Two side-by-side vertical dimensions ("60" next to "46±0.02")
     must stay separate balloons. mat [0,1,-1,0] is a 90-degree run
     (reads down the page). */
  const pair = [
    { text: '60', x: 100, y: 200, width: 36, height: 20, source: 'pdf', conf: 99, mat: [0, 1, -1, 0], pageWidth: 1000, pageHeight: 1400 },
    { text: '46±0.02', x: 140, y: 195, width: 60, height: 20, source: 'pdf', conf: 98, mat: [0, 1, -1, 0], pageWidth: 1000, pageHeight: 1400 },
  ];
  const out = enhanceDetections(pair, 1000, 1400, 1);
  check(out.length === 2, 'vertical pair "60" + "46±0.02" yields two candidates');
  check(out.some(d => d.text === '60'), '  "60" survives on its own');
  check(out.some(d => d.text.includes('46') && d.text.includes('0.02')), '  "46±0.02" survives on its own');

  /* Tolerance-only fragments still merge into their dimension. */
  const frag = [
    { text: '46', x: 100, y: 200, width: 36, height: 20, source: 'pdf', conf: 99, mat: [0, 1, -1, 0], pageWidth: 1000, pageHeight: 1400 },
    { text: '±0.02', x: 100, y: 236, width: 40, height: 20, source: 'pdf', conf: 98, mat: [0, 1, -1, 0], pageWidth: 1000, pageHeight: 1400 },
  ];
  const merged = enhanceDetections(frag, 1000, 1400, 1);
  check(merged.length === 1 && /46/.test(merged[0].text) && /0\.02/.test(merged[0].text),
    '  "46" + "±0.02" fragments still merge');

  /* splitCalloutText safety net: fused independent callouts split,
     stacked notes and thread callouts do not. */
  check(JSON.stringify(splitCalloutText('60 46±0.02')) === JSON.stringify(['60', '46±0.02']),
    'splitCalloutText splits "60 46±0.02"');
  check(JSON.stringify(splitCalloutText('15 75±0.02')) === JSON.stringify(['15', '75±0.02']),
    '  "15 75±0.02" splits');
  check(JSON.stringify(splitCalloutText('3 x 4.2 12')) === JSON.stringify(['3 x 4.2 12']),
    '  "3 x 4.2 12" stays whole');
  check(JSON.stringify(splitCalloutText('2 x M5 THRU')) === JSON.stringify(['2 x M5 THRU']),
    '  "2 x M5 THRU" stays whole');
  check(JSON.stringify(splitCalloutText('25 ±0.05')) === JSON.stringify(['25 ±0.05']),
    '  "25 ±0.05" (one callout) stays whole');
  check(JSON.stringify(splitCalloutText('3 x 4.2 12 M5x0.8 10')) === JSON.stringify(['3 x 4.2 12', 'M5x0.8 10']),
    '  thread splitter still separates stacked notes');
}

/* ================================= summary ================================= */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
