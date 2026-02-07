import fs from 'fs';
import path from 'path';

const LOG_FILE = path.resolve('./data/debug.log');
const DEBUG_ENABLED = process.env['DEBUG'] === 'true';

class Logger {
  private enabled: boolean;
  private stream: fs.WriteStream | null = null;

  constructor() {
    this.enabled = DEBUG_ENABLED;
    
    if (this.enabled) {
      // Ensure data directory exists
      const dir = path.dirname(LOG_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Clear log file on startup
      fs.writeFileSync(LOG_FILE, `=== Server started at ${new Date().toISOString()} ===\n`);
      
      // Open stream for appending
      this.stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
      
      console.log(`Debug logging enabled. Log file: ${LOG_FILE}`);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  log(category: string, message: string, data?: unknown): void {
    if (!this.enabled) return;

    const timestamp = new Date().toISOString();
    const logLine = data 
      ? `[${timestamp}] [${category}] ${message} ${JSON.stringify(data)}\n`
      : `[${timestamp}] [${category}] ${message}\n`;
    
    this.stream?.write(logLine);
  }

  // For client to send logs
  logFromClient(clientId: string, category: string, message: string, data?: unknown): void {
    this.log(`CLIENT:${clientId}`, `[${category}] ${message}`, data);
  }

  close(): void {
    this.stream?.end();
  }
}

export const logger = new Logger();
