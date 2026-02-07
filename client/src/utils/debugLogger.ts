const API_URL = (import.meta as unknown as { env: Record<string, string> }).env.VITE_API_URL || 
  (typeof window !== 'undefined' && window.location.hostname !== 'localhost' ? '/api' : 'http://localhost:3000/api');

interface LogEntry {
  category: string;
  message: string;
  data?: unknown;
}

class DebugLogger {
  private enabled: boolean = false;
  private clientId: string;
  private queue: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized: boolean = false;

  constructor() {
    this.clientId = this.generateClientId();
  }

  private generateClientId(): string {
    const stored = sessionStorage.getItem('debugClientId');
    if (stored) return stored;
    const id = Math.random().toString(36).substring(2, 10);
    sessionStorage.setItem('debugClientId', id);
    return id;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      const response = await fetch(`${API_URL}/debug/status`);
      const data = await response.json();
      this.enabled = data.enabled === true;
      this.initialized = true;
      
      if (this.enabled) {
        console.log(`[DebugLogger] Enabled. ClientID: ${this.clientId}`);
        this.log('INIT', 'Debug logger initialized', { 
          userAgent: navigator.userAgent,
          screen: { width: window.innerWidth, height: window.innerHeight }
        });
      }
    } catch (err) {
      console.warn('[DebugLogger] Failed to check debug status:', err);
      this.enabled = false;
      this.initialized = true;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  log(category: string, message: string, data?: unknown): void {
    // Always console.log for immediate feedback
    if (data) {
      console.log(`[${category}] ${message}`, data);
    } else {
      console.log(`[${category}] ${message}`);
    }

    if (!this.enabled) return;

    this.queue.push({ category, message, data });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    
    // Batch logs and send every 500ms
    this.flushTimer = setTimeout(() => {
      this.flush();
    }, 500);
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    
    if (this.queue.length === 0) return;
    
    const logs = [...this.queue];
    this.queue = [];

    try {
      await fetch(`${API_URL}/debug/log/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: this.clientId, logs }),
      });
    } catch (err) {
      // Silently fail - don't spam console with logging errors
    }
  }

  // Force immediate flush (useful before page unload)
  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

export const debugLogger = new DebugLogger();

// Initialize on module load
debugLogger.initialize();

// Flush on page unload
window.addEventListener('beforeunload', () => {
  debugLogger.flushNow();
});

// Capture unhandled errors
window.addEventListener('error', (event) => {
  debugLogger.log('ERROR', 'Unhandled error', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error?.stack || event.error?.message || String(event.error),
  });
});

// Capture unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  debugLogger.log('ERROR', 'Unhandled promise rejection', {
    reason: event.reason?.stack || event.reason?.message || String(event.reason),
  });
});

// Capture console errors
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  originalConsoleError.apply(console, args);
  debugLogger.log('CONSOLE_ERROR', 'console.error called', {
    args: args.map(arg => {
      if (arg instanceof Error) {
        return { message: arg.message, stack: arg.stack };
      }
      try {
        return JSON.parse(JSON.stringify(arg));
      } catch {
        return String(arg);
      }
    }),
  });
};
