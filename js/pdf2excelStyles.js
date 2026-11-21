// SPDX-License-Identifier: AGPL-3.0-only
// Optional presentation metadata. Never changes extracted values or detection.
const identity = [1, 0, 0, 1, 0, 0];
const norm = text => String(text ?? '').normalize('NFKC').split('\u0000').join('').replace(/\s/g, '');
const point = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const multiply = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const rgb = args => args.length >= 3 && args.slice(0, 3).every(v => Number.isFinite(v) && v >= 0 && v <= 255)
  ? Array.from(args).slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase() : null;
const box = points => [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
const intersection = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const contains = (a, b, slack = 0.5) => a[0] <= b[0]+slack && a[1] <= b[1]+slack && a[2] >= b[2]-slack && a[3] >= b[3]-slack;

// PDF.js 4.10 OPS, already-normalized RGB bytes. Unknown paint, clipping,
// transparency or a non-rectangular path cannot supply a cell background.
export function readExcelPaint(operators, sourceItems, matrix = identity) {
  const empty = { fills: [], colors: [], rules: [] };
  if (!operators || operators.fnArray.length > 250000) return empty;
  let state = { matrix: matrix || identity, fill: '000000', stroke: '000000', width: 1, dashed: false, safe: true, mode: 0, clip: [-Infinity, -Infinity, Infinity, Infinity] };
  const stack = [], fills = [], runs = [], rules = [];
  let segments = [], current = null, first = null;
  let path = [], rectangles = [], valid = true, pendingClip = false, length = 0, steps = 0;
  const resetPath = () => { segments = []; current = null; first = null; path = []; rectangles = []; valid = true; pendingClip = false; };
  for (let i = 0; i < operators.fnArray.length; i++) {
    if (++steps > 250000) return empty;
    const op = operators.fnArray[i], args = operators.argsArray[i] || [];
    if (op === 10 || op === 74) {
      stack.push({ ...state });
      if (op === 74) {
        if (args[0]) state.matrix = multiply(state.matrix, args[0]);
        if (args[1]) {
          const [x0,y0,x1,y1] = args[1], m = state.matrix;
          if (m[1] === 0 && m[2] === 0 || m[0] === 0 && m[3] === 0) state.clip = intersection(state.clip, box([point(m,x0,y0),point(m,x1,y1)]));
          else state.safe = false;
        }
      }
    } else if (op === 11 || op === 75) state = stack.pop() || state;
    else if (op === 12) state.matrix = multiply(state.matrix, args);
    else if (op === 2) state.width = args[0];
    else if (op === 6) state.dashed = !!args[0]?.length;
    else if (op === 58) state.stroke = rgb(args);
    else if ([52,53,60,92].includes(op)) state.stroke = null;
    else if (op === 59) state.fill = rgb(args);
    else if (op === 57) state.fill = rgb([args[0]*255,args[0]*255,args[0]*255]);
    else if ([54,55,61,93].includes(op)) state.fill = null;
    else if (op === 9) {
      for (const [key, value] of args[0] || []) {
        if ((key === 'ca' && value !== 1) || (key === 'BM' && value !== 'source-over') || (key === 'SMask' && value)) state.safe = false;
      }
    } else if (op === 38) state.mode = args[0];
    else if (op === 44) {
      const text = norm((args[0] || []).map(g => typeof g === 'object' ? g.unicode || '' : '').join(''));
      length += text.length;
      if (length > 2000000) return empty;
      if (text) runs.push({ text, color: state.safe && state.mode === 0 ? state.fill : null });
    } else if (op === 91) {
      const [ops, coords] = args; let n = 0;
      steps += ops.length;
      if (steps > 250000) return empty;
      for (const p of ops) {
        if (p === 19) {
          const [x,y,w,h] = coords.slice(n,n+4); n += 4;
          const pts = [[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(([a,b]) => point(state.matrix,a,b));
          if (pts.every((pt,k) => Math.abs(pt[0]-pts[(k+1)%4][0]) < 0.01 || Math.abs(pt[1]-pts[(k+1)%4][1]) < 0.01)) { rectangles.push(box(pts)); for (let k = 0; k < 4; k++) segments.push([pts[k],pts[(k+1)%4]]); }
          else valid = false;
        } else if (p === 13 || p === 14) {
          const pt = point(state.matrix,coords[n],coords[n+1]); n += 2;
          if (p === 14 && current) segments.push([current,pt]);
          if (p === 13) first = pt;
          current = pt; path.push(pt);
        } else if (p === 18 && current && first) { segments.push([current,first]); current = first; }
        else if (p !== 18) { n += p === 15 ? 6 : 4; valid = false; current = null; first = null; }
      }
    } else if (op === 29 || op === 30) pendingClip = true;
    else if (op >= 20 && op <= 28) {
      if (path.length) {
        if (path.length === 5 && path[0][0] === path[4][0] && path[0][1] === path[4][1]) path.pop();
        if (path.length === 4 && path.every((pt,k) => Math.abs(pt[0]-path[(k+1)%4][0]) < 0.01 || Math.abs(pt[1]-path[(k+1)%4][1]) < 0.01)) rectangles.push(box(path));
        else valid = false;
      }
      if ([20,21,24,25,26,27].includes(op) && state.safe && state.stroke && !state.dashed) {
        const m = state.matrix;
        const width = state.width * Math.sqrt(Math.abs(m[0]*m[3]-m[1]*m[2]));
        for (const [a,b] of segments) {
          const bounds = box([a,b]);
          if (contains(state.clip,bounds,0) && (Math.abs(a[0]-b[0]) < 0.1 || Math.abs(a[1]-b[1]) < 0.1)) rules.push({ bounds, color: state.stroke, width });
        }
      }
      // One rectangle avoids interpreting holes, logos or compound paths as fills.
      if (valid && rectangles.length === 1) {
        if (op >= 22 && op <= 27) fills.push({ bounds: intersection(rectangles[0],state.clip), color: state.safe ? state.fill : null });
        if (pendingClip) state.clip = intersection(state.clip,rectangles[0]);
      } else if (pendingClip) state.safe = false;
      resetPath();
    } else if (op === 76 || op === 80) { stack.push({ ...state }); state.safe = false; }
    else if (op === 77 || op === 81) state = stack.pop() || state;
  }
  // Exact full-stream correspondence only. ActualText, hidden glyphs, bidi or
  // unusual fonts can differ; in that case keep the default text colour.
  const text = runs.map(r => r.text).join('');
  const colors = [];
  if (text === sourceItems.map(it => norm(it.str)).join('')) {
    let run = 0, offset = 0;
    for (const item of sourceItems) {
      const size = norm(item.str).length; let color, same = true;
      for (let j = 0; j < size; j++) {
        while (run < runs.length && offset === runs[run].text.length) { run++; offset = 0; }
        const current = runs[run]?.color;
        if (j === 0) color = current;
        else if (current !== color) same = false;
        offset++;
      }
      colors.push(same ? color : null);
    }
  }
  return { fills, colors, rules };
}

// Geometry is admitted only when the detector gave real row/column boundaries.
// A partial or mixed match gets no invented font or colour.
export function styleExcelTable(table, items, paint) {
  if (!table.rowBands) return;
  // Bounded optional work: a pathological drawing must not stall conversion.
  const cells = table.rows.reduce((n,row)=>n+row.length,0);
  if (cells * (items.length + paint.fills.length + (paint.rules?.length || 0)) > 2000000) return;
  const xs = table.colXs || table.colCenters?.map((x,c,a) => c ? (x+a[c-1])/2 : -Infinity).concat(Infinity);
  if (!xs) return;
  // A borderless row can inherit a full-width stripe, never a small logo or
  // a word highlight. Its outer cell boundaries are not known precisely.
  const rowFills = table.rowBands.map(([top,bottom]) => {
    const rowItems = items.filter(it => it.y < top && it.y >= bottom && it.str.trim());
    if (!rowItems.length) return null;
    const bounds = [Math.min(...rowItems.map(it=>it.x)),bottom,
      Math.max(...rowItems.map(it=>it.x+(it.width || 0))),top];
    let match;
    for (const fill of paint.fills) if (contains(fill.bounds,bounds)) match = fill;
    return match;
  });
  table.cellStyles = table.rows.map((row,r) => row.map((value,c) => {
    const merge = table.merges?.find(m => m.row === r && m.from === c);
    const [top,bottom] = [table.rowBands[r][0],table.rowBands[Math.min(table.rows.length-1,r+(merge?.rowSpan || 1)-1)][1]];
    const bounds = [xs[c],bottom,xs[(merge?.to ?? c)+1],top];
    const selected = items.filter(it => it.y < top && it.y >= bottom && it.x >= bounds[0]-1 && it.x < bounds[2]-1);
    const exact = norm(selected.map(it => it.str).join('')) === norm(value);
    const style = {};
    if (exact && selected.length && value) {
      const font = {};
      if (selected[0].fontFace && selected.every(it=>it.fontFace === selected[0].fontFace)) font.name = selected[0].fontFace;
      for (const key of ['bold','italic']) if (selected.every(it => it[key] === selected[0][key])) font[key] = !!selected[0][key];
      const sizes = selected.map(it => it.fontSize);
      if (sizes.every(s => Number.isFinite(s) && s >= 4 && s <= 72 && Math.abs(s-sizes[0]) < 0.5)) font.size = Math.round(sizes[0]*2)/2;
      if (selected[0].color && selected.every(it => it.color === selected[0].color)) font.color = { argb: 'FF'+selected[0].color };
      style.font = font;
      if (table.colXs) {
        const leftGap = Math.min(...selected.map(it=>it.x))-bounds[0];
        const rightGap = bounds[2]-Math.max(...selected.map(it=>it.x+(it.width || 0)));
        if (leftGap >= 0 && rightGap >= 0) {
          style.alignment = { horizontal: Math.abs(leftGap-rightGap) <= 2 ? 'center' : rightGap < leftGap ? 'right' : 'left' };
        }
      }
    }
    if (table.colXs) {
      let fill;
      // Table detection snaps boundaries to a 4 pt grid (at most 2 pt error).
      for (const candidate of paint.fills) if (contains(candidate.bounds,bounds,2.01)) fill = candidate;
      if (fill?.color) style.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF'+fill.color } };
      const [left,low,right,high] = bounds;
      const edges = { top:[left,high,right,high], bottom:[left,low,right,low], left:[left,low,left,high], right:[right,low,right,high] };
      for (const [side,edge] of Object.entries(edges)) {
        let match;
        for (const rule of paint.rules || []) {
          if (rule.bounds.every((v,k) => Math.abs(v-edge[k]) <= 2.01) ||
            ((side === 'top' || side === 'bottom') && Math.abs(rule.bounds[1]-edge[1]) <= 2.01 && Math.abs(rule.bounds[3]-edge[3]) <= 2.01 && rule.bounds[0] <= left+2.01 && rule.bounds[2] >= right-2.01) ||
            ((side === 'left' || side === 'right') && Math.abs(rule.bounds[0]-edge[0]) <= 2.01 && Math.abs(rule.bounds[2]-edge[2]) <= 2.01 && rule.bounds[1] <= low+2.01 && rule.bounds[3] >= high-2.01)) match = rule;
        }
        if (match) { style.border ||= {}; style.border[side] = { style: match.width > 1.5 ? 'medium' : 'thin', color: { argb:'FF'+match.color } }; }
      }
    }
    if (!table.colXs && rowFills[r]?.color) style.fill = {
      type:'pattern', pattern:'solid', fgColor:{argb:'FF'+rowFills[r].color},
    };
    // White text without its reliably identified background would disappear.
    if (style.font?.color?.argb === 'FFFFFFFF' && !style.fill) delete style.font.color;
    return style;
  }));
  if (table.colXs) {
    table.columnWidths = table.colXs.slice(1).map((x,c) => Math.min(100, Math.max(3,(x-table.colXs[c])*96/72/7)));
    table.rowHeights = table.rowBands.map(([top,bottom]) => Math.min(409,Math.max(12,top-bottom)));
  }
}

export function applyExcelStyles(sheet, table) {
  table.columnWidths?.forEach((width,c) => { sheet.getColumn(c+1).width = width; });
  table.rowHeights?.forEach((height,r) => { if (height) sheet.getRow(r+1).height = height; });
  table.cellStyles?.forEach((row,r) => row.forEach((style,c) => {
    const cell = sheet.getRow(r+1).getCell(c+1);
    if (style.font) cell.font = { ...cell.font, ...style.font };
    if (style.fill) cell.fill = style.fill;
    if (style.border) cell.border = style.border;
    cell.alignment = { ...cell.alignment, vertical: 'middle', wrapText: true, ...style.alignment };
  }));
}

export function previewExcelStyle(cell, style) {
  if (!style) return;
  cell.style.backgroundColor = '#' + (style.fill?.fgColor?.argb?.slice(2) || 'FFFFFF');
  cell.style.color = '#' + (style.font?.color?.argb?.slice(2) || '000000');
  for (const [side,border] of Object.entries(style.border || {})) cell.style['border'+side[0].toUpperCase()+side.slice(1)] = `${border.style === 'medium' ? 2 : 1}px solid #${border.color.argb.slice(2)}`;
  if (style.alignment?.horizontal) cell.style.textAlign = style.alignment.horizontal;
  if (style.font?.name) cell.style.fontFamily = style.font.name;
  if (style.font?.size) cell.style.fontSize = style.font.size+'pt';
  if (style.font?.bold !== undefined) cell.style.fontWeight = style.font.bold ? '700' : '400';
  if (style.font?.italic !== undefined) cell.style.fontStyle = style.font.italic ? 'italic' : 'normal';
}
