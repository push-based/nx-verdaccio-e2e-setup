import { type ExecutorContext, logger, readJsonFile } from '@nx/devkit';
import { join } from 'node:path';
import * as process from 'process';
import runBuildExecutor from '../bootstrap/executor';
import runKillProcessExecutor from '../kill-process/executor';
import { executeProcess } from '../../internal/utils/execute-process';
import { objectToCliArgs } from '../../internal/utils/terminal-command';
import { VerdaccioProcessResult } from '../../internal/verdaccio/verdaccio-registry';
import { SetupEnvironmentExecutorOptions } from './schema';

export type ExecutorOutput = {
  success: boolean;
  command?: string;
  error?: Error;
};

export default async function runSetupEnvironmentExecutor(
  terminalAndExecutorOptions: SetupEnvironmentExecutorOptions,
  context: ExecutorContext
) {
  const { projectName } = context;
  const normalizedOptions = {
    ...terminalAndExecutorOptions,
    environmentRoot: join('tmp', 'environments', projectName),
  };

  try {
    await runBuildExecutor(
      {
        ...normalizedOptions,
      },
      context
    );

    await executeProcess({
      command: 'nx',
      args: objectToCliArgs({
        _: ['install-deps', projectName],
        environmentProject: projectName,
        environmentRoot: normalizedOptions.environmentRoot,
      }),
      cwd: process.cwd(),
      verbose: true,
    });

    if (!normalizedOptions.keepServerOn) {
      await runKillProcessExecutor(
        {
          ...normalizedOptions,
          filePath: join(
            normalizedOptions.environmentRoot,
            'verdaccio-registry.json'
          ),
        },
        context
      );
    } else {
      const { url } = readJsonFile<VerdaccioProcessResult>(
        join(normalizedOptions.environmentRoot, 'verdaccio-registry.json')
      );
      logger.info(`Verdaccio server kept running under : ${url}`);
    }
  } catch (error) {
    // nx build-env cli-e2e
    logger.error(error);
    return {
      success: false,
      command: error,
    };
  }

  return Promise.resolve({
    success: true,
    command: 'Environment setup complete.',
  } satisfies ExecutorOutput);
}
