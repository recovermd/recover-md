/**
 * Local rotating logger (FR-12).
 *
 * Rules: operational metadata only, never note content, never full search queries, never
 * network transmission, bounded retention. Paths are logged because diagnosing a watcher
 * problem without them is impossible — but their *contents* never are.
 */
import { createWriteStream, promises as fs, type WriteStream } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  directory: string;
  minLevel?: LogLevel;
  maxFileBytes?: number;
  maxFiles?: number;
  /** Also mirror to stdout/stderr; enabled in development. */
  console?: boolean;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly directory: string;
}

const LOG_FILENAME = 'recover-md.log';

class FileLogger implements Logger {
  private stream: WriteStream | null = null;
  private written = 0;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly minLevel: number;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly options: LoggerOptions) {
    this.maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 5;
    this.minLevel = LEVEL_ORDER[options.minLevel ?? 'info'];
  }

  get directory(): string {
    return this.options.directory;
  }

  private get filePath(): string {
    return path.join(this.options.directory, LOG_FILENAME);
  }

  private async ensureStream(): Promise<WriteStream> {
    if (this.stream) return this.stream;
    await fs.mkdir(this.options.directory, { recursive: true });
    const stat = await fs.stat(this.filePath).catch(() => null);
    this.written = stat?.size ?? 0;
    this.stream = createWriteStream(this.filePath, { flags: 'a' });
    return this.stream;
  }

  private async rotate(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (stream) await new Promise<void>((resolve) => stream.end(resolve));

    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const from = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      const to = `${this.filePath}.${index}`;
      await fs.rename(from, to).catch(() => undefined);
    }
    this.written = 0;
  }

  private enqueue(line: string): void {
    this.pending = this.pending
      .then(async () => {
        if (this.written >= this.maxFileBytes) await this.rotate();
        const stream = await this.ensureStream();
        await new Promise<void>((resolve, reject) => {
          stream.write(line, (error) => (error ? reject(error) : resolve()));
        });
        this.written += Buffer.byteLength(line);
      })
      .catch(() => undefined);
  }

  private write(level: LogLevel, scope: string | null, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const entry = {
      t: new Date().toISOString(),
      level,
      scope: scope ?? undefined,
      msg: message,
      ...(fields ?? {})
    };
    let line: string;
    try {
      line = `${JSON.stringify(entry)}\n`;
    } catch {
      line = `${JSON.stringify({ t: entry.t, level, scope, msg: message, fields: '[unserializable]' })}\n`;
    }
    if (this.options.console) {
      const target = level === 'error' || level === 'warn' ? console.error : console.warn;
      target(line.trimEnd());
    }
    this.enqueue(line);
  }

  private scoped(scope: string | null): Logger {
    return {
      directory: this.directory,
      debug: (message, fields) => this.write('debug', scope, message, fields),
      info: (message, fields) => this.write('info', scope, message, fields),
      warn: (message, fields) => this.write('warn', scope, message, fields),
      error: (message, fields) => this.write('error', scope, message, fields),
      child: (child) => this.scoped(scope ? `${scope}.${child}` : child),
      flush: () => this.flush(),
      close: () => this.close()
    };
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', null, message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', null, message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', null, message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', null, message, fields);
  }
  child(scope: string): Logger {
    return this.scoped(scope);
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  async close(): Promise<void> {
    await this.flush();
    const stream = this.stream;
    this.stream = null;
    if (stream) await new Promise<void>((resolve) => stream.end(resolve));
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new FileLogger(options);
}

/** No-op logger for unit tests and for code paths that must never fail on logging. */
export function createNullLogger(): Logger {
  const noop = (): void => undefined;
  const logger: Logger = {
    directory: '',
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    flush: async () => undefined,
    close: async () => undefined
  };
  return logger;
}
