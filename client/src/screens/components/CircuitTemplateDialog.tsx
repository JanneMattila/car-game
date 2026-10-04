import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  CIRCUIT_TEMPLATES,
  Track,
  circuitRoadWidthRange,
  createCircuitTrack,
  getCircuitPreview,
} from '@shared';

interface CircuitTemplateDialogProps {
  onCreate: (track: Track) => void;
  onClose: () => void;
}

export default function CircuitTemplateDialog({ onCreate, onClose }: CircuitTemplateDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selectedId, setSelectedId] = useState(CIRCUIT_TEMPLATES[0]!.id);
  const [name, setName] = useState(`${CIRCUIT_TEMPLATES[0]!.name} Copy`);
  const [width, setWidth] = useState(CIRCUIT_TEMPLATES[0]!.roadWidth);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const selected = CIRCUIT_TEMPLATES.find(t => t.id === selectedId)!;
  const { minimum, maximum } = circuitRoadWidthRange(selected.category);
  const validWidth = Number.isFinite(width) && width >= minimum && width <= maximum;
  const previews = useMemo(
    () =>
      CIRCUIT_TEMPLATES.map(template => {
        const path = getCircuitPreview(template.id)
          .map(curve => {
            return `M${curve.start.x},${curve.start.y} C${curve.control1.x},${curve.control1.y} ${curve.control2.x},${curve.control2.y} ${curve.end.x},${curve.end.y}`;
          })
          .join(' ');
        return { ...template, path };
      }),
    []
  );
  const filteredPreviews = previews.filter(
    template =>
      (category === 'all' || template.category === category) &&
      `${template.name} ${template.description}`.toLowerCase().includes(query.trim().toLowerCase())
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const handleCreate = (event: FormEvent) => {
    event.preventDefault();
    const template = createCircuitTrack(selectedId, width);
    const now = Date.now();
    onCreate({
      ...template,
      id: `track-${crypto.randomUUID()}`,
      name: name.trim(),
      author: 'Unknown',
      createdAt: now,
      updatedAt: now,
    });
  };

  return (
    <dialog
      ref={dialogRef}
      className="dialog circuit-template-dialog"
      aria-labelledby="circuit-template-title"
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={event => event.stopPropagation()}
    >
      <div className="dialog-header">
        <h2 id="circuit-template-title">Circuit templates</h2>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onClose}
          aria-label="Close circuit templates"
        >
          ×
        </button>
      </div>
      <form className="dialog-content" onSubmit={handleCreate}>
        <p className="template-help">
          Choose an original arcade interpretation. Create an editable copy with a full grid,
          ordered checkpoints, scenery and barriers. Your saved originals stay unchanged.
        </p>
        <div className="template-options">
          <label>
            Search circuits
            <input
              className="input"
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') event.preventDefault();
              }}
              placeholder="Name or corner"
            />
          </label>
          <label>
            Category
            <select
              className="input"
              aria-label="Category"
              value={category}
              onChange={event => setCategory(event.target.value)}
            >
              <option value="all">All circuits</option>
              <option value="Formula 1">Formula 1</option>
              <option value="NASCAR">NASCAR</option>
              <option value="Urban">Urban</option>
            </select>
          </label>
        </div>
        <p role="status">
          {filteredPreviews.length} of {previews.length} circuits
        </p>
        <div className="circuit-template-grid">
          {filteredPreviews.map(template => (
            <button
              key={template.id}
              type="button"
              className={`circuit-template-card ${selectedId === template.id ? 'selected' : ''}`}
              aria-pressed={selectedId === template.id}
              onClick={() => {
                setSelectedId(template.id);
                setName(`${template.name} Copy`);
                setWidth(template.roadWidth);
              }}
            >
              <svg
                className="template-preview"
                viewBox={`0 0 ${template.width} ${template.height}`}
                role="img"
                aria-label={`${template.name} layout`}
              >
                <path
                  d={template.path}
                  fill="none"
                  stroke="#d0d5da"
                  strokeWidth={template.roadWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <strong>{template.name}</strong>
              <span className="template-category">{template.category}</span>
              <span>{template.description}</span>
            </button>
          ))}
        </div>
        {filteredPreviews.length === 0 && (
          <p>No matching circuits. Clear the search or change category.</p>
        )}
        <h3>Selected: {selected.name}</h3>
        <div className="template-options">
          <label>
            Track name
            <input
              className="input"
              value={name}
              required
              maxLength={100}
              onChange={event => setName(event.target.value)}
            />
          </label>
          <label>
            Road width
            <input
              className="input"
              type="number"
              min={minimum}
              max={maximum}
              step={10}
              value={width}
              required
              onChange={event => setWidth(Number(event.target.value))}
            />
          </label>
        </div>
        {!validWidth && (
          <p role="alert">
            Road width must be between {minimum} and {maximum}.
          </p>
        )}
        <p className="template-help">
          Width changes rebuild the roads, barriers and race markers together. Creating a copy
          replaces the canvas; Undo restores your previous design. NASCAR layouts use flat arcade
          physics, not simulated banking.
        </p>
        <div className="button-row">
          <button type="submit" className="btn btn-primary" disabled={!validWidth || !name.trim()}>
            Create editable copy
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
