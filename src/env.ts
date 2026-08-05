/*! jsbt - MIT License (c) 2019 Paul Miller (paulmillr.com) */
/**
 * Shared environment detection for jsbt tools: test, bench, bench-compare and the jsbt bin.
 * Decides when to use colors and when to prefer simple machine-friendly output
 * (e.g. CSV instead of tables) for non-interactive environments: LLM agents, pipes, CI logs.
 *
 * Everything is computed lazily: callers snapshot values at their own import time,
 * so re-imports (and browser-like environments without `process`) detect correctly.
 * @module
 */
export type Env = Record<string, string | undefined>;
/** CLI process, or undefined outside CLI (browsers). Lazy: bundlers can't see a hard dependency. */
export const cliProcess = (): Record<string, any> | undefined =>
  // @ts-ignore
  'process' in globalThis ? globalThis['process'] : undefined;
export const envFlag = (value: string | undefined): boolean => !!Number(value);
export function wantColor(env?: Env, tty?: boolean): boolean {
  const proc = cliProcess();
  const e = env ?? proc?.env ?? {};
  const t = tty ?? (!!proc?.stderr?.isTTY || !!proc?.stdout?.isTTY);
  if (e.CLICOLOR_FORCE && e.CLICOLOR_FORCE !== '0') return true;
  if (e.FORCE_COLOR && e.FORCE_COLOR !== '0') return true;
  // Explicit force flags must win so one-shot debug runs can override a global NO_COLOR shell.
  if (e.NO_COLOR) return false;
  if (e.FORCE_COLOR === '0') return false;
  if (e.CLICOLOR === '0') return false;
  return t;
}
export function colorEnabled(env?: Env): boolean {
  const proc = cliProcess();
  if (!proc) return false;
  return wantColor(env, !!proc.stderr?.isTTY || !!proc.stdout?.isTTY);
}
/** CSV over tables: JSBT_CSV=1, or a non-interactive terminal (LLM agents, pipes, CI logs). */
export function csvEnabled(env?: Env): boolean {
  const proc = cliProcess();
  if (!proc) return false;
  return envFlag((env ?? proc.env)?.JSBT_CSV) || !colorEnabled(env);
}
export const stripAnsi = (str: string): string => str.replace(/\x1b\[\d+(;\d+)*m/g, '');
/** Shared ANSI palette for all jsbt tools. */
const esc = String.fromCharCode(27); // \x1b — a shared prefix minifies better than escapes
export const color: Record<
  'blue' | 'bold' | 'dim' | 'gray' | 'green' | 'pink' | 'red' | 'reset' | 'violet' | 'yellow',
  string
> = {
  blue: esc + '[34m',
  bold: esc + '[1m',
  dim: esc + '[2m',
  gray: esc + '[90m',
  green: esc + '[32m',
  pink: esc + '[95m',
  red: esc + '[31m',
  reset: esc + '[0m',
  violet: esc + '[35m',
  yellow: esc + '[33m',
};
/** Colorize text for terminals; pass `on` from colorEnabled()/wantColor(). */
export const paint = (text: string, code: string, on: boolean = true): string =>
  on ? `${code}${text}${color.reset}` : text;
export const csvCell = (val: unknown): string => {
  const cell = stripAnsi(String(val ?? ''));
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
};
export const csvRow = (values: unknown[]): string => values.map(csvCell).join(',');
