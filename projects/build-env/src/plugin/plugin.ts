import {
  type CreateNodes,
  logger,
  type ProjectConfiguration,
  readJsonFile,
  type TargetConfiguration,
} from '@nx/devkit';
import { dirname, join } from 'node:path';
import {
  DEFAULT_ENVIRONMENTS_OUTPUT_DIR,
  DEFAULT_OPTION_ENVIRONMENT_TARGET_NAMES,
  DEFAULT_NPM_INSTALL_TARGET,
  DEFAULT_NPM_PUBLISH_TARGET,
  DEFAULT_START_VERDACCIO_TARGET,
  DEFAULT_STOP_VERDACCIO_TARGET,
  DEFAULT_BOOTSTRAP_TARGET,
  DEFAULT_INSTALL_TARGET,
  DEFAULT_SETUP_TARGET,
} from '../internal/constants';
import type { StarVerdaccioOptions } from '../executors/bootstrap/verdaccio-registry';
import { VERDACCIO_REGISTRY_JSON } from '../executors/bootstrap/constants';

export function isPublishable(
  projectConfig: ProjectConfiguration,
  options: NormalizedCreateNodeOptions['publishable']
): boolean {
  const { projectType, tags: existingTags = [] } = projectConfig;
  const { filterByTags: publishableTagFilters } = options;
  if (projectType !== 'library') {
    return false;
  }
  // if tags are configured check for at least one given tags
  if (existingTags && publishableTagFilters) {
    return existingTags.some((existingTag) =>
      publishableTagFilters.includes(existingTag)
    );
  }

  return true;
}

export function isNpmEnv(
  projectConfig: ProjectConfiguration,
  options: NormalizedCreateNodeOptions['environments']
): boolean {
  const { tags: existingTags = [], targets } = projectConfig;
  const existingTargetNames = Object.keys(targets ?? {});
  const {
    filterByTags: environmentsTagFilters,
    targetNames: environmentTargetNames,
    environmentsDir,
  } = options;

  if (!existingTargetNames || !environmentTargetNames) {
    return false;
  }

  if (
    existingTargetNames.some((existingTarget) =>
      environmentTargetNames.includes(existingTarget)
    )
  ) {
    if (existingTags && environmentsTagFilters) {
      return existingTags.some((existingTag) =>
        environmentsTagFilters.includes(existingTag)
      );
    }
    return true;
  }

  return false;
}

export function normalizeOptions(
  options: BuildEnvPluginCreateNodeOptions
): NormalizedCreateNodeOptions {
  const {
    environments: givenEnvironments = {},
    publishable: givenPublishable = {},
  } = options ?? {};

  if (
    !('targetNames' in givenEnvironments) ||
    givenEnvironments.targetNames.length === 0
  ) {
    throw new Error(
      'Option targetNames is required in plugin options under "environments". e.g.: ["e2e"] '
    );
  }

  return <NormalizedCreateNodeOptions>{
    environments: {
      environmentsDir: DEFAULT_ENVIRONMENTS_OUTPUT_DIR,
      targetNames: [DEFAULT_OPTION_ENVIRONMENT_TARGET_NAMES],
      ...givenEnvironments,
    },
    publishable: {
      ...givenPublishable,
    },
  };
}

export type BuildEnvEnvironmentsOptions = {
  environmentsDir?: string;
  targetNames?: string[];
  filterByTags?: string[];
};
export type BuildEnvPublishingOptions = {
  environmentsDir?: string;
  targetNames?: string[];
  filterByTags?: string[];
};
export type BuildEnvPluginCreateNodeOptions = {
  environments?: BuildEnvEnvironmentsOptions;
  publishable?: BuildEnvPublishingOptions;
};
type NormalizedCreateNodeOptions = {
  environments: Omit<
    BuildEnvEnvironmentsOptions,
    'targetNames' | 'environmentsDir'
  > &
    Required<
      Pick<BuildEnvEnvironmentsOptions, 'targetNames' | 'environmentsDir'>
    >;
  publishable: BuildEnvPublishingOptions;
};

export const createNodes: CreateNodes = [
  '**/project.json',
  (projectConfigurationFile: string, opt: BuildEnvPluginCreateNodeOptions) => {
    const { environments, publishable } = normalizeOptions(opt);

    const projectConfiguration: ProjectConfiguration = readJsonFile(
      join(process.cwd(), projectConfigurationFile)
    );

    if (
      !('name' in projectConfiguration) ||
      typeof projectConfiguration.name !== 'string'
    ) {
      throw new Error('Project name is required');
    }
    const projectName = projectConfiguration.name;
    const tags = projectConfiguration?.tags ?? [];

    const projectRoot = dirname(projectConfigurationFile);
    const { environmentsDir } = environments;
    const environmentRoot = join(environmentsDir, projectName);
    return {
      projects: {
        [projectRoot]: {
          targets: {
            // start-verdaccio, stop-verdaccio
            ...(isNpmEnv(projectConfiguration, environments) &&
              verdaccioTargets({ environmentRoot })),
            // bootstrap-env, setup-env, install-env (intermediate target to run dependency targets+)
            ...(isNpmEnv(projectConfiguration, environments) &&
              getEnvTargets({ environmentRoot, projectName })),
            // adjust targets to run setup-env
            ...(isNpmEnv(projectConfiguration, environments) &&
              updateTargetsWithEnvSetup(projectConfiguration, environments)),
            // === dependency project
            // npm-publish, npm-install
            ...(isPublishable(projectConfiguration, publishable) &&
              getNpmTargets(projectName)),
          },
        },
      },
    };
  },
];

function verdaccioTargets({
  environmentRoot,
  ...options
}: StarVerdaccioOptions & {
  environmentRoot: string;
}): Record<string, TargetConfiguration> {
  return {
    // @TODO: consider using the executor function directly to reduce the number of targets
    [DEFAULT_START_VERDACCIO_TARGET]: {
      executor: '@nx/js:verdaccio',
      options: {
        config: '.verdaccio/config.yml',
        storage: join(environmentRoot, 'storage'),
        clear: true,
        ...options,
      },
    },
    [DEFAULT_STOP_VERDACCIO_TARGET]: {
      executor: '@push-based/build-env:kill-process',
      options: {
        filePath: join(environmentRoot, VERDACCIO_REGISTRY_JSON),
        ...options,
      },
    },
  };
}

function getEnvTargets({
  environmentRoot,
  projectName,
}: { environmentRoot: string } & {
  projectName: string;
}): Record<string, TargetConfiguration> {
  return {
    [DEFAULT_BOOTSTRAP_TARGET]: {
      executor: '@push-based/build-env:bootstrap',
    },
    // just here to execute dependent npm-install tasks with the correct environmentProject
    [DEFAULT_INSTALL_TARGET]: {
      dependsOn: [
        {
          projects: 'dependencies',
          target: DEFAULT_NPM_INSTALL_TARGET,
          params: 'forward',
        },
      ],
      options: { environmentProject: projectName },
      command: 'echo Dependencies installed!',
    },
    // runs bootstrap-env, install-env and stop-verdaccio
    [DEFAULT_SETUP_TARGET]: {
      outputs: ['{options.environmentRoot}'],
      executor: '@push-based/build-env:setup',
      options: { environmentRoot },
    },
  };
}

function updateTargetsWithEnvSetup(
  projectConfig: ProjectConfiguration,
  options: Required<Pick<BuildEnvEnvironmentsOptions, 'targetNames'>>
): Record<string, TargetConfiguration> {
  const { targetNames: envTargetNames } = options;
  const { targets: existingTargets = {} as TargetConfiguration } =
    projectConfig;

  return Object.fromEntries(
    Object.entries(existingTargets).map(([existingTargetName, config]) => {
      if (!envTargetNames.includes(existingTargetName)) {
        return [existingTargetName, config];
      }
      return [
        existingTargetName,
        {
          ...config,
          dependsOn: [
            {
              projects: 'self',
              target: DEFAULT_SETUP_TARGET,
              params: 'forward',
            },
            ...(config.dependsOn ?? []),
          ],
        },
      ];
    })
  );
}

function getNpmTargets(
  environmentProject: string
): Record<string, TargetConfiguration> {
  return {
    [DEFAULT_NPM_PUBLISH_TARGET]: {
      dependsOn: [
        { projects: 'self', target: 'build', params: 'forward' },
        {
          projects: 'dependencies',
          target: DEFAULT_NPM_PUBLISH_TARGET,
          params: 'forward',
        },
      ],
      executor: '@push-based/build-env:npm-publish',
      options: { environmentProject },
    },
    [DEFAULT_NPM_INSTALL_TARGET]: {
      dependsOn: [
        {
          projects: 'self',
          target: DEFAULT_NPM_PUBLISH_TARGET,
          params: 'forward',
        },
        {
          projects: 'dependencies',
          target: DEFAULT_NPM_INSTALL_TARGET,
          params: 'forward',
        },
      ],
      executor: '@push-based/build-env:npm-install',
      options: { environmentProject },
    },
  };
}
