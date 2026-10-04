import {
  SceneryItem,
  Track,
  TrackElement,
  sampleRoadCurve,
  roadStrokeWidth,
  roadKerbDashes,
  sceneryShapes,
  finishMarkings,
} from '@shared';

export function drawFinishMarkings(
  ctx: CanvasRenderingContext2D,
  track: Track,
  element: TrackElement
) {
  ctx.save();
  for (const marking of finishMarkings(track, element)) {
    ctx.fillStyle = marking.white ? '#ffffff' : '#000000';
    ctx.beginPath();
    marking.points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

export function drawRoadCurve(
  ctx: CanvasRenderingContext2D,
  element: TrackElement,
  selected = false,
  pass: 'all' | 'base' | 'surface' = 'all'
) {
  const points = sampleRoadCurve(element);
  const width = roadStrokeWidth(element);
  const stroke = (path: typeof points, color: string, strokeWidth: number) => {
    ctx.beginPath();
    path.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.strokeStyle = color;
    ctx.lineWidth = strokeWidth;
    ctx.stroke();
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (pass !== 'surface' && element.properties?.kerbs) {
    stroke(points, '#f4f1e9', width + 24);
    ctx.lineCap = 'butt';
    roadKerbDashes(points).forEach(dash => stroke(dash, '#df4349', width + 24));
    ctx.lineCap = 'round';
    stroke(points, '#eceef1', width + 4);
  }
  if (pass !== 'base') {
    stroke(
      points,
      selected ? '#596675' : element.properties?.bezier ? '#444953' : '#3a3a5e',
      width
    );
  }
  ctx.restore();
}

export function drawScenery(ctx: CanvasRenderingContext2D, item: SceneryItem) {
  ctx.save();
  ctx.translate(item.position.x, item.position.y);
  ctx.rotate(item.rotation);
  ctx.scale(item.scale, item.scale);
  for (const shape of sceneryShapes(item)) {
    ctx.fillStyle = shape.color;
    if (shape.kind === 'rect') ctx.fillRect(shape.x, shape.y, shape.width, shape.height);
    else if (shape.kind === 'line') {
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.beginPath();
      ctx.moveTo(shape.x, shape.y);
      ctx.lineTo(shape.endX, shape.endY);
      ctx.stroke();
    } else {
      ctx.beginPath();
      if (shape.kind === 'circle') ctx.arc(shape.x, shape.y, shape.radius, 0, Math.PI * 2);
      else ctx.ellipse(shape.x, shape.y, shape.radiusX, shape.radiusY, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (item.label) {
    ctx.fillStyle = '#edf2ef';
    ctx.font = item.type === 'label' ? '600 28px sans-serif' : '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(item.label, 0, item.type === 'label' ? 0 : 50);
  }
  ctx.restore();
}
