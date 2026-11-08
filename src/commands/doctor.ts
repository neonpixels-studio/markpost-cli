import chalk from 'chalk';
import { CheckResult, runDoctorChecks } from '#src/libs/doctor.js';
import { failWithUsage } from '#src/libs/usage.js';

export const USAGE = `Usage: markpost doctor

  Check the stored API token, BASE_URL, API reachability and the output
  directory, printing one pass/fail line per check. Exits non-zero if any
  check fails. Makes no changes and never prints the token.`;

const formatResult = (result: CheckResult): string => {
  const label = result.ok ? chalk.greenBright('PASS') : chalk.redBright('FAIL');

  return `${label} ${result.name}: ${result.detail}`;
};

export const runDoctorCommand = async (args: string[]): Promise<void> => {
  if (args.length > 0) {
    failWithUsage(`Unexpected argument: ${args[0]}`, USAGE);
    return;
  }

  const results = await runDoctorChecks();

  for (const result of results) {
    console.log(formatResult(result));
  }

  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
};
