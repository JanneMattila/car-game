export function fitEditorViewport(
  width: number,
  height: number,
  viewport: { width: number; height: number }
) {
  if (
    ![width, height, viewport.width, viewport.height].every(
      value => Number.isFinite(value) && value > 0
    )
  ) {
    throw new RangeError('Editor fitting requires finite, positive world and viewport dimensions.');
  }
  const padding = Math.min(24, viewport.width / 4, viewport.height / 4);
  const zoom = Math.min(
    2,
    (viewport.width - padding * 2) / width,
    (viewport.height - padding * 2) / height
  );
  return {
    zoom,
    minimumZoom: Math.min(0.03, zoom / 2),
    pan: {
      x: (viewport.width - width * zoom) / 2,
      y: (viewport.height - height * zoom) / 2,
    },
  };
}
