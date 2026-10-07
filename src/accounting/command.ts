import { ACCOUNTING_HELP, parseAccountingArgs } from "./args.js";
import { collectAccounting } from "./scan.js";

export async function accountingCommand(
  args: string[],
  stdout: { write: (chunk: string) => unknown } = process.stdout,
): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    stdout.write(ACCOUNTING_HELP);
    return;
  }
  let options;
  try {
    options = parseAccountingArgs(args);
  } catch (error) {
    // The argument parser's errors are fixed strings, never echoed values/paths.
    stdout.write(
      JSON.stringify({
        error: "invalid_accounting_arguments",
        message: (error as Error).message,
      }) + "\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    stdout.write(JSON.stringify(await collectAccounting(options)) + "\n");
  } catch {
    stdout.write(JSON.stringify({ error: "accounting_failed" }) + "\n");
    process.exitCode = 1;
  }
}
