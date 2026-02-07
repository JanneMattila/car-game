import fs from 'fs/promises';
import path from 'path';

export class StorageService {
  private dataDir: string;
  private locks: Map<string, Promise<void>> = new Map();

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
  }

  async initialize(): Promise<void> {
    // Create directory structure
    const dirs = [
      this.dataDir,
      path.join(this.dataDir, 'tracks'),
      path.join(this.dataDir, 'leaderboards'),
      path.join(this.dataDir, 'replays'),
    ];

    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }

    console.log(`Storage initialized at ${this.dataDir}`);
  }

  private getFilePath(collection: string, id: string): string {
    return path.join(this.dataDir, collection, `${id}.json`);
  }

  private async acquireLock(key: string): Promise<void> {
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }
    let releaseLock: () => void;
    const lockPromise = new Promise<void>(resolve => {
      releaseLock = resolve;
    });
    this.locks.set(key, lockPromise);
    return new Promise(resolve => {
      (resolve as (value: void) => void)();
      // Store release function for later
      (lockPromise as unknown as { release: () => void }).release = releaseLock!;
    });
  }

  private releaseLock(key: string): void {
    const lock = this.locks.get(key);
    if (lock) {
      this.locks.delete(key);
      ((lock as unknown as { release?: () => void }).release)?.();
    }
  }

  async read<T>(collection: string, id: string): Promise<T | null> {
    const filePath = this.getFilePath(collection, id);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async write<T>(collection: string, id: string, data: T): Promise<void> {
    const filePath = this.getFilePath(collection, id);
    const lockKey = `${collection}:${id}`;

    await this.acquireLock(lockKey);
    try {
      // Write to temp file first, then rename (atomic)
      const tempPath = `${filePath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tempPath, filePath);
    } finally {
      this.releaseLock(lockKey);
    }
  }

  async delete(collection: string, id: string): Promise<boolean> {
    const filePath = this.getFilePath(collection, id);
    try {
      await fs.unlink(filePath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }

  async list(collection: string): Promise<string[]> {
    const dirPath = path.join(this.dataDir, collection);
    try {
      const files = await fs.readdir(dirPath);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async exists(collection: string, id: string): Promise<boolean> {
    const filePath = this.getFilePath(collection, id);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readAll<T>(collection: string): Promise<T[]> {
    const ids = await this.list(collection);
    const items: T[] = [];

    for (const id of ids) {
      const item = await this.read<T>(collection, id);
      if (item) {
        items.push(item);
      }
    }

    return items;
  }
}
