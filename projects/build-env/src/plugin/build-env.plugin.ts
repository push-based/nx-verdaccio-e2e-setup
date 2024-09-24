import {
  type CreateNodes,
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
import type { StartVerdaccioOptions } from '../executors/bootstrap/verdaccio-registry';
import { VERDACCIO_REGISTRY_JSON } from '../executors/bootstrap/constants';
import { uniquePort } from '../executors/bootstrap/unique-port';

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

export function normalizeCreateNodesOptions(
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
    const { environments, publishable } = normalizeCreateNodesOptions(opt);

    const projectConfiguration: ProjectConfiguration = readJsonFile(
      join(process.cwd(), projectConfigurationFile)
    );

    if (
      !('name' in projectConfiguration) ||
      typeof projectConfiguration.name !== 'string'
    ) {
      throw new Error('Project name is required');
    }
    const projectRoot = dirname(projectConfigurationFile);

    if (
      !isNpmEnv(projectConfiguration, environments) &&
      !isPublishable(projectConfiguration, publishable)
    ) {
      return {};
    }

    return {
      projects: {
        [projectRoot]: {
          targets: {
            // start-verdaccio, stop-verdaccio
            ...(isNpmEnv(projectConfiguration, environments) &&
              verdaccioTargets(projectConfiguration, {
                environmentsDir: environments.environmentsDir,
              })),
            // bootstrap-env, setup-env, install-env (intermediate target to run dependency targets+)
            ...(isNpmEnv(projectConfiguration, environments) &&
              getEnvTargets(projectConfiguration, environments)),
            // adjust targets to run setup-env
            ...(isNpmEnv(projectConfiguration, environments) &&
              updateTargetsWithEnvSetup(projectConfiguration, environments)),
            // === dependency project
            // npm-publish, npm-install
            ...(isPublishable(projectConfiguration, publishable) &&
              getNpmTargets()),
          },
        },
      },
    };
  },
];

function verdaccioTargets(
  projectConfig: ProjectConfiguration,
  options: Pick<
    NormalizedCreateNodeOptions['environments'],
    'environmentsDir'
  > &
    Omit<StartVerdaccioOptions, 'projectName'>
): Record<string, TargetConfiguration> {
  const { name: envProject } = projectConfig;
  const { environmentsDir, ...verdaccioOptions } = options;
  const environmentDir = join(environmentsDir, envProject);

  return {
    [DEFAULT_START_VERDACCIO_TARGET]: {
      // @TODO: consider using the executor function directly to reduce the number of targets
      executor: '@nx/js:verdaccio',
      options: {
        config: '.verdaccio/config.yml',
        port: uniquePort(),
        storage: join(environmentDir, 'storage'),
        clear: true,
        environmentDir,
        projectName: envProject,
        ...verdaccioOptions,
      },
    },
    [DEFAULT_STOP_VERDACCIO_TARGET]: {
      executor: '@push-based/build-env:kill-process',
      options: {
        filePath: join(environmentsDir, VERDACCIO_REGISTRY_JSON),
        ...verdaccioOptions,
      },
    },
  };
}

function getEnvTargets(
  projectConfig: ProjectConfiguration,
  options: NormalizedCreateNodeOptions['environments']
): Record<string, TargetConfiguration> {
  const { name: envProject } = projectConfig;
  const { environmentsDir } = options;
  const environmentRoot = join(environmentsDir, envProject);
  return {
    [DEFAULT_BOOTSTRAP_TARGET]: {
      executor: '@push-based/build-env:bootstrap',
      options: { environmentRoot },
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
      options: { environmentRoot },
    },
    // runs bootstrap-env, install-env and stop-verdaccio
    [DEFAULT_SETUP_TARGET]: {
      outputs: ['{options.environmentRoot}'],
      executor: '@push-based/build-env:setup',
      options: {
        environmentRoot,
      },
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

function getNpmTargets(): Record<string, TargetConfiguration> {
  return {
    [DEFAULT_NPM_PUBLISH_TARGET]: {
      dependsOn: [
        { target: 'build', params: 'forward' },
        {
          projects: 'dependencies',
          target: DEFAULT_NPM_PUBLISH_TARGET,
          params: 'forward',
        },
      ],
      executor: '@push-based/build-env:npm-publish',
    },
    [DEFAULT_NPM_INSTALL_TARGET]: {
      dependsOn: [
        {
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
    },
  };
}
