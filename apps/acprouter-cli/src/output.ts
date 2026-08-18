/** Every command supports `--json`, per spec §5.4b — prints one way or the other, never both. */
export function printResult<T>(
  result: T,
  options: { json?: boolean },
  humanLines: (r: T) => string[],
): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const line of humanLines(result)) console.log(line);
}

export function printError(message: string, options: { json?: boolean }): void {
  if (options.json) {
    console.error(JSON.stringify({ error: message }, null, 2));
    return;
  }
  console.error(message);
}
