interface RendererSession {
  initialize: () => Promise<void>;
  activate: () => void;
  destroy: () => void;
  onError: (error: unknown) => void;
}

// Async Pixi initialization can finish after React has already disposed its effect.
export function startRendererSession(session: RendererSession): () => void {
  let disposed = false;
  let initialized = false;

  const dispose = () => {
    disposed = true;
    if (initialized) {
      initialized = false;
      session.destroy();
    }
  };

  void (async () => {
    try {
      await session.initialize();
      initialized = true;
      if (disposed) {
        dispose();
      } else {
        session.activate();
      }
    } catch (error) {
      dispose();
      session.onError(error);
    }
  })();

  return dispose;
}
