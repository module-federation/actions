import * as core from '@actions/core';
import * as github from '@actions/github';
import readChangesets from '@changesets/read';
import { getPackages } from '@manypkg/get-packages';
import { read } from '@changesets/config';
import assembleReleasePlan from '@changesets/assemble-release-plan';
import { getPackageManager } from '@modern-js/utils';
import {
  execaWithStreamLog,
  gitCommitAll,
  gitCommitWithIgnore,
  gitConfigUser,
  gitPush,
  gitReset,
  gitSwitchToMaybeExistingBranch,
} from './utils';
import {
  getPreState,
  getReleaseNote,
  runBumpVersion,
} from './utils/changesets';
import { createPullRequest, writeGithubToken } from './utils/github';
import { updateLockFile } from './utils/release';
import { PublishTools } from './types';

const VERSION_REGEX = /^modern-(\d*)$/;

export const pullRequest = async () => {
  const githubToken = process.env.GITHUB_TOKEN;
  // 当前发布的版本类型，例如 alpha、latest
  let releaseType = core.getInput('version') || 'release';
  if (releaseType === 'latest' || VERSION_REGEX.test(releaseType)) {
    releaseType = 'release';
  }
  // 当前发布的版本，例如 v1.0.0
  let releaseVersion = core.getInput('versionNumber');
  // 当前发布源分支
  const releaseBranch = core.getInput('branch');
  const publishTools =
    (core.getInput('tools') as PublishTools); // changeset or modern
  console.info('[publishTools]:', publishTools);
  const coreNpmName = core.getInput('coreNpmName') ||'@module-federation/runtime';
  console.info('[coreNpmName]:', coreNpmName);

  // bump version 前执行的脚本
  // 如 Rspress 在 bump 自身版本前执行 npm run update:modern
  const beforeBumpScript = core.getInput('beforeBumpScript') || '';

  if (!releaseBranch) {
    throw Error('not found release branch');
  }

  const cwd = process.cwd();

  const changesets = await readChangesets(cwd);

  if (releaseType === 'canary' && releaseVersion === 'auto') {
    releaseVersion = `${new Date().toISOString().split('T')[0]}`;
  } else if (releaseVersion === 'auto') {
    const packages = await getPackages(cwd);
    const config = await read(cwd, packages);
    let preState;
    if (
      releaseType === 'pre' ||
      releaseType === 'beta' ||
      releaseType === 'alpha'
    ) {
      preState = await getPreState(releaseType, publishTools);
    }
    const releasePlan = assembleReleasePlan(
      changesets,
      packages,
      config,
      preState,
      releaseType === 'canary'
        ? {
            tag: 'canary',
          }
        : undefined,
    );
    if (releasePlan.releases.length === 0) {
      return;
    }
    const findCoreNameReleaseInfo = releasePlan.releases.find((release)=>{
      if (release.name === coreNpmName) {
        return true
      }
    });
    console.info('[findCoreNameReleaseInfo]:', findCoreNameReleaseInfo);
    if (findCoreNameReleaseInfo) {
      releaseVersion = `v${findCoreNameReleaseInfo.newVersion}`;
    } else {
      releaseVersion = `v${releasePlan.releases[0].newVersion}`;
    }
  }

  console.info('Release Version', releaseVersion);
  console.info('publishBranch', releaseBranch);

  if (!githubToken) {
    core.setFailed('Please add the GITHUB_TOKEN');
    return;
  }

  await gitConfigUser();
  await writeGithubToken(githubToken);

  const branch = github.context.ref.replace('refs/heads/', '');
  const versionBranch = releaseVersion
    ? `${releaseType}-${releaseVersion}`
    : `changeset-${releaseType}/${branch}`;
  const title = releaseVersion
    ? `Release ${releaseVersion}`
    : 'Version Packages';

  await gitSwitchToMaybeExistingBranch(versionBranch);
  await gitReset(github.context.sha);

  if (changesets.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No changesets found');
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }

  if (releaseType === 'canary' || releaseType === 'next') {
    console.info('git push');
    await gitPush(versionBranch, { force: true });
    return;
  }

  let releaseNote = '';

  if (beforeBumpScript) {
    const packageManager = await getPackageManager(cwd);
    await execaWithStreamLog(packageManager, ['run', beforeBumpScript], {
      cwd,
    });
  }

  // 获取 changesets
  await runBumpVersion(releaseType, publishTools);

  await updateLockFile();

  await gitCommitAll(title);

  await gitPush(versionBranch, { force: true });

  await createPullRequest({
    githubToken,
    title,
    body: releaseNote,
    branch: versionBranch,
  });
};
