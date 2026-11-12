/**
 * Secret and path redaction for anything that leaves the process as text:
 * audit entries, HTTP error bodies, log lines.
 *
 * redactSecrets: masks things shaped like credentials (API keys, bearer
 * tokens, Google OAuth tokens and codes, Telegram bot tokens).
 * scrubErrorText: additionally removes stack traces and absolute file paths,
 * for messages sent to HTTP clients.
 */

const MASK = '[REDACTED]';

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,                              // OpenAI / Anthropic / DeepSeek / OpenRouter style
  /\bAIza[0-9A-Za-z_-]{30,}/g,                             // Google API key
  /\bya29\.[0-9A-Za-z_.-]{10,}/g,                          // Google access token
  /\b1\/\/[0-9A-Za-z_-]{20,}/g,                            // Google refresh token
  /\b4\/[0-9A-Za-z_-]{20,}/g,                              // Google OAuth code
  /\bGOCSPX-[0-9A-Za-z_-]{10,}/g,                          // Google client secret
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}/g,                        // Telegram bot token
  /\bxox[abprs]-[0-9A-Za-z-]{10,}/g,                       // Slack-style tokens
  /\bgh[pousr]_[0-9A-Za-z]{20,}/g,                         // GitHub tokens
  /(?<=[?&]code=)[^&\s"']{6,}/g,                           // OAuth code in a URL
  /(?<=\/bot)\d{6,12}:[A-Za-z0-9_-]{10,}/g,                // Telegram token inside an API URL
];

/** `Authorization: Bearer x`, `"refresh_token":"x"`, `client_secret=x` ... keep the label, mask the value. */
const LABELLED = /((?:authorization|bearer|api[_-]?key|x-api-key|x-goog-api-key|client[_-]?secret|refresh[_-]?token|access[_-]?token|id[_-]?token|password|passwd)["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+)?)([^\s"'&,;}]{6,})/gi;

export function redactSecrets(text: string): string {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, MASK);
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${MASK}`);
  out = out.replace(LABELLED, (_m, label: string) => `${label}${MASK}`);
  return out;
}

const SENSITIVE_KEY = /^(authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|id[_-]?token)$/i;

/** Deep copy of a JSON-ish value with secrets masked (by key name and by shape). Depth-capped. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[…]';
  if (value instanceof Error) return redactSecrets(String(value.message || value));
  if (Array.isArray(value)) return value.map(v => redactDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) && v !== undefined && v !== null && v !== '' ? MASK : redactDeep(v, depth + 1);
  }
  return out;
}

const WIN_PATH = /(?:[A-Za-z]:\\|\\\\)[^\s"'<>|:*?]+(?:\\[^\s"'<>|:*?]+)*/g;
const POSIX_PATH = /(?<![\w.:/-])\/(?:home|Users|root|var|etc|tmp|opt|usr|mnt|media|srv|app|workspace)\/[^\s"'<>:]+/g;
const STACK_LINE = /\s*\n\s+at .+/g;

/** Make an error message safe to send to an HTTP client: no stack, no file paths, no secrets. */
export function scrubErrorText(text: string, max = 500): string {
  let out = String(text ?? '').replace(STACK_LINE, '');
  out = out.replace(WIN_PATH, '[path]').replace(POSIX_PATH, '[path]');
  out = redactSecrets(out);
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}

/**
 * Express middleware: scrubs the `error` / `message` strings of every JSON
 * error response (status >= 400) on its way out, so a route that echoes
 * String(err) cannot leak a stack trace, a file path or a credential.
 */
export function createErrorScrubber() {
  return (_req: any, res: any, next: (err?: any) => void): void => {
    const original = res.json?.bind(res);
    if (typeof original !== 'function') return next();
    res.json = (body: any) => {
      try {
        if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
          const copy: Record<string, any> = { ...body };
          for (const k of ['error', 'message', 'details', 'detail']) {
            if (typeof copy[k] === 'string') copy[k] = scrubErrorText(copy[k]);
          }
          delete copy.stack;
          return original(copy);
        }
      } catch { /* fall through to the untouched body */ }
      return original(body);
    };
    next();
  };
}

/**
 * Final Express error handler. Body-parser and other client errors keep their
 * status with a fixed message; everything else is a generic 500. The real
 * error goes to the server log only.
 */
export function createErrorHandler(log: (message: string, err: unknown) => void) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: any, _req: any, res: any, _next: any): void => {
    const status = Number(err?.status ?? err?.statusCode);
    const client = Number.isInteger(status) && status >= 400 && status < 500;
    if (!client) log('Unhandled API error:', redactSecrets(String(err?.stack || err?.message || err)));
    if (res.headersSent) return;
    if (client) {
      const message =
        status === 413 ? 'That request is too large.'
        : err?.type === 'entity.parse.failed' ? 'The request body is not valid JSON.'
        : status === 415 ? 'Unsupported content type.'
        : 'Bad request.';
      res.status(status).json({ error: message });
      return;
    }
    res.status(500).json({ error: 'Something went wrong inside Fibb. Check the server log for details.' });
  };
}
