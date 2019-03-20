/**
 * Created by Ivo Meißner on 08.08.17.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import {
  ICluster,
  IEnvironmentConfig, IProjectChangeError,
} from '../../types';
import {
  loadProjectVersion,
} from '../../utils';
import {
  isDirectory,
} from '../../validation/options';
import validate from '../../validation/validate';
import {StatusCommand} from '../status/';

import _ from 'lodash';
import fetch from 'node-fetch';
import {PROJECT_ALIAS_REGEX} from '../../validation';

interface IDeployCommandOptions {
  force?: boolean;
  account?: string;
  alias?: string;
  name?: string;
}
interface IDeployCommandArguments {}

interface IChangeCounts {
  update: number;
  add: number;
  remove: number;
}

export class DeployCommand extends StatusCommand<IDeployCommandOptions, IDeployCommandArguments> {
  public static command = 'deploy';
  public static description = 'Deploy the current project state to the slicknode servers';
  public static options = [
    {
      name: '-d, --dir <path>',
      description: 'The target directory, if other than current',
      validator: isDirectory,
    },
    {
      name: '-e, --env <env>',
      description: 'The configured environment name',
    },
    {
      name: '-f, --force <force>',
      description: 'Forces the deployment without asking for confirmation',
    },
    {
      name: '-a, --account <account>',
      description: 'The identifier of the account where the project should be deployed',
    },
    {
      name: '-n, --name <name>',
      description: 'The name of the project as displayed in the console',
    },
    {
      name: '--alias <alias>',
      description: 'The alias of the project which is part of the endpoint URL',
    },
  ];

  public async run(): Promise<void> {
    // Check if directory is initialized
    const config = await this.getConfig();
    if (!config) {
      this.logger.error(chalk.red('Deployment failed:\n'));
      this.logger.log(
        '  The directory is not a slicknode project. \n' +
        `  Run ${chalk.bold('slicknode init')} to initialize a new project.`,
      );
      return;
    }
    const errors = await validate(this.getProjectRoot(), config);

    if (errors.length) {
      this.logger.error(chalk.red('Project configuration has errors: \n'));
      errors.forEach((error, index) => {
        this.logger.error(chalk.red(`  ${index + 1}. ${error.toString()}\n`));
      });
      return;
    }

    // Check for version updates
    if (await this.updateRequired()) {
      return;
    }

    // Ensure user is authenticate
    const authenticated = await this.authenticate();
    if (!authenticated) {
      return;
    }

    // Run migration
    const env = await this.getOrCreateEnvironment();
    const validStatus = await this.loadAndPrintStatus(env);

    // Check if we have valid status
    if (!validStatus) {
      return;
    }

    // Confirm changes
    if (!this.options.force) {
      const values = await inquirer.prompt([
        {
          name: 'confirm',
          type: 'confirm',
          message: 'Do you want to deploy the changes?',
          default: false,
        },
      ]) as {confirm: boolean};
      if (!values.confirm) {
        this.logger.log('Deployment aborted');
        return;
      }
    }

    const result = await this.migrateProject(false, await env);

    const serverErrors = _.get(result, 'data.migrateProject.errors', []).filter(
      (e: IProjectChangeError) => e,
    );
    if (serverErrors.length) {
      this.printErrors(serverErrors);
      return;
    }

    const project = _.get(result, 'data.migrateProject.node');
    if (!project || !project.version || !project.version.bundle) {
      this.logger.error(
        chalk.red('The version was not deployed. Try again later.'),
      );
      _.get(result, 'errors', []).forEach((error: {message: string}) => {
        this.logger.error(
          chalk.red(`Error: ${error.message}`),
        );
      });
      return;
    }

    // Load project files from server
    try {
      await loadProjectVersion(this.getProjectRoot(), project.version.bundle);
    } catch (e) {
      this.logger.error('Error loading project config from servers');
      return;
    }

    // Update environment

    // Create deployment summary
    const changes = _.get(result, 'data.migrateProject.changes', [])
      .reduce((changeCounts: IChangeCounts, change: {type: {toLowerCase: () => 'add' | 'update' | 'remove'}}) => {
        changeCounts[change.type.toLowerCase()] += 1;
        return changeCounts;
      }, {update: 0, add: 0, remove: 0});
    this.logger.log(
      'Changes deployed to the slicknode servers: \n' +
      `${changes.add} addition${changes.add === 1 ? 's' : ''}, ` +
      `${changes.update} update${changes.update === 1 ? 's' : ''}, ` +
      `${changes.remove} removal${changes.remove === 1 ? 's' : ''}`,
    );
    this.logger.log(chalk.green('Deployment successful!'));
  }

  public async getOrCreateEnvironment(): Promise<IEnvironmentConfig> {
    const name = this.options.env || 'default';
    const env = await this.getEnvironment(name);
    if (env) {
      return env;
    }

    // We don't have project for this env yet, create one...
    this.logger.log(`Creating project for env "${name}"`);
    const query = `mutation CreateProject($input: createProjectInput!) {
      createProject(input: $input) {
        node {
          id
          alias
          name
          endpoint
          consoleUrl
          playgroundUrl
          version {
            bundle
            id
          }
        }
      }
    }`;

    let suggestedName;
    let suggestedAlias;

    let newName;
    let newAlias;

    // We don't have new name, show prompt
    const defaultEnv = await this.getEnvironment('default');
    if (defaultEnv) {
      suggestedName = this.options.name || `${defaultEnv.name} (${name})`;
      suggestedAlias = this.options.alias || `${defaultEnv.alias}-${name}`;
    }
    if (this.options.force) {
      newName = suggestedName;
      newAlias = suggestedAlias;
    } else {
      const valuePrompts = [];

      if (!this.options.name) {
        valuePrompts.push({
          name: 'name',
          type: 'input',
          default: suggestedName,
          message: 'Project name (as displayed in console):',
          validate: (input: any) => {
            return input && String(input).length > 1;
          },
        });
      }
      if (!this.options.alias) {
        valuePrompts.push({
          name: 'alias',
          type: 'input',
          message: 'Project alias:',
          default: suggestedAlias,
          validate: (input: any) => {
            if (String(input).match(PROJECT_ALIAS_REGEX)) {
              return true;
            }
            return 'Project alias contains invalid characters';
          },
        });
      }
      const values = {
        name: suggestedName,
        alias: suggestedAlias,
        ...(await inquirer.prompt(valuePrompts) as {alias?: string, name?: string}),
      };

      newAlias = values.alias;
      newName = values.name;
    }

    // Determine data center
    // $FlowFixMe: @TODO
    const cluster = await this.getCluster();
    if (!cluster) {
      this.logger.error(chalk.red(
        'There is currently no cluster with sufficient capacity available. Try again later.',
      ));
      throw new Error('Error creating project');
    }

    const variables = {
      input: {
        name: newName,
        alias: newAlias,
        cluster: cluster.id,
        account: this.options.account || null,
      },
    };

    const result = await this.client.fetch(query, variables);
    const project = _.get(result, 'data.createProject.node');
    if (!project) {
      this.logger.error(chalk.red('ERROR: Could not create project. Please try again later.'));
      if (result.errors && result.errors.length) {
        result.errors.forEach(
          (err) => this.logger.error(
            chalk.red(err.message),
          ),
        );
      }
      throw new Error('Error creating project');
    }

    // Update environment
    const envConfig = {
      endpoint: project.endpoint,
      version: project.version.id,
      alias: project.alias,
      consoleUrl: project.consoleUrl,
      playgroundUrl: project.playgroundUrl,
      name: project.name,
      id: project.id,
    };
    await this.updateEnvironment(name, envConfig);
    return envConfig;
  }

  /**
   * Returns the closest data center
   * @returns {Promise.<void>}
   */
  public async getCluster(): Promise<ICluster | null> {
    const query = `query {
      listCluster(first: 100) {
        edges {
          node {
            id
            alias
            name
            pingUrl
          }
        }
      }
    }`;
    const result = await this.client.fetch(query);
    const edges = _.get(result, 'data.listCluster.edges', []) as Array<{node: ICluster}>;
    this.logger.log('Load available clusters');
    if (_.get(result, 'errors[0]')) {
      this.logger.error(chalk.red(`Error loading clusters: ${_.get(result, 'errors[0].message')}`));
      return null;
    }

    const dcTimers = edges.map(async ({node}) => {
      const start = Date.now();
      let latency;
      try {
        await fetch(node.pingUrl);
        latency = Date.now() - start;
      } catch (e) {
        latency = null;
      }
      return {
        latency,
        cluster: node,
      };
    });

    try {
      const timedDcs = await Promise.all(dcTimers) as Array<{cluster: ICluster, latency: number}>;
      const availableDcs = timedDcs
        .filter((d) => d.latency !== null)
        .sort((a, b) => a.latency < b.latency ? 1 : 0);

      if (availableDcs.length) {
        return availableDcs[0].cluster;
      }
    } catch (e) {
      return null;
    }

    return null;
  }
}